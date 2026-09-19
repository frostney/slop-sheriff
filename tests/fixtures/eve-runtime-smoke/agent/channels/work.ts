import { defineChannel, POST } from "eve/channels";
import { z } from "zod";
import { persistNativeWorkHandles } from "../../../../../agent/lib/native-work-handles";
import { fixtureWorkReader } from "../lib/work-fixture";
import { reviewWorkResultPath, reviewWorkResultArtifactSchema } from "../../../../../src/review/work-runtime";
import { identity } from "../lib/orchestration";
export default defineChannel({ routes: [POST("/fixture/native-work", async (request,ctx) => {
  const { rootSessionId } = z.strictObject({ rootSessionId: z.string().min(1) }).parse(await request.json());
  const handles = await persistNativeWorkHandles(ctx.attachSession(rootSessionId), fixtureWorkReader(rootSessionId), identity.patchFingerprint);
  return Response.json({ handles });
}), POST("/fixture/work-result", async (request) => {
  const { rootSessionId, workId } = z.strictObject({ rootSessionId: z.string().min(1), workId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await request.json());
  const result = reviewWorkResultArtifactSchema.parse(JSON.parse(await fixtureWorkReader(rootSessionId).readTextFile({ path: reviewWorkResultPath(identity.patchFingerprint, workId) }) ?? "null"));
  return Response.json({ invocation: result.invocation, status: result.assessment.checkpoint.status });
})] });
