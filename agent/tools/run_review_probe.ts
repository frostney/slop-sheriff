import { defineTool, toolOutput } from "eve/tools";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { currentReviewEvidenceIdentity } from "../lib/review-evidence";
import { reviewRouteState } from "../lib/review-route";
import { reviewWorkPlanPath } from "../../src/review/work-plan";
import { preparedReviewWorkPlanSchema } from "../../src/review/prepare-review-work";
import { readReviewEvidenceLedger } from "../../src/review/evidence-ledger";
import { readCapabilityPreflight } from "../../src/review/capability-preflight";
import { localWorkspaceReceiptPath, physicalWorkspaceReceipt } from "../../src/review/physical-workspace";
import {
  durableProbeClaims, preparedProbeObservation, reviewProbeCommand, reviewProbeSnapshotCommand,
  recordWorkProbeReceipt, runReviewProbeInputSchema, runSharedReviewProbe,
} from "../../src/review/probe-execution";

export { runReviewProbeInputSchema } from "../../src/review/probe-execution";

export default defineTool({
  description: "Execute required tests or behavioral probes in the prepared review sandbox. Identical local checks share one application-recorded observation across lanes when source inputs, scripts, dependencies, toolchain and environment match. Each lane independently judges the result against its requirements. Use rerun=true for independent execution or repeated/flaky sampling. Changed assertions, standard input, scenario arguments, environment or files execute again. Receipts preserve the real exit code and full output; no model-supplied provenance or success claims are accepted.",
  inputSchema: runReviewProbeInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.deliveryId) throw new Error("Shared probes require an admitted review attempt");
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const ledger = await readReviewEvidenceLedger(sandbox, currentReviewEvidenceIdentity(ctx.session.auth.current));
    const physicalReceipt = await sandbox.readTextFile({ path: localWorkspaceReceiptPath });
    if (physicalReceipt !== physicalWorkspaceReceipt(sandbox.id, trusted, ledger)) {
      throw new Error("Shared probes require the current prepared physical workspace; restore setup before executing tests");
    }
    const capabilities = await readCapabilityPreflight(sandbox, ledger.identity);
    if (!capabilities.setup) throw new Error("Shared probes require the prepared dependency and toolchain receipt");
    const route = reviewRouteState.get();
    if (route?.role === "lane" && route.workId) {
      const plan = preparedReviewWorkPlanSchema.parse(JSON.parse(await sandbox.readTextFile({ path: reviewWorkPlanPath(ledger.identity.patchFingerprint) }) ?? "null"));
      if (!plan.units.some(unit => unit.id === route.workId && unit.axis === route.axis)) throw new Error("Probe work assignment is not present in the prepared plan");
    }
    const claims = durableProbeClaims(trusted.deliveryId);
    const result = await runSharedReviewProbe(input, {
      repositoryId: trusted.repositoryId,
      origin: { attemptId: trusted.deliveryId, sessionId: ctx.session.id, callId: ctx.callId },
      evidence: sandbox, claims, signal: ctx.abortSignal,
      async observe() {
        const result = await sandbox.run({ command: reviewProbeSnapshotCommand });
        if (result.exitCode !== 0) throw new Error(`Probe input/environment observation failed: ${String(result.stderr)}`);
        return preparedProbeObservation(JSON.parse(String(result.stdout)), capabilities.setup, input.command, input.environment);
      },
      async execute(command) {
        const result = await sandbox.run({ command: reviewProbeCommand(command) });
        return { exitCode: result.exitCode, stdout: String(result.stdout), stderr: String(result.stderr) };
      },
    });
    if (route?.role === "lane" && route.workId) {
      await recordWorkProbeReceipt(sandbox, claims, ledger.identity.patchFingerprint, route.workId, result.receipt, ctx.abortSignal, trusted.deliveryId);
    }
    return result;
  },
  toModelOutput({ receipt, receiptPath, reused }) {
    const result = receipt.result;
    return toolOutput.json({
      probeId: receipt.probeId, executionId: receipt.executionId, receiptPath, reused,
      outcome: result?.exitCode === 0 ? "passed" : "failed", exitCode: result?.exitCode ?? null,
      stdout: result?.stdout.slice(0, 8_000) ?? "", stderr: result?.stderr.slice(0, 8_000) ?? "",
      stdoutNextCursor: (result?.stdout.length ?? 0) > 8_000 ? 8_000 : null,
      stderrNextCursor: (result?.stderr.length ?? 0) > 8_000 ? 8_000 : null,
      readRemainingOutputWith: "read_review_probe",
      fullOutputInReceipt: (result?.stdout.length ?? 0) > 8_000 || (result?.stderr.length ?? 0) > 8_000,
      observation: "One observed execution; interpret it independently against this lane's obligations.",
    });
  },
});
