import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { workHash } from "../src/review/work-plan";
import { createProductionReviewQualityExecutor } from "../src/evaluation/production-review-executor";
import {
  createQualityControlRepository,
  portBoundaryOracle,
} from "../src/evaluation/quality-controls";
import {
  frozenQualityBundle,
  inventoryQualityWorkspace,
  prepareQualityInvocationPlan,
  type QualityWorkspace,
} from "../src/evaluation/quality-workspace";
import {
  prepareQualityInput,
  evaluateQualityLifecycle,
  QualityExecutionFailure,
} from "../src/evaluation/review-quality";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { parseReviewConfig } from "../src/config/review-config";
import { reviewWorkContext } from "../src/review/work-execution";
import { chainForRoute, type ReviewRoute } from "../src/models/routing";

const usage = {
  inputTokens: { total: 25, noCache: 25, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const probeCommand = "npm test";
const finding = {
  category: "CLAIM",
  severity: "IMPORTANT",
  title: "Reject port 65536",
  location: { path: "src/port.mjs", line: 1, symbol: "parsePort" },
  evidence: ["Calling parsePort(65536) returns 65536 instead of rejecting it."],
  impact: "An invalid TCP port reaches callers.",
  impactSummary: "An invalid TCP port reaches callers.",
  remedy: "Reject values greater than 65535.",
  staticOnly: false,
  introduction:
    "The new string parser admits port 65536, although the documented valid range ends at 65535. Keep the upper boundary unchanged when extending accepted input types so callers receive the promised validation.",
  principle: "The README requires ports from 1 through 65535 inclusive.",
  risk: "Requests using port 65536 bypass validation.",
  churn: null,
  requirementIds: [] as string[],
};

test("seeded defect and corrected control are independently verified without exposing the oracle or future fix", async () => {
  const control = await createQualityControlRepository();
  try {
    const oracle = join(control.root, "independent-oracle.mjs");
    await writeFile(oracle, portBoundaryOracle);
    const observed = [];
    for (let index = 0; index < control.testCase.revisions.length; index++) {
      const input = prepareQualityInput(control.testCase, index, control.root);
      const file = join(control.root, `observed-${index}.mjs`);
      await writeFile(
        file,
        execFileSync("git", [
          "-C",
          control.root,
          "show",
          `${input.headSha}:src/port.mjs`,
        ]),
      );
      observed.push(Bun.spawnSync(["node", oracle, file]).exitCode);
      expect(JSON.stringify(input)).not.toContain("independent-oracle");
      const plan = await prepareQualityInvocationPlan(
        control.root,
        input,
        parseReviewConfig(null),
      );
      expect(plan.workUnits.length).toBeGreaterThan(0);
      expect(
        plan.workUnits.every(
          (unit) =>
            unit.packetTextTokens > 0 &&
            unit.toolSchemaTextTokens > 0 &&
            unit.outputTokens === null,
        ),
      ).toBe(true);
      expect(plan.environment.executed).toBe(false);
    }
    expect(observed).toEqual([1, 0]);
  } finally {
    await control.cleanup();
  }
});

// Real Git checkouts and Node probes span the initial review, publication
// recovery, presentation change, and fixing revision, including on shared CI.
test("official mock transport exercises production initial-plus-fix review, probes, persistence, assembly and thread resolution", async () => {
  const control = await createQualityControlRepository();
  const workspaces = new Map<string, QualityWorkspace>();
  const roots: string[] = [];
  const events: unknown[] = [];
  const progressed = new Set<string>();
  const emittedTools: string[] = [];
  let failPublication = true;
  let failProvider = true;
  let malformedReportSent = false;
  let malformedReportObserved = false;
  let priorFailure: QualityExecutionFailure | undefined;
  const routes: ReviewRoute[] = [];
  const requestedModels: string[] = [];
  let currentDefect = true;
  const config = parseReviewConfig("personality: false");
  const executor = createProductionReviewQualityExecutor({
    async workspace(input, cfg, secret) {
      currentDefect = input.headSha === control.testCase.revisions[0]!.head;
      const existing = workspaces.get(input.headSha);
      if (existing)
        return {
          ...existing,
          trusted: {
            ...existing.trusted,
            deliveryId: `quality-${randomUUID()}`,
          },
        };
      const root = await mkdtemp(join(tmpdir(), "sheriff-quality-execute-")),
        workspace = join(root, "workspace"),
        bundle = join(root, "frozen.bundle");
      await writeFile(bundle, await frozenQualityBundle(control.root, input));
      execFileSync("git", ["clone", "--no-checkout", bundle, workspace], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(
        "git",
        ["-C", workspace, "checkout", "--detach", input.headSha],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      if (currentDefect)
        expect(
          Bun.spawnSync([
            "git",
            "-C",
            workspace,
            "cat-file",
            "-e",
            control.testCase.revisions[1]!.head,
          ]).exitCode,
        ).not.toBe(0);
      const files = new Map<string, string>();
      const runtime = {
        async readTextFile({ path }: { path: string }) {
          return files.get(path) ?? null;
        },
        async writeTextFile({
          path,
          content,
        }: {
          path: string;
          content: string;
        }) {
          files.set(path, content);
        },
        async removePath({ path }: { path: string }) {
          for (const key of files.keys())
            if (key.startsWith(path)) files.delete(key);
        },
        async run({ command }: { command: string }) {
          const proc = Bun.spawn(
            ["bash", "-c", command.replaceAll("/workspace", workspace)],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { stdout, stderr, exitCode };
        },
      };
      const prepared = await inventoryQualityWorkspace(
        input,
        cfg,
        authenticatedEvidenceSandbox(runtime, input.headSha, secret),
        {
          revision: "quality-local-toolchain-v1",
          inputsDigest: workHash(
            execFileSync(
              "git",
              ["-C", workspace, "show", `${input.headSha}:package.json`],
              { encoding: "utf8" },
            ),
          ),
          tools: [
            {
              name: "node",
              version: execFileSync("node", ["--version"], {
                encoding: "utf8",
              }).trim(),
            },
            {
              name: "npm",
              version: execFileSync("npm", ["--version"], {
                encoding: "utf8",
              }).trim(),
            },
          ],
          completedSteps: ["Verified declared npm test runtime"],
        },
        async () => {},
      );
      workspaces.set(input.headSha, prepared);
      roots.push(root);
      return prepared;
    },
    publicationRequest(request) {
      if (
        failPublication &&
        request.method === "POST" &&
        request.path.endsWith("/comments")
      ) {
        failPublication = false;
        throw new Error("Injected GitHub publication transport loss");
      }
    },
    model(route, cfg) {
      routes.push(route);
      requestedModels.push(chainForRoute(cfg, route)[0]);
      let step = 0;
      let context: ReturnType<typeof reviewWorkContext> | null = null;
      return new MockLanguageModelV4({
        doGenerate: async (options) => {
          if (options.prompt.some(message => message.role === "tool" && message.content.some(part =>
            part.type === "tool-result" && part.toolCallId === "malformed-review-report" &&
            (part.output.type === "error-text" || part.output.type === "error-json")))) malformedReportObserved = true;
          if (failProvider) {
            failProvider = false;
            throw new APICallError({
              message: "Injected provider overload",
              url: "https://evaluation.invalid/model",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true,
            });
          }
          if (step > 12)
            throw new Error(
              "Deterministic mock protocol loop: " +
                JSON.stringify(options.prompt.slice(-2)),
            );
          const output = (name: string, input: unknown) => {
            emittedTools.push(name);
            const missingReport = name === "review_work" && !malformedReportSent &&
              typeof input === "object" && input !== null && "action" in input &&
              typeof input.action === "object" && input.action !== null &&
              "operation" in input.action && input.action.operation === "complete";
            if (missingReport) malformedReportSent = true;
            return {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: missingReport ? `malformed-review-report` : `call-${step++}`,
                  toolName: name,
                  input: JSON.stringify(missingReport ? { action: { operation: "complete", reviewedEntries: [] } } : input),
                },
              ],
              finishReason: {
                unified: "tool-calls" as const,
                raw: "tool_calls",
              },
              usage,
              warnings: [],
            };
          };
          if (route.role === "coordinator") {
            const request = options.prompt.find(
              (message) => message.role === "user",
            );
            const text =
              request && typeof request.content !== "string"
                ? request.content.find((part) => part.type === "text")
                : null;
            const payload = JSON.parse(
              text && "text" in text ? text.text : "{}",
            );
            const sources = (payload.assessments ?? []).flatMap(
              (report: { requirementConcerns: { sourceId: string }[] }) =>
                report.requirementConcerns.map((item) => item.sourceId),
            );
            return output("assemble_review_report", {
              draft: {
                actionSummary: currentDefect
                  ? "Reject port 65536 before this change ships."
                  : "The upper boundary now matches the public contract.",
                additionalConcerns: [],
                freshFindings:
                  currentDefect && !payload.priorFindings?.length
                    ? [{ ...finding, requirementIds: [...new Set(sources)] }]
                    : [],
                ...(cfg.personality && payload.priorFindings?.length
                  ? {
                      presentations: payload.priorFindings.map(
                        (item: { id: string }) => ({
                          id: item.id,
                          introduction:
                            "Hold your horses, this parser lets port 65536 stroll past a 65535 boundary. Keep the documented port range intact when accepting decimal strings so callers get the validation they were promised.",
                        }),
                      ),
                    }
                  : {}),
              },
            });
          }
          if (route.role === "revalidation") {
            const request = options.prompt.find(
              (message) => message.role === "user",
            );
            const text =
              request && typeof request.content !== "string"
                ? request.content.find((part) => part.type === "text")
                : null;
            const payload = JSON.parse(
              text && "text" in text ? text.text : "{}",
            );
            if (step === 0)
              return output("run_review_probe", {
                command: probeCommand,
                cwd: ".",
                stdin: null,
                environment: [],
                rerun: false,
              });
            return output("final_output", {
              findings: payload.findings.map(
                (item: Record<string, unknown>) => ({
                  ...item,
                  status: "fixed",
                  evidence: ["The exact upper-bound probe now rejects 65536."],
                  resolutionSummary: "The upper bound now rejects port 65536.",
                }),
              ),
            });
          }
          const currentTurn = options.prompt.slice(
            options.prompt.map((message) => message.role).lastIndexOf("user") +
              1,
          );
          for (const message of [...currentTurn].reverse())
            if (message.role === "tool")
              for (const part of message.content) {
                if (
                  part.type === "tool-result" &&
                  part.toolName === "review_work" &&
                  part.output.type === "json" &&
                  part.output.value &&
                  typeof part.output.value === "object" &&
                  "workId" in part.output.value &&
                  "status" in part.output.value
                )
                  return output("final_output", part.output.value);
              }
          if (route.role !== "lane") throw new Error("Unexpected model role");
          if (step === 0)
            return output("review_work", {
              action: { operation: "read" },
            });
          for (const message of currentTurn)
            if (message.role === "tool")
              for (const part of message.content) {
                if (
                  part.type === "tool-result" &&
                  part.toolName === "review_work" &&
                  part.output.type === "json"
                )
                  context = part.output.value as ReturnType<
                    typeof reviewWorkContext
                  >;
              }
          if (!context)
            throw new Error("Mock did not receive production work context");
          const staticClient = context.entries.every((entry) =>
            entry.path.startsWith("client/"),
          );
          if (step === 1 && staticClient && !progressed.has(context.workId)) {
            progressed.add(context.workId);
            return output("review_work", {
              action: {
                operation: "progress",
                escalation: null,
                reviewedEntries: [],
                remainingEntries: context.entries.map((entry) => entry.index),
                observations: [],
                nextSteps: ["Inspect the independent client label change"],
                limitations: [],
              },
            });
          }
          if (step === 1 && !staticClient)
            return output("run_review_probe", {
              command: probeCommand,
              cwd: ".",
              stdin: null,
              environment: [],
              rerun: false,
            });
          const evidenceRefs: { kind: "probe"; id: string }[] = [];
          for (const message of currentTurn)
            if (message.role === "tool")
              for (const part of message.content)
                if (
                  part.type === "tool-result" &&
                  part.toolName === "run_review_probe" &&
                  part.output.type === "json" &&
                  part.output.value &&
                  typeof part.output.value === "object" &&
                  "executionId" in part.output.value
                )
                  evidenceRefs.push({
                    kind: "probe",
                    id: String(part.output.value.executionId),
                  });
          const requirementChecks = context.requirements.flatMap((source) =>
            (source.obligations.length
              ? source.obligations
              : [{ id: null }]
            ).map((obligation) => ({
              evidenceRefs,
              sourceId: source.id,
              obligationId: obligation.id,
              requirement: "Preserve valid port range",
              establishedRequirement: "Accept ports from 1 through 65535",
              basis: staticClient ? "not-applicable" : "established",
              proposedChange: "Accept decimal string ports",
              approvalEvidence: null,
              expected: "65536 is rejected",
              observed: staticClient
                ? "The literal client label does not perform or change port validation"
                : currentDefect
                  ? "65536 was accepted"
                  : "65536 was rejected",
              action: staticClient
                ? "Read the literal label patch"
                : probeCommand,
              environment: "Frozen Node runtime",
              status: staticClient
                ? "out-of-scope"
                : currentDefect
                  ? "failed"
                  : "passed",
            })),
          );
          return output("review_work", {
            action: {
              operation: "complete",
              reviewedEntries: context.entries.map((entry) => entry.index),
              report: {
                axis: route.axis,
                scope: {
                  claim: context.claim,
                  dirtyState: "Exact frozen head",
                  inspectedSupportingContext: [],
                },
                coverage: { staticOnly: [], unreached: [] },
                churn: {
                  window: "Frozen case",
                  symbolCoverage: [],
                  fileFallbacks: [],
                },
                probes: staticClient
                  ? []
                  : [
                      {
                        evidenceRefs,
                        commandOrAction: probeCommand,
                        result: currentDefect
                          ? "Exit 1: 65536 accepted"
                          : "Exit 0: 65536 rejected",
                      },
                    ],
                candidates: [],
                verifiedClaims: [],
                limitations: [],
                specialistChecks:
                  route.axis === "engineering-quality"
                    ? null
                    : [
                        {
                          evidenceRefs,
                          entries: context.entries.map((entry) => entry.index),
                          requirement: "Reject invalid port",
                          source: "README.md",
                          expected: "65536 is rejected",
                          environment: "Frozen Node runtime",
                          action: probeCommand,
                          observed: currentDefect
                            ? "65536 accepted"
                            : "65536 rejected",
                          status: staticClient
                            ? "out-of-scope"
                            : currentDefect
                              ? "failed"
                              : "passed",
                        },
                      ],
                requirementChecks,
              },
            },
          });
        },
      });
    },
    record: async (event) => {
      events.push(event);
    },
  });
  try {
    const inputs = control.testCase.revisions.map((_, index) =>
      prepareQualityInput(control.testCase, index, control.root),
    );
    try {
      await executor.execute(inputs[0]!, config);
    } catch (error) {
      if (!(error instanceof QualityExecutionFailure)) throw error;
      priorFailure = error;
    }
    expect(priorFailure?.message).toContain("Injected GitHub");
    expect(priorFailure!.result.costRows.length).toBeGreaterThan(0);
    const modelCallsBeforeRecovery = routes.length;
    const recovered = await executor.execute(inputs[0]!, config);
    expect(recovered.coverageComplete).toBe(true);
    expect(malformedReportSent).toBe(true);
    expect(malformedReportObserved).toBe(true);
    expect(recovered.costRows).toEqual([]);
    expect(routes.length).toBe(modelCallsBeforeRecovery);
    const routesBeforeVoice = routes.length;
    const voice = await executor.execute(
      inputs[0]!,
      parseReviewConfig("voice: understated\ntasks:\n  presentation:\n    model: openai/gpt-5.6-sol\n    reasoning: low"),
    );
    expect(voice.coverageComplete).toBe(true);
    expect(routes.slice(routesBeforeVoice).map((route) => route.role)).toEqual([
      "coordinator",
    ]);
    expect(routes.slice(routesBeforeVoice).map((route) => route.task)).toEqual(["presentation"]);
    expect(requestedModels.slice(routesBeforeVoice)).toEqual(["openai/gpt-5.6-sol"]);
    expect(voice.costRows.length).toBeGreaterThan(0);
    expect(voice.costRows.every((row) => row.phase === "presentation")).toBe(true);
    expect(voice.canonicalReport?.findings[0]?.status).toBe("open");
    expect(voice.canonicalReport?.findings[0]?.introduction).toContain(
      "Hold your horses",
    );
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "event" in event &&
          event.event === "finding.status-retained",
      ),
    ).toBe(true);
    // Combine the failed attempt's actual billing with its zero-model publication recovery.
    const result = await evaluateQualityLifecycle(inputs, config, {
      kind: executor.kind,
      execute: (input, cfg) =>
        input.headSha === inputs[0]!.headSha
          ? Promise.resolve({
              ...recovered,
              costRows: [...priorFailure!.result.costRows, ...voice.costRows],
            })
          : executor.execute(input, cfg),
    });
    expect(result.runs.map((run) => run.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(result.coverageComplete).toBe(true);
    expect(result.costs.totalCostUsd).toBeNull(); // Deterministic mock responses are not provider billing.
    const reports = result.runs.flatMap((run) =>
      "canonicalReport" in run && run.canonicalReport
        ? [run.canonicalReport]
        : [],
    );
    expect(reports.map((report) => report.findings[0]!.status)).toEqual([
      "open",
      "fixed",
    ]);
    expect(result.costLifecycle.cumulative.calls).toBe(emittedTools.length + 1);
    expect(result.costLifecycle.full.failedCalls).toBe(1);
    expect(result.costLifecycle.full.calls).toBeGreaterThan(0);
    expect(result.costLifecycle.delta.calls).toBeGreaterThan(0);
    expect(
      result.runs.every(
        (run) =>
          "execution" in run &&
          run.execution?.substituted.includes(
            "GitHub server/permissions and check-run observations",
          ),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        JSON.stringify(event).includes("KnownGoodReviewResolveThread"),
      ),
    ).toBe(true);
    const plans = events.filter(
      (
        event,
      ): event is {
        event: string;
        headSha: string;
        units: { id: string; status: string }[];
      } =>
        typeof event === "object" &&
        event !== null &&
        "event" in event &&
        event.event === "work.prepared",
    );
    expect(plans.length).toBe(3);
    expect(plans[1]!.units.every((unit) => unit.status === "reused")).toBe(
      true,
    );
    expect(plans[2]!.units.some((unit) => unit.status === "reused")).toBe(true);
    expect(routes.some((route) => route.role === "revalidation")).toBe(true);
    expect(progressed.size).toBeGreaterThan(0);
    expect(emittedTools.filter((name) => name === "final_output").length).toBe(
      routes.filter((route) => route.role !== "coordinator").length,
    );
    expect(
      result.runs.some(
        (run) =>
          "probes" in run &&
          run.probes?.some((probe) => probe.outcome === "failed"),
      ),
    ).toBe(true);
    expect(
      routes.some(
        (route) =>
          route.role === "coordinator" && route.task === "adjudication",
      ),
    ).toBe(true);
  } catch (error) {
    if (error instanceof QualityExecutionFailure) console.error(error.message);
    throw error;
  } finally {
    await control.cleanup();
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }
}, 30_000);
