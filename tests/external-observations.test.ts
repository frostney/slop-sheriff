import { expect, test } from "bun:test";
import { asSchema } from "ai";
import { z } from "zod";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { externalObservationPath, readWorkExternalObservations, recordWorkExternalObservation, validateCurrentExternalObservations } from "../src/review/external-observations";
import { fetchReviewReferenceInputSchema } from "../agent/tools/fetch_review_reference";
import { inspectReviewImageInputSchema } from "../agent/tools/inspect_review_image";
import { readReviewProbeInputSchema } from "../agent/tools/read_review_probe";
import type { ProbeClaims } from "../src/review/probe-execution";

test("concurrent native observations append every signed receipt and bind the current attempt", async () => {
  const files = new Map<string, string>(), owners = new Map<string, string>();
  const evidence = authenticatedEvidenceSandbox({ async readTextFile({path}:{path:string}) { return files.get(path) ?? null; }, async writeTextFile({path,content}:{path:string;content:string}) { files.set(path,content); } }, "root", "a".repeat(64));
  const claims: ProbeClaims = { async assertCurrent() {}, async assertHealthy() {}, async fail() {},
    async claim(path,owner) { const previous = owners.get(path); if (previous) return {acquired:false,owner:previous}; owners.set(path,owner); return {acquired:true,owner}; },
    async release(path) { owners.delete(path); },
  };
  const identity = { fingerprint: "b".repeat(64), workId: "c".repeat(64), attemptId: "attempt-current" };
  await Promise.all([
    recordWorkExternalObservation(evidence, claims, identity, {kind:"web",target:"https://example.com/docs",content:"observed official response"}),
    recordWorkExternalObservation(evidence, claims, identity, {kind:"image",target:"/workspace/screenshot.png",content:"observed binary bytes"}),
  ]);
  const records = await readWorkExternalObservations(evidence, identity.fingerprint, identity.workId);
  expect(records.map(record => record.kind).sort()).toEqual(["image", "web"]);
  expect(await validateCurrentExternalObservations(evidence, identity.attemptId, records)).toBe(true);
  expect(await validateCurrentExternalObservations(evidence, "earlier-attempt", records)).toBe(false);
  files.set(externalObservationPath(records[0]!.id), "forged output");
  await expect(validateCurrentExternalObservations(evidence, identity.attemptId, records)).rejects.toThrow("authentication failed");
});

test("actual generated schemas expose reads and paging without model-owned observation provenance", async () => {
  for (const schema of [fetchReviewReferenceInputSchema, inspectReviewImageInputSchema, readReviewProbeInputSchema] as z.ZodType<unknown>[]) {
    const generated = await asSchema(schema).jsonSchema;
    expect(generated.additionalProperties).toBe(false);
    for (const field of ["attemptId", "workId", "outputDigest", "passed", "reusable"]) expect(generated).not.toHaveProperty(`properties.${field}`);
  }
  expect(fetchReviewReferenceInputSchema.safeParse({url:null, observationId:null, cursor:null}).success).toBe(false);
  expect(inspectReviewImageInputSchema.safeParse({path:"/workspace/../etc/passwd"}).success).toBe(false);
  expect(inspectReviewImageInputSchema.safeParse({path:"/etc/passwd"}).success).toBe(false);
});
