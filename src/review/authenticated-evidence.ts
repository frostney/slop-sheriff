import { createHmac, timingSafeEqual } from "node:crypto";

export interface TextSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  writeTextFile(options: { readonly path: string; readonly content: string }): PromiseLike<void>;
}

const prefix = "known-good-review-signed-v1 ";

export function evidenceSigningKey(secret: string | undefined): Buffer {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error("KNOWN_GOOD_REVIEW_EVIDENCE_KEY must contain 64 hexadecimal characters");
  }
  return Buffer.from(secret, "hex");
}

export function signEvidenceArtifact(path: string, content: string, scope: string, secret: string | undefined): string {
  if (!scope) throw new Error("Evidence authentication requires a root session");
  const mac = createHmac("sha256", evidenceSigningKey(secret)).update(JSON.stringify([scope, path])).update("\0").update(content).digest("hex");
  return `${prefix}${mac}\n${content}`;
}

export function readAuthenticatedEvidenceArtifact(path: string, source: string, scope: string, secret: string | undefined): string {
  const header = source.slice(0, prefix.length + 65);
  const mac = header.slice(prefix.length, -1);
  const content = source.slice(header.length);
  const expected = signEvidenceArtifact(path, content, scope, secret).slice(prefix.length, prefix.length + 64);
  if (!header.startsWith(prefix) || !header.endsWith("\n") || !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) throw new Error("Review evidence authentication failed");
  return content;
}

/** Authenticate application artifacts without putting the key in the sandbox. */
export function authenticatedEvidenceSandbox<T extends TextSandbox>(sandbox: T, scope: string, secret: string | undefined): T {
  evidenceSigningKey(secret);
  if (!scope) throw new Error("Evidence authentication requires a root session");
  const managed = (path: string) => path.startsWith("/tmp/known-good-review/");
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "readTextFile") return async (options: { path: string }) => {
        const source = await target.readTextFile(options);
        return source === null || !managed(options.path) ? source : readAuthenticatedEvidenceArtifact(options.path, source, scope, secret);
      };
      if (property === "writeTextFile") return (options: { path: string; content: string }) => target.writeTextFile(managed(options.path) ? {
        ...options, content: signEvidenceArtifact(options.path, options.content, scope, secret),
      } : options);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
