import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { projectEmbeddedMediaPatch } from "../src/review/embedded-media";
import { readNextReviewEvidencePacket, readReviewEvidencePatch, reviewEvidenceManifestSchema, writeIncludedReviewEvidence } from "../src/review/evidence-bundle";

const assets = JSON.parse(readFileSync(new URL("../src/landing/assets.json", import.meta.url), "utf8")) as Record<string, string>;
const png = assets["slop-sheriff-icon.png"]!;
const source = { path: "src/arbitrary-config.json", rawPatchPath: "/tmp/evidence/original.diff" };
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function patch(lines: readonly string[]) {
  return `diff --git a/${source.path} b/${source.path}\n--- a/${source.path}\n+++ b/${source.path}\n@@ -17,3 +21,4 @@ settings\n${lines.join("\n")}\n`;
}

describe("embedded image evidence projection", () => {
  test("projects real PNG, JPEG and WebP pixels and retains names, MIME, dimensions, hashes and metadata", () => {
    for (const [name, encoded] of Object.entries(assets)) {
      const raw = patch([`+  ${JSON.stringify(name)}: ${JSON.stringify(encoded)},`]);
      const result = projectEmbeddedMediaPatch(raw, source);
      expect(result).not.toBe(raw);
      expect(result).toContain(name);
      expect(result).toContain(sha256(Buffer.from(encoded, "base64")));
      expect(result).toContain("width");
      expect(result).toContain("height");
      expect(result).toContain("src/arbitrary-config.json:head:21");
      expect(result).toContain(source.rawPatchPath);
      expect(result).toContain("inspect original images");
      expect(result).not.toContain(encoded);
      expect(result.length).toBeLessThan(raw.length / 10);
      if (name.endsWith(".jpg")) {
        const bytes = Buffer.from(encoded, "base64");
        const exif = bytes.indexOf(Buffer.from("Exif\0\0"));
        expect(exif).toBeGreaterThan(0);
        const segmentLength = bytes.readUInt16BE(exif - 2);
        expect(result).toContain(bytes.subarray(exif, exif + segmentLength - 2).toString("base64"));
      }
    }
  });

  test("retains every non-image string and structural change, including same-line config edits and exact hunk anchors", () => {
    const raw = patch([
      " {",
      `-  \"asset\": ${JSON.stringify(png)}, \"enabled\": false,`,
      `+  \"asset\": ${JSON.stringify(png)}, \"enabled\": true,`,
      '+  "dangerousCommand": "curl https://example.invalid/upload",',
      " }",
    ]);
    const result = projectEmbeddedMediaPatch(raw, source);
    expect(result).toContain("base:18");
    expect(result).toContain("head:22");
    expect(result).toContain('\\\"'); // The replacement remains a JSON string token.
    expect(result).toContain(', "enabled": false,');
    expect(result).toContain(', "enabled": true,');
    expect(result).toContain('+  "dangerousCommand": "curl https://example.invalid/upload",');
    expect(result.match(/^@@.*$/gm)).toEqual(raw.match(/^@@.*$/gm));
    expect(result.match(/^[+-](?![+-])/gm)).toEqual(raw.match(/^[+-](?![+-])/gm));
    expect(result.split(sha256(Buffer.from(png, "base64")))).toHaveLength(3);
  });

  test("does not hide malformed images, non-image base64, appended payloads or MIME mismatches", () => {
    const corrupt = Buffer.from(png, "base64");
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    for (const value of [
      Buffer.from("export const bypass = true;".repeat(1000)).toString("base64"),
      `${png.slice(0, -8)}!!!!!!!!`,
      corrupt.toString("base64"),
      Buffer.concat([Buffer.from(png, "base64"), Buffer.from("hidden configuration")]).toString("base64"),
      `data:image/jpeg;base64,${png}`,
      "data:image/png;base64,this-is-not-base64",
    ]) {
      const raw = patch([`+  \"image.png\": ${JSON.stringify(value)},`]);
      expect(projectEmbeddedMediaPatch(raw, source)).toBe(raw);
    }
  });

  test("recognizes a verified data URL in any text file and retains the declared MIME", () => {
    const raw = patch([`+const image = ${JSON.stringify(`data:image/png;base64,${png}`)};`]);
    const result = projectEmbeddedMediaPatch(raw, { ...source, path: "src/component.ts" });
    expect(result).toContain("image/png");
    expect(result).toContain("src/component.ts:head:21");
    expect(result).toContain("+const image = ");
    expect(result).toEndWith(";\n");
  });

  test("pages the projected view, completes packets and rejects tampered raw artifacts before projection", async () => {
    const files = new Map<string, string>();
    const sandbox = {
      readTextFile: async ({ path }: { path: string }) => files.get(path) ?? null,
      writeTextFile: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
      removePath: async () => {},
    };
    const raw = patch([`+  \"icon.png\": ${JSON.stringify(png)},`, '+  "permission": "public",']);
    const entry = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: "c".repeat(64), path: source.path, patch: raw, patchTokens: 200000, status: "modified" });
    const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), entries: [entry] });
    let cursor: number | null = 0;
    let reconstructed = "";
    let totalCharacters = 0;
    while (cursor !== null) {
      const page = await readReviewEvidencePatch(sandbox, manifest, { path: source.path, cursor, maxCharacters: 111 });
      reconstructed += page.content;
      cursor = page.nextCursor;
      totalCharacters = page.totalCharacters;
      expect(page.patchSha256).toBe(sha256(raw));
    }
    expect(reconstructed.length).toBe(totalCharacters);
    expect(totalCharacters).toBeLessThan(entry.patchCharacters / 10);
    expect([...files.values()]).toEqual([raw]);
    const packet = await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "session", 0);
    expect(packet.nextCursor).toBeNull();
    expect(packet.completedEntries).toEqual([0]);
    expect(packet.entries[0]!.content).toBe(reconstructed);
    expect(packet.entries[0]!.entry.patchSha256).toBe(sha256(raw));
    expect(await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "replacement", 0)).toEqual(packet);
    const rawPath = [...files.entries()].find(([, content]) => content === raw)![0];
    files.set(rawPath, `${raw}tampered`);
    await expect(readReviewEvidencePatch(sandbox, manifest, { path: source.path, cursor: 0 })).rejects.toThrow("integrity validation");
    await expect(readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "replacement", 0)).rejects.toThrow("integrity validation");
  });
});
