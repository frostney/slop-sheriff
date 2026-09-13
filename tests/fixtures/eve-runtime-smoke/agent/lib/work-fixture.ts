import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { authenticatedEvidenceSandbox } from "../../../../../src/review/authenticated-evidence";
import { workOrchestrationFixture } from "../../../../work-orchestration-fixture";
import { parseReviewConfig } from "../../../../../src/config/review-config";
import { activeAxes, runtimeProjectConfig, identity } from "./orchestration";
import { projectLaneRegistryDigest } from "../../../../../src/review/project-lane-identity";
import { reviewWorkPlanPath } from "../../../../../src/review/work-plan";
import { reviewWorkResultArtifactSchema } from "../../../../../src/review/work-runtime";

/** Provider-free test transport for signed durable artifacts; workflow code never resolves a VM. */
export function fixtureWorkReader(rootSessionId: string) {
  const local = (path: string) => `/tmp/eve-work-smoke/${encodeURIComponent(rootSessionId)}${path}`;
  return authenticatedEvidenceSandbox({
    async readTextFile({ path }: { path: string }) { try { return await readFile(local(path), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
    async writeTextFile({ path, content }: { path: string; content: string }) { await mkdir(dirname(local(path)), { recursive: true }); const temporary = `${local(path)}.${randomUUID()}.tmp`; await writeFile(temporary, content); await rename(temporary, local(path)); },
  }, rootSessionId, "1".repeat(64));
}
export async function fixtureWorkPlan(rootSessionId: string, context: string) {
  const config = parseReviewConfig(context === "KGR-EVAL-PROJECT-LANES" ? runtimeProjectConfig : null);
  const axes = context === "KGR-EVAL-LOST-HANDLE" ? ["engineering-quality" as const] : config.lanes?.length ? config.lanes.map(lane => lane.id) : activeAxes;
  const fixture = workOrchestrationFixture(axes, rootSessionId);
  const reader = fixtureWorkReader(rootSessionId);
  for (const [path, content] of fixture.files) await reader.writeTextFile({ path, content });
  for (const unit of fixture.plan.prepared.units) {
    const previous = await reader.readTextFile({ path: unit.resultPath });
    if (previous !== null) {
      const result = reviewWorkResultArtifactSchema.parse(JSON.parse(previous));
      if (result.assessment.checkpoint.status === "complete") { unit.status = "reused"; unit.reusableAssessment = result.assessment; }
    }
  }
  const plan = { ...fixture.plan, modelConfig: config, commonPrefix: `KGR-EVAL-AUTHORED-CHILD ${context}`, lanes: [...(config.lanes ?? [])], laneRegistryDigest: projectLaneRegistryDigest(config) };
  await reader.writeTextFile({ path: reviewWorkPlanPath(identity.patchFingerprint), content: JSON.stringify(plan.prepared) });
  return plan;
}

export async function refreshFixtureWorkHandles(rootSessionId: string, signal?: AbortSignal) {
  const origin = process.env.WORKFLOW_LOCAL_BASE_URL ?? `http://127.0.0.1:${process.env.PORT}`;
  const response = await fetch(new URL("/fixture/native-work", origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootSessionId }), ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Native fixture stream capture failed: ${response.status}`);
  return (await response.json() as { handles: { rootSessionId: string; invocationId: string; sessionId: string; agentId: string }[] }).handles;
}
