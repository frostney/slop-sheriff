import { AsyncLocalStorage } from "node:async_hooks";
import type { EvidenceWriteClaim } from "./durable-evidence-contracts";

// A tool execution stays in one Node async context. Carry its evidence lock to
// the database commit without exposing ownership to models or repository code.
export const evidenceWriteScope = new AsyncLocalStorage<EvidenceWriteClaim>();

export function withEvidenceWriteClaim(body: unknown): unknown {
  const writeClaim = evidenceWriteScope.getStore();
  if (!writeClaim) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Evidence writes require an object request");
  return { ...body, writeClaim };
}
