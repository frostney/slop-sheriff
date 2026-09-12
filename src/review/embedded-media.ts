import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

interface ImageContainer {
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly metadata: readonly { type: string; base64: string }[];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Preserve every non-pixel chunk, including EXIF/text/profile data. Recognizing
// an image container is not proof of safe content or of a correct rendering.
function imageContainer(bytes: Buffer): ImageContainer | undefined {
  const metadata: { type: string; base64: string }[] = [];
  const retain = (type: string, data: Buffer) => metadata.push({ type, base64: data.toString("base64") });
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let rowBytes = 0;
    const data: Buffer[] = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      const chunk = bytes.subarray(offset + 8, end - 4);
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return;
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) return;
        width = chunk.readUInt32BE(0);
        height = chunk.readUInt32BE(4);
        const depth = chunk[8]!;
        const color = chunk[9]!;
        const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
        const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
        if (!width || !height || !channels || !depths.includes(depth) || chunk[10] || chunk[11] || chunk[12]) return;
        rowBytes = Math.ceil(width * channels * depth / 8) + 1;
        retain(type, chunk);
      } else if (type === "IDAT") data.push(chunk);
      else if (type === "IEND") {
        if (length !== 0 || end !== bytes.length || !data.length) return;
        const expected = rowBytes * height;
        // An oversized/unsupported decoder input stays completely visible.
        if (!Number.isSafeInteger(expected) || expected > 64 * 1024 * 1024) return;
        try {
          const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
          if (pixels.length !== expected) return;
          for (let row = 0; row < height; row++) if (pixels[row * rowBytes]! > 4) return;
        } catch { return; }
        return { mime: "image/png", width, height, metadata };
      } else {
        if (type === "IHDR") return;
        retain(type, chunk);
      }
      offset = end;
    }
    return;
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) return;
    let width = 0;
    let height = 0;
    let pixels = 0;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) return;
      const type = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length;
      if (end + (length % 2) > bytes.length) return;
      const chunk = bytes.subarray(offset + 8, end);
      if (type === "VP8 ") {
        if (length < 10 || (chunk[0]! & 1) || !chunk.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a]))) return;
        width = chunk.readUInt16LE(6) & 0x3fff;
        height = chunk.readUInt16LE(8) & 0x3fff;
        if ((chunk.readUIntLE(0, 3) >>> 5) + 10 > length) return;
        pixels++;
      } else if (type === "VP8L") {
        if (length < 5 || chunk[0] !== 0x2f || (chunk[4]! >>> 5)) return;
        const bits = chunk.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        pixels++;
      } else {
        // Animation frames are not projected until their nested containers can
        // be checked; unknown chunks remain verbatim in the metadata receipt.
        if (type === "ANIM" || type === "ANMF") return;
        retain(type, chunk);
      }
      offset = end + (length % 2);
    }
    return width && height && pixels === 1 ? { mime: "image/webp", width, height, metadata } : undefined;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let width = 0;
    let height = 0;
    let scans = 0;
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) return offset === bytes.length && width && height && scans ? { mime: "image/jpeg", width, height, metadata } : undefined;
      if (marker === undefined || marker === 0 || marker === 0xd8 || offset + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      const chunk = bytes.subarray(offset + 2, offset + length);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (chunk.length < 6 || chunk.length !== 6 + 3 * chunk[5]!) return;
        height = chunk.readUInt16BE(1);
        width = chunk.readUInt16BE(3);
      }
      // Tables and headers remain visible too; only entropy-coded scan bytes
      // are represented by the full binary hash instead of encoded text.
      retain(`JPEG-${marker.toString(16)}`, chunk);
      offset += length;
      if (marker === 0xda) {
        scans++;
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue; }
          const next = bytes[offset + 1];
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
          break;
        }
      }
    }
  }
  return;
}

/** A display projection only. The original artifact must be hashed first. */
export function projectEmbeddedMediaPatch(raw: string, source: { readonly path: string; readonly rawPatchPath: string }): string {
  let baseLine = 0;
  let headLine = 0;
  let count = 0;
  const view = raw.split("\n").map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { baseLine = Number(hunk[1]); headLine = Number(hunk[2]); return line; }
    if (!baseLine && !headLine) return line;
    const kind = line[0];
    if (kind !== "+" && kind !== "-" && kind !== " ") return line;
    const location = kind === "-" ? `base:${baseLine}` : kind === "+" ? `head:${headLine}` : `base:${baseLine},head:${headLine}`;
    const projected = line.replace(/"(?:[^"\\\r\n]|\\.)*"/g, (literal) => {
      let value: string;
      try { value = JSON.parse(literal) as string; } catch { return literal; }
      const url = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(value);
      const encoded = url?.[2] ?? value;
      if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return literal;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) return literal;
      const image = imageContainer(bytes);
      if (!image || (url && url[1] !== image.mime)) return literal;
      const receipt = JSON.stringify({ embeddedImage: image.mime, bytes: bytes.length, width: image.width, height: image.height, sha256: createHash("sha256").update(bytes).digest("hex"), source: `${source.path}:${location}`, metadata: image.metadata });
      const replacement = JSON.stringify(`[image projection; inspect original pixels; ${receipt}]`);
      if (replacement.length >= literal.length) return literal;
      count++;
      return replacement;
    });
    if (kind !== "+") baseLine++;
    if (kind !== "-") headLine++;
    return projected;
  }).join("\n");
  if (!count) return raw;
  const projected = `Embedded media review view: ${count} image string occurrences projected. Raw patch: ${JSON.stringify(source.rawPatchPath)}. Raw patch hash remains authoritative. Hunk line numbers and all other text are unchanged. Metadata bytes are retained as base64; inspect original images in the exact checkout or browser for visual/content behavior. Container recognition does not establish rendering correctness or safety.\n${view}`;
  // Manifest character counts continue to bound all resumable view offsets.
  return projected.length < raw.length ? projected : raw;
}
