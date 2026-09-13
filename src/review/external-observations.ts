import { createHash } from "node:crypto";
import { z } from "zod";
import type { TextSandbox } from "./authenticated-evidence";
import { withReviewEvidenceLock, type ProbeClaims } from "./probe-execution";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const externalObservationSchema = z.strictObject({
  schemaVersion: z.literal(1), id: hash, attemptId: z.string().min(1),
  kind: z.enum(["web", "image"]), target: z.string().min(1),
  observedAt: z.string().datetime(), outputDigest: hash,
}).superRefine((value, ctx) => {
  const { id, ...payload } = value;
  if (digest(JSON.stringify(payload)) !== id) ctx.addIssue({ code: "custom", message: "External observation digest mismatch" });
});
export type ExternalObservation = z.infer<typeof externalObservationSchema>;
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function externalObservationPath(id: string): string { return `/tmp/known-good-review/external/${hash.parse(id)}.json`; }
export function workExternalObservationsPath(fingerprint: string, workId: string): string { return `/tmp/known-good-review/work/${hash.parse(fingerprint)}/${hash.parse(workId)}/external.json`; }
export async function readWorkExternalObservations(evidence: TextSandbox, fingerprint: string, workId: string): Promise<ExternalObservation[]> {
  const raw = await evidence.readTextFile({ path: workExternalObservationsPath(fingerprint, workId) });
  return raw === null ? [] : externalObservationSchema.array().parse(JSON.parse(raw));
}
/** Only actual access writes a marker. Opaque external/image inputs prevent future reuse. */
export async function recordWorkExternalObservation(evidence: TextSandbox, claims: ProbeClaims, identity: { fingerprint: string; workId: string; attemptId: string }, observed: { kind: ExternalObservation["kind"]; target: string; content: string }, signal?: AbortSignal): Promise<ExternalObservation> {
  const payload = { schemaVersion: 1 as const, attemptId: identity.attemptId, kind: observed.kind, target: observed.target, observedAt: new Date().toISOString(), outputDigest: digest(observed.content) };
  const observation = externalObservationSchema.parse({ ...payload, id: digest(JSON.stringify(payload)) });
  await claims.assertCurrent();
  await evidence.writeTextFile({ path: externalObservationPath(observation.id), content: observed.content });
  const path = workExternalObservationsPath(identity.fingerprint, identity.workId);
  await withReviewEvidenceLock(claims, path, async () => {
    const prior = await readWorkExternalObservations(evidence, identity.fingerprint, identity.workId);
    if (!prior.some(item => item.id === observation.id)) await evidence.writeTextFile({ path, content: JSON.stringify([...prior, observation]) });
  }, signal);
  await claims.assertCurrent();
  return observation;
}
export async function validateCurrentExternalObservations(evidence: TextSandbox, attemptId: string, observations: readonly ExternalObservation[]): Promise<boolean> {
  for (const value of observations) {
    const observation = externalObservationSchema.parse(value);
    if (observation.attemptId !== attemptId) return false;
    const content = await evidence.readTextFile({ path: externalObservationPath(observation.id) });
    if (content === null || digest(content) !== observation.outputDigest) return false;
  }
  return true;
}
