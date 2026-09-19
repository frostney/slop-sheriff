import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ToolLoopAgent,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { ReviewConfig } from "../config/review-config";
import {
  chainForRoute,
  taskForRoute,
  reasoningForRoute,
  withTaskReasoning,
  parseSubagentRoute,
  type ReviewRoute,
} from "../models/routing";
import {
  reviewChildInstructions,
  reviewAdjudicationInstructions,
  reviewInstructions,
} from "../review/policy";
import {
  prepareReviewWork,
  preparedReviewWorkPacketSchema,
  reviewWorkPlanFromPrepared,
  captureReviewWorkProof,
  validateCurrentReviewWorkProof,
} from "../review/prepare-review-work";
import { reviewWorkContext, reviewWorkCheckpoint, persistReviewWork } from "../review/work-execution";
import {
  reviewWorkResultArtifactSchema,
  reviewWorkReceiptSchema,
} from "../review/work-runtime";
import {
  aggregateCompletedWorkResults,
  applyTrustedSpecialistExclusions,
  type ReviewWorkAssessment,
} from "../review/work-results";
import { completedReviewWorkStore } from "../review/work-storage";
import {
  completedWorkEnvelopeSchema,
  type CompletedWorkEnvelope,
} from "../review/work-storage-contracts";
import { workHash } from "../review/work-plan";
import {
  observeReviewSource,
  sourceInspectionRequest,
  recordWorkSourceObservation,
  sourceObservationPage,
} from "../review/source-observations";
import {
  runSharedReviewProbe,
  preparedProbeObservation,
  reviewProbeSnapshotCommand,
  reviewProbeCommand,
  recordWorkProbeReceipt,
  readWorkProbeReceipts,
  reviewProbeOutputPage,
  type ProbeClaims,
} from "../review/probe-execution";
import { orchestrateReview } from "../review/orchestration";
import { requirementObligationIdentities } from "../review/requirements";
import {
  beginReportAssembly,
  recordRevalidationResults,
  assembleCanonicalReviewReport,
  validatedPriorFindings,
} from "../review/report-assembly";
import {
  reviewAdjudicationDraftSchema,
  adjudicationContext,
  assembleDraftFromAssessments,
  applyFindingPresentations,
} from "../review/adjudication";
import {
  reportAssessmentKey,
  reportAssessmentAssociation,
  reportRevalidationProvenance,
  retainedFindingRevalidation,
} from "../review/report-assessments";
import {
  reviewFindingRevalidationSchema,
  type ReviewReport,
} from "../review/findings";
import { publishReview } from "../github/publication";
import { lifecycleConfigured } from "../lifecycle/client";
import { createCostTelemetry } from "../telemetry/sdk-cost-telemetry";
import {
  costReportRowSchema,
  type CostReportRow,
} from "../telemetry/cost-ledger";
import {
  qualityCommonPrefix,
  qualityWorkTools,
} from "./quality-tool-contracts";
import { createQualityPublicationSink } from "./quality-publication-sink";
import {
  createVercelQualityWorkspace,
  type QualityWorkspace,
} from "./quality-workspace";
import {
  QualityExecutionFailure,
  type QualityEvaluationInput,
  type QualityExecutionResult,
  type ReviewQualityExecutor,
} from "./review-quality";

export interface ProductionQualityDependencies {
  workspace(
    input: QualityEvaluationInput,
    config: ReviewConfig,
    secret: string,
  ): Promise<QualityWorkspace>;
  model(route: ReviewRoute, config: ReviewConfig): LanguageModel;
  publicationRequest?(request: {
    method: string;
    path: string;
    body: unknown;
  }): void;
  reconcile?(rows: readonly CostReportRow[]): Promise<CostReportRow[]>;
  /** Awaited before each provider call; preserves billing/progress when a run fails. */
  record?(event: unknown): Promise<void>;
}

/** Uses production review logic with SDK task execution and an isolated GitHub HTTP sink.
 * Native Eve hosting, Convex admission and real GitHub permissions are separate evidence. */
export function createProductionReviewQualityExecutor(
  dependencies: ProductionQualityDependencies,
): ReviewQualityExecutor {
  const secret =
    randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const stored = new Map<string, CompletedWorkEnvelope>();
  const baselines = new Map<string, ReviewReport>();
  const sinks = new Map<
    string,
    ReturnType<typeof createQualityPublicationSink>
  >();
  const staged = new Map<
    string,
    {
      result: QualityExecutionResult;
      context: QualityWorkspace["trusted"];
      files: QualityWorkspace["changedFiles"];
    }
  >();
  return {
    kind: "production-review-lifecycle",
    async execute(input, config) {
      if (lifecycleConfigured())
        throw new Error(
          "Isolated evaluation refuses production Convex credentials; launch without CONVEX_MEMORY_URL and KNOWN_GOOD_REVIEW_MEMORY_TOKEN",
        );
      const key = JSON.stringify([input.repository, input.pullRequest]);
      const publicationKey = workHash([input, config]);
      const publishStaged = async (
        pending: NonNullable<ReturnType<typeof staged.get>>,
      ) => {
        const sink =
          sinks.get(key) ??
          createQualityPublicationSink(dependencies.publicationRequest);
        sinks.set(key, sink);
        sink.setRevision(pending.context, pending.files);
        await publishReview({
          octokit: sink.octokit,
          context: pending.context,
          report: pending.result.canonicalReport!,
          config,
          durableDelivery: true,
        });
        baselines.set(key, pending.result.canonicalReport!);
        await dependencies.record?.({
          event: "publication.captured",
          headSha: input.headSha,
          report: pending.result.canonicalReport,
          requests: structuredClone(sink.requests),
          threads: structuredClone(sink.threads),
        });
        staged.delete(publicationKey);
        return { ...pending.result, coverageComplete: true, costRows: [] };
      };
      const pending = staged.get(publicationKey);
      if (pending) {
        try {
          return await publishStaged(pending);
        } catch (error) {
          throw new QualityExecutionFailure(
            error instanceof Error
              ? error.message
              : "Publication recovery failed",
            { ...pending.result, costRows: [] },
          );
        }
      }
      let workspace: QualityWorkspace | undefined;
      const costs = new Map<string, CostReportRow>();
      const result: QualityExecutionResult = {
        headSha: input.headSha,
        coverageComplete: false,
        assessments: [],
        probes: [],
        costRows: [],
        canonicalReport: null,
        execution: {
          transport: "AI SDK ToolLoopAgent with isolated workspace",
          modelQuality: "unevaluated",
          infrastructureCostUsd: null,
          exercised: [
            "production component planner and input/proof validation",
            "production source observations and shared executable probes",
            "persisted work completion and cross-head reuse",
            "production orchestration and exact coverage aggregation",
            "model adjudication and finding revalidation",
            "production canonical report assembly",
            "production publishReview through Octokit REST/GraphQL",
          ],
          substituted: [
            "native Eve child hosting and workflow durability",
            "Convex admission and work storage transport",
            "GitHub server/permissions and check-run observations",
            "GitHub PR claim read with frozen corpus claim",
            "common memory retrieval",
            "sandbox/cloud infrastructure billing reconciliation",
            "generated/binary inventory classification uses frozen Git diff",
            "publication recovery storage is process-local",
          ],
        },
      };
      const abort = new AbortController();
      const reconcile = async () => {
        const rows = [...costs.values()];
        if (!dependencies.reconcile) return rows;
        try {
          return await dependencies.reconcile(rows);
        } catch (error) {
          await dependencies.record?.({
            event: "billing.reconciliation-failed",
            headSha: input.headSha,
            message:
              error instanceof Error ? error.message : "Billing lookup failed",
          });
          return rows;
        }
      };
      try {
        workspace = await dependencies.workspace(input, config, secret);
        const w = workspace;
        const scopeKey = (scope: string, digest?: string) =>
          JSON.stringify([key, scope, digest]);
        const store = completedReviewWorkStore(w.trusted, {
          secret,
          request: async (operation, raw) => {
            const request = z
              .object({
                scopeKey: z.string().optional(),
                inputDigest: z.string().optional(),
                envelope: completedWorkEnvelopeSchema.optional(),
              })
              .parse(raw);
            if (operation === "put") {
              const envelope = completedWorkEnvelopeSchema.parse(
                  request.envelope,
                ),
                id =
                  scopeKey(
                    envelope.binding.scopeKey,
                    envelope.binding.inputDigest,
                  ) +
                  ":" +
                  workHash(envelope.data);
              const old = stored.get(id);
              if (old && old.data !== envelope.data)
                throw new Error(
                  "Evaluation work storage received conflicting completion",
                );
              if (!old) {
                await dependencies.record?.({
                  event: "work.persisted",
                  envelope,
                });
                stored.set(id, envelope);
              }
              return { result: old ? "duplicate" : "stored" };
            }
            return (
              [...stored.entries()]
                .reverse()
                .find(
                  ([id, envelope]) =>
                    id.startsWith(`[${JSON.stringify(key)},`) &&
                    envelope.binding.scopeKey === request.scopeKey &&
                    (operation === "latest" ||
                      envelope.binding.inputDigest === request.inputDigest),
                )?.[1] ?? null
            );
          },
        });
        const prepared = await prepareReviewWork(
          w.sandbox,
          w.trusted,
          {
            manifest: w.manifest,
            requirements: w.requirements,
            decisions: w.decisions,
            config,
            claim: input.claim,
            setup: w.setup,
          },
          { store },
        );
        await dependencies.record?.({
          event: "work.prepared",
          headSha: input.headSha,
          units: prepared.units.map((unit) => ({
            id: unit.id,
            axis: unit.axis,
            status: unit.status,
            inputDigest: unit.inputDigest,
          })),
        });
        const locks = new Map<string, string>(),
          failedLocks = new Set<string>();
        const claims: ProbeClaims = {
          async assertCurrent() {
            abort.signal.throwIfAborted();
          },
          async claim(path, owner) {
            const old = locks.get(path);
            if (old) return { acquired: false, owner: old };
            locks.set(path, owner);
            return { acquired: true, owner };
          },
          async release(path, owner) {
            if (locks.get(path) !== owner)
              throw new Error("Probe ownership mismatch");
            locks.delete(path);
          },
          async fail(path) {
            failedLocks.add(path);
          },
          async assertHealthy(path) {
            if (failedLocks.has(path))
              throw new Error("Probe outcome is unknown after interruption");
          },
        };
        const rootSessionId = `quality-${randomUUID()}`;
        let stepIndex = 0;
        const telemetry = (route: ReviewRoute, sessionId: string) =>
          createCostTelemetry({
            scope: () => ({
              repositoryId: w.trusted.repositoryId,
              repository: input.repository,
              pullRequest: input.pullRequest,
              headSha: input.headSha,
              attemptId: w.trusted.deliveryId!,
              reviewKind: input.previousHeadSha ? "delta" : "full",
              sessionId,
              turnId: sessionId,
              stepIndex: stepIndex++,
              phase: route.role === "lane" ? route.axis : taskForRoute(route),
            }),
            record: async (observation) => {
              const prior = costs.get(observation.eventId),
                now = Date.now();
              const row = costReportRowSchema.parse({
                ...observation,
                gatewayCostUsd: null,
                gatewayStatus: observation.generationId
                  ? "pending"
                  : "missing-generation",
                gatewayLookupAttempts: 0,
                gatewayLastError: null,
                startedAt: prior?.startedAt ?? now,
                finishedAt: observation.outcome === "started" ? null : now,
              });
              await dependencies.record?.({ event: "model.cost", row });
              costs.set(row.eventId, row);
            },
          });
        const probeTool = (workId: string, sessionId: string) =>
          tool({
            ...qualityWorkTools.run_review_probe,
            execute: async (probe) => {
              const executed = await runSharedReviewProbe(probe, {
                repositoryId: w.trusted.repositoryId,
                origin: {
                  attemptId: w.trusted.deliveryId!,
                  sessionId,
                  callId: randomUUID(),
                },
                evidence: w.sandbox,
                claims,
                signal: abort.signal,
                observe: async () => {
                  const observed = await w.sandbox.run({
                    command: reviewProbeSnapshotCommand,
                  });
                  if (observed.exitCode !== 0)
                    throw new Error("Probe input observation failed");
                  return preparedProbeObservation(
                    JSON.parse(String(observed.stdout)),
                    w.setup,
                    probe.command,
                    probe.environment,
                  );
                },
                execute: async (command) => {
                  const output = await w.sandbox.run({
                    command: reviewProbeCommand(command),
                  });
                  return {
                    exitCode: output.exitCode,
                    stdout: String(output.stdout),
                    stderr: String(output.stderr),
                  };
                },
              });
              await recordWorkProbeReceipt(
                w.sandbox,
                claims,
                prepared.patchFingerprint,
                workId,
                executed.receipt,
                abort.signal,
                w.trusted.deliveryId!,
              );
              const output = executed.receipt.result;
              result.probes.push({
                identity: executed.receipt.digest,
                command: probe.command,
                outcome:
                  output === null
                    ? "unverified"
                    : output.exitCode === 0
                      ? "passed"
                      : "failed",
                result: JSON.stringify(output),
              });
              return {
                probeId: executed.receipt.probeId,
                executionId: executed.receipt.executionId,
                receiptPath: executed.receiptPath,
                reused: executed.reused,
                exitCode: output?.exitCode ?? null,
                stdout: output?.stdout.slice(0, 8000) ?? "",
                stderr: output?.stderr.slice(0, 8000) ?? "",
                fullOutputInReceipt:
                  (output?.stdout.length ?? 0) > 8000 ||
                  (output?.stderr.length ?? 0) > 8000,
              };
            },
          });
        const sourceTool = (workId: string) =>
          tool({
            ...qualityWorkTools.inspect_review_source,
            execute: async (request) => {
              const observation = await observeReviewSource(
                w.sandbox,
                w.trusted,
                sourceInspectionRequest(request),
              );
              await recordWorkSourceObservation(
                w.sandbox,
                claims,
                prepared.patchFingerprint,
                workId,
                observation,
                abort.signal,
              );
              return sourceObservationPage(observation, request.cursor);
            },
          });
        const outputTool = (workId: string) =>
          tool({
            ...qualityWorkTools.read_review_probe,
            execute: async (request) => {
              const receipts = await readWorkProbeReceipts(
                  w.sandbox,
                  prepared.patchFingerprint,
                  workId,
                ),
                receipt = receipts.find(
                  (item) => item.probeId === request.probeId && item.executionId === request.executionId,
                );
              if (!receipt)
                throw new Error("Output does not belong to this assigned work");
              return reviewProbeOutputPage(
                receipt,
                request.stream,
                request.cursor,
              );
            },
          });
        const sessions = new Map<
          string,
          {
            messages: ModelMessage[];
            sessionId: string;
            route: ReviewRoute;
            assessment: ReviewWorkAssessment | null;
            escalation: z.infer<
              typeof reviewWorkResultArtifactSchema
            >["escalation"];
          }
        >();
        const plan = {
          prepared,
          attemptId: w.trusted.deliveryId!,
          modelConfig: config,
          activeAxes: w.decisions
            .filter((item) => item.selected)
            .map((item) => item.axis),
          lanes: [...(config.lanes ?? [])],
          rootSessionId,
          commonPrefix: qualityCommonPrefix,
        };
        const completed = await orchestrateReview({
          plan,
          invocationPrefix: rootSessionId,
          abortSignal: abort.signal,
          reuseWork: async (unit) => unit.reusableAssessment,
          cancelOutstanding: async () => {
            abort.abort(new Error("Sibling review work failed"));
          },
          call: async (dispatch) => {
            const unit = prepared.units.find((unit) =>
              dispatch.key.includes(`:work:${unit.id}:`),
            );
            if (!unit) throw new Error("Unknown assigned work");
            const packet = preparedReviewWorkPacketSchema.parse(
              JSON.parse(
                (await w.sandbox.readTextFile({ path: unit.packetPath })) ??
                  "null",
              ),
            );
            const agentId = dispatch.agentId ?? `quality-agent-${randomUUID()}`;
            const session = sessions.get(agentId) ?? {
              messages: [],
              sessionId: agentId,
              route: parseSubagentRoute([
                { role: "user", content: dispatch.message },
              ]),
              assessment: null,
              escalation: null,
            };
            sessions.set(agentId, session);
            const route = session.route;
            const completion: {
              receipt: z.infer<typeof reviewWorkReceiptSchema> | null;
              final: boolean;
            } = { receipt: null, final: false };
            const agent = new ToolLoopAgent({
              model: dependencies.model(route, config),
              instructions: session.messages.length
                ? reviewInstructions(route)
                : reviewChildInstructions(),
              stopWhen: () => completion.final,
              telemetry: { integrations: telemetry(route, session.sessionId) },
              tools: {
                read_review_probe: outputTool(unit.id),
                final_output: tool({
                  ...qualityWorkTools.final_output,
                  execute: async (receipt) => {
                    if (
                      !completion.receipt ||
                      JSON.stringify(receipt) !==
                        JSON.stringify(completion.receipt)
                    )
                      throw new Error(
                        "Final output must match the persisted work receipt",
                      );
                    completion.final = true;
                    return receipt;
                  },
                }),
                inspect_review_source: sourceTool(unit.id),
                run_review_probe: probeTool(unit.id, session.sessionId),
                review_work: tool({
                  ...qualityWorkTools.review_work,
                  execute: async ({ action }) => {
                    if (action.operation === "read")
                      return reviewWorkContext(packet);
                    const { checkpoint, escalation } = reviewWorkCheckpoint(action);
                    const proof = await captureReviewWorkProof(
                      w.sandbox,
                      prepared.patchFingerprint,
                      packet.unit,
                      packet.inputSnapshot,
                      w.trusted.deliveryId!,
                    );
                    completion.receipt = await persistReviewWork({
                      packet,
                      attemptId: w.trusted.deliveryId!,
                      assertCurrent: () => claims.assertCurrent(),
                      checkpoint,
                      proof,
                      escalation,
                      invocation: {
                        rootSessionId,
                        invocationId: dispatch.key,
                        sessionId: session.sessionId,
                        turnId: dispatch.key,
                      },
                      evidence: w.sandbox,
                      store,
                      validateProof: (assessment) =>
                        validateCurrentReviewWorkProof(
                          w.sandbox,
                          {
                            ...w.trusted,
                            patchFingerprint: prepared.patchFingerprint,
                          },
                          w.setup,
                          assessment,
                          packet.inputSnapshot,
                          w.trusted.deliveryId!,
                        ),
                    });
                    const artifact = reviewWorkResultArtifactSchema.parse(
                      JSON.parse(
                        (await w.sandbox.readTextFile({
                          path: unit.resultPath,
                        })) ?? "null",
                      ),
                    );
                    session.assessment = artifact.assessment;
                    session.escalation = artifact.escalation ?? null;
                    return completion.receipt;
                  },
                }),
              },
            });
            const response = await agent.generate({
              messages: [
                ...session.messages,
                { role: "user", content: dispatch.message },
              ],
              abortSignal: abort.signal,
            });
            session.messages = [
              ...session.messages,
              { role: "user", content: dispatch.message },
              ...response.response.messages,
            ];
            if (!completion.receipt || !completion.final)
              throw new Error(
                "Model stopped without returning its persisted work receipt through final_output",
              );
            return { ...completion.receipt, agentId };
          },
          verifyWork: async (raw, unit, _key, previousSessionId) => {
            const receipt = z
                .object({
                  workId: z.literal(unit.id),
                  status: z.enum(["complete", "in-progress"]),
                  agentId: z.string(),
                })
                .parse(raw),
              session = sessions.get(receipt.agentId);
            if (
              !session?.assessment ||
              (previousSessionId && session.sessionId !== previousSessionId) ||
              session.assessment.checkpoint.status !== receipt.status
            )
              throw new Error(
                "Work receipt lost its retained execution context",
              );
            return {
              assessment: session.assessment,
              sessionId: session.sessionId,
              agentId: receipt.agentId,
              progressDigest: workHash(session.assessment.checkpoint),
              turnId: _key,
              escalation: session.escalation ?? null,
            };
          },
        });
        result.assessments = completed.assessments.map((assessment) => ({
          workId: assessment.unit.id,
          report: assessment.checkpoint.completedReport!,
        }));
        const reports = await aggregateCompletedWorkResults({
          plan: reviewWorkPlanFromPrepared(prepared),
          manifest: w.manifest,
          results: completed.assessments,
          obligations: requirementObligationIdentities(w.requirements),
          expectedInputDigest: (unit) =>
            prepared.units.find((item) => item.id === unit.id)!.inputDigest,
          validateProof: async (assessment) =>
            completed.assessments.some(
              (item) => JSON.stringify(item) === JSON.stringify(assessment),
            ),
        });
        applyTrustedSpecialistExclusions(reports, prepared, w.manifest);
        const prior = baselines.get(key) ?? null;
        let state = beginReportAssembly({
          executionRevision: "review-report-v2",
          repositoryId: w.trusted.repositoryId,
          pullRequest: input.pullRequest,
          baseSha: input.baseSha,
          headSha: input.headSha,
          patchFingerprint: prepared.patchFingerprint,
          planKind: prior ? "delta" : "full",
          baselineHead: prior?.scope.head ?? null,
          reviewPaths: w.manifest.entries.map((entry) => entry.path),
          activeAxes: plan.activeAxes,
          axisDecisions: w.decisions,
          selectedFindingIds:
            prior?.findings
              .filter((finding) => finding.status !== "fixed")
              .map((finding) => finding.id) ?? [],
        });
        const selectedFindingIds =
          prior?.findings
            .filter((finding) => finding.status !== "fixed")
            .map((finding) => finding.id) ?? [];
        const association = prior
          ? await store.get(reportAssessmentKey(prior))
          : null;
        const retained =
          prior && association
            ? retainedFindingRevalidation({
                plan: prepared,
                priorReport: prior,
                selectedFindingIds,
                association: JSON.parse(association.data),
              })
            : null;
        if (retained !== null) {
          state = recordRevalidationResults(state, retained);
          await dependencies.record?.({
            event: "finding.status-retained",
            headSha: input.headSha,
            ids: retained.map((finding) => finding.id),
          });
        }
        if (prior && selectedFindingIds.length && retained === null) {
          const route: ReviewRoute = { role: "revalidation", attempt: 0 },
            sessionId = `revalidation-${randomUUID()}`;
          let recorded = false;
          const revalidator = new ToolLoopAgent({
            model: dependencies.model(route, config),
            instructions: reviewInstructions(route),
            stopWhen: () => recorded,
            telemetry: { integrations: telemetry(route, sessionId) },
            tools: {
              inspect_review_source: sourceTool(prepared.units[0]!.id),
              run_review_probe: probeTool(prepared.units[0]!.id, sessionId),
              read_review_probe: outputTool(prepared.units[0]!.id),
              final_output: tool({
                description:
                  "Return every selected prior finding with current evidence matching its original concern.",
                inputSchema: z.strictObject({
                  findings: z.array(reviewFindingRevalidationSchema),
                }),
                execute: async ({ findings }) => {
                  state = recordRevalidationResults(state, findings);
                  recorded = true;
                  return { recorded: findings.length };
                },
              }),
            },
          });
          await revalidator.generate({
            prompt: JSON.stringify({
              headSha: input.headSha,
              findings: prior.findings.filter((finding) =>
                selectedFindingIds.includes(finding.id),
              ),
              ...adjudicationContext(reports, prior),
            }),
            abortSignal: abort.signal,
          });
          if (!recorded)
            throw new Error("Revalidation ended without all selected findings");
        }
        const coordinatorId = `adjudication-${randomUUID()}`,
          route: ReviewRoute = {
            role: "coordinator",
            attempt: 0,
            task: retained !== null ? "presentation" : "adjudication",
          };
        const coordinator = new ToolLoopAgent({
          model: dependencies.model(route, config),
          instructions: reviewAdjudicationInstructions(config),
          stopWhen: () => state.report !== null,
          telemetry: { integrations: telemetry(route, coordinatorId) },
          tools: {
            assemble_review_report: tool({
              description:
                "Validate and assemble the canonical report from your adjudicated findings. Passing coverage is retained by the application.",
              inputSchema: z.object({ draft: reviewAdjudicationDraftSchema }),
              execute: async ({ draft }) => {
                state = assembleCanonicalReviewReport({
                  draft: assembleDraftFromAssessments(
                    draft,
                    reports,
                    validatedPriorFindings(
                      state,
                      prior,
                      prior?.findings
                        .filter((finding) => !finding.staticOnly)
                        .map((finding) => finding.id) ?? [],
                    ),
                  ),
                  generatedAt: new Date().toISOString(),
                  priorReport: prior,
                  state,
                });
                if (state.report)
                  state = {
                    ...state,
                    report: applyFindingPresentations(
                      state.report,
                      draft.presentations,
                    ),
                  };
                return { complete: true };
              },
            }),
          },
        });
        await coordinator.generate({
          prompt: JSON.stringify({
            claim: input.claim,
            ...adjudicationContext(reports, prior),
            instruction:
              "Independently adjudicate candidate evidence, duplicates and severity. Prior findings have already been revalidated by their verification task. Write concise findings using the shared policy and configured voice, then assemble_review_report. No unverified required coverage is acceptable.",
          }),
          abortSignal: abort.signal,
        });
        if (!state.report)
          throw new Error("Adjudication ended without a canonical report");
        await store.put({
          ...reportAssessmentKey(state.report),
          data: JSON.stringify(
            reportAssessmentAssociation(
              state.report,
              completed.assessments,
              prepared.reportRepositoryDigest,
              reportRevalidationProvenance({
                plan: prepared,
                priorReport: prior,
                selectedFindingIds,
                revalidatedFindings: state.revalidatedFindings,
                association: association ? JSON.parse(association.data) : null,
              }),
            ),
          ),
        });
        result.canonicalReport = state.report;
        const pending = { result, context: w.trusted, files: w.changedFiles };
        staged.set(publicationKey, pending);
        await publishStaged(pending);
        result.coverageComplete = true;
      } catch (error) {
        result.costRows = await reconcile();
        throw new QualityExecutionFailure(
          error instanceof Error
            ? error.message
            : "Production-logic evaluation failed",
          result,
        );
      } finally {
        try {
          await workspace?.close();
        } catch (error) {
          await dependencies.record?.({
            event: "workspace.cleanup-failed",
            headSha: input.headSha,
            message:
              error instanceof Error
                ? error.message
                : "Workspace cleanup failed",
          });
        }
      }
      result.costRows = await reconcile();
      return result;
    },
  };
}

/** CLI factory is loaded only after --real-model. No paid work occurs during module import. */
export function createExecutor(options: {
  repositoryPath: string;
  record: (event: unknown) => Promise<void>;
}): ReviewQualityExecutor {
  return createProductionReviewQualityExecutor({
    workspace: (input, config, secret) =>
      createVercelQualityWorkspace(
        options.repositoryPath,
        input,
        config,
        secret,
      ),
    model: (route, config) => {
      const chain = chainForRoute(config, route);
      return wrapLanguageModel({
        model: withTaskReasoning(
          gateway(chain[0]),
          reasoningForRoute(config, route),
        ),
        middleware: {
          specificationVersion: "v4",
          transformParams: async ({ params }) => ({
            ...params,
            providerOptions: {
              ...params.providerOptions,
              gateway: {
                ...params.providerOptions?.gateway,
                caching: "auto",
                ...(chain.length > 1 ? { models: chain.slice(1) } : {}),
              },
            },
          }),
        },
      });
    },
    record: options.record,
    reconcile: async (rows) =>
      Promise.all(
        rows.map(async (row) => {
          if (!row.generationId) return row;
          try {
            const observed = await gateway.getGenerationInfo({
              id: row.generationId,
            });
            return {
              ...row,
              gatewayCostUsd: observed.totalCost,
              gatewayStatus: "resolved" as const,
              gatewayLookupAttempts: row.gatewayLookupAttempts + 1,
              gatewayLastError: null,
            };
          } catch (error) {
            return {
              ...row,
              gatewayLookupAttempts: row.gatewayLookupAttempts + 1,
              gatewayLastError:
                error instanceof Error
                  ? error.message
                  : "Generation lookup failed",
            };
          }
        }),
      ),
  });
}
