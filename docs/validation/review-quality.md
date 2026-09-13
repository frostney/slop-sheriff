# Review quality and lifecycle economics

The agreed target is **under $1 for a routine initial review plus its ordinary
updates**, with required coverage and testing preserved. This is a measured
engineering target, not a runtime spending, token, time or diff-size cutoff.
Above-target results require investigation and optimization. Stopping a test at
a dollar threshold cannot prove an efficient complete review.

## Current evidence

Task routing and the production-logic evaluation harness are validated offline. The candidate
default models have **not** passed a paid quality comparison. No result in this
document certifies review quality, lifecycle price, rollout readiness or parity.

On 2026-09-13 the [official Gateway catalog](https://ai-gateway.vercel.sh/v1/models)
listed `openai/gpt-5.6-luna` at $0.20 input / $1.20 output per million tokens and
`openai/gpt-5.6-sol` at $2.00 / $10.00, before long-context/provider differences.
Those rates informed candidate selection, not a quality conclusion. Refresh the
catalog before comparisons. Never infer total cost from input price alone.

Scout evidence gathering uses the triage task with low reasoning. Presentation uses
low reasoning only after the application verifies exact prior report/assessment
reuse, including a prior clean report. Normal coordinator work uses adjudication. Routine analysis,
verification and adjudication use Luna with medium reasoning. Claim/specification,
test-against-spec and test-health units select the verification task override. Application-owned
ambiguous evidence selects high reasoning; conflicting evidence selects xhigh.
Unconfigured tasks escalate to Sol. Fresh continuation count alone never
escalates. The application must classify ambiguity from the work record; text in
PR evidence cannot select its own model or effort.

Explicit existing `model` and `agents` settings retain their model chains.
An explicit task setting takes precedence. Escalation preserves an explicit
repository model unless that task supplies `escalationModel`. Existing scalar
`agents` continues to mean all subagents, and the existing scout override remains
supported. Presentation configuration is independent from analysis validity.

```yaml
tasks:
  triage:
    model: openai/gpt-5.6-luna
    reasoning: low
  analysis:
    model: openai/gpt-5.6-luna
    reasoning: medium
    escalationModel: openai/gpt-5.6-sol
    escalationReasoning: high
  verification:
    reasoning: medium
  adjudication:
    reasoning: medium
    escalationReasoning: xhigh
  presentation:
    reasoning: low
```

Installed Eve 0.52.5 provides a static top-level reasoning setting and supports
live models returned from `step.started`. Official AI SDK middleware applies
task effort to the provider-agnostic request after the static setting. Tests use
`MockLanguageModelV4`, Eve's actual generated child input and durable hydration,
and raw HTTP through the installed Gateway provider. They prove routing and
transport, not how well a model reviews code.

## Corpus

The exact base/head pairs and parent-linked sequences are in
[`review-quality-corpus.ts`](../../src/evaluation/review-quality-corpus.ts).

| Case                                                                         | Work                                                | Revisions             |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | --------------------- |
| [GocciaScript #1238](https://github.com/frostney/GocciaScript/pull/1238)     | Pascal worker fix, ABI and regression sensitivity   | `39babf0` → `d56fa99` |
| [known-good-route #59](https://github.com/frostney/known-good-route/pull/59) | Three Markdown files matching an existing CLI       | `08709a5` → `c58c44b` |
| [Slop Sheriff #37](https://github.com/frostney/slop-sheriff/pull/37)         | TypeScript dependencies, lockfile, APIs and CI      | `4efcece` → `062a641` |
| [Slop Sheriff #38](https://github.com/frostney/slop-sheriff/pull/38)         | Orchestration refactor and native runtime tests     | `4d0c345`             |
| [Lantaarn #9](https://github.com/frostney/lantaarn/pull/9)                   | Pascal wire validation and a real stack base update | `0be99f4` → `2c20bf9` |
| [Gravelbyte #4](https://github.com/frostney/gravelbyte/pull/4)               | C++ saves/recovery, browser controls and tests      | `4bb99f5`             |

The routine seeded control contains two independent JavaScript components, one
port-boundary defect and its correction. Its frozen external Node oracle proves
that accepting port 65536 violates the documented 1–65535 range and that the fix
restores this obligation. The oracle and labels are never committed to the bundle
sent to a reviewer. This is a targeted clean control, not a claim that the
corrected repository has no other defects.

[Slop Sheriff #43](https://github.com/frostney/slop-sheriff/pull/43),
`b204ca3` → `98c4114`, is a separate cross-cutting migration stress cohort.
Its work spans review lanes, output and recovery; it is excluded from routine
cost aggregates before evaluation, independently of any observed price.

No exhaustive finding set has been adjudicated. Historical comments and fixes
are leads for independent adjudication, not automatic gold labels. In particular,
GocciaScript's initial-head review and correction are available for the sysconf
return-width and real-CLI-test concerns. Keep the later correction and comments
outside earlier-head reviewer inputs.

Corpus claims are conservative descriptions of the original work. Preparation
reads immutable Git objects at the selected pair. It never reads current PR
bodies, current working-tree files, later commit messages or review comments.
The strict input contract rejects unrecognized fields, including future labels.
An adapter must preserve that isolation when collecting supporting sources.
The known-good-route example is input data and confers no runtime authority.

Commit order does not prove original push/webhook timing. Duplicate events,
pushes during unfinished work, worker loss and publication failures belong in
explicit replay schedules. Single-commit cases have no claimed historical delta.
Lantaarn's first revision and later merge have different base pairs. Platform and
device claims require the matching runtime evidence, not a host-only substitute.

## Running the harness

List the fixed corpus without credentials or model calls:

```sh
bun run scripts/evaluate-review-quality.ts
```

Measure exact text inputs from a checkout containing both historical commits:

```sh
bun run scripts/evaluate-review-quality.ts \
  --case sheriff-dependencies --repository /path/to/slop-sheriff
```

This remains a dry run. It fetches only the public model catalog. Use `--catalog`
with a saved catalog JSON for offline operation, and `--config` for the trusted
routing configuration being compared. It builds the real component plan from
exact Git trees and measures each unit's packet, production orchestration message,
turn policy and generated tool schemas. A three-step read/write/final-output
protocol gives a known input subtotal. Extra investigation, report replay,
continuations, provider framing and actual outputs remain unknown. The displayed
1,000 and 4,000 output-token scenarios are sensitivity calculations, not observed
outputs, a promise or a runtime allowance. No reuse is assumed during dry planning.

Start the controlled initial/fix case without a repository path:

```sh
bun run scripts/evaluate-review-quality.ts --case seeded-port-boundary
```

The September 13 dry plan projects $0.045 for the known protocol inputs across
both revisions, including all 14 work units and both adjudications. Adding the
stated output scenarios gives $0.064 to $0.122 in partial model subtotals.
Investigation/revalidation, model-authored text replay, additional calls, actual
provider tokenization, retries/escalation and infrastructure are excluded. The
lifecycle total and the under-$1 target therefore remain unverified. Refresh
these projections when policy, schema, plan or catalog changes.

The representative dependency-change case (#37) selects 34 initial units and
57 update units in its dry plan. Without assuming reuse, known protocol inputs
project about $0.411, and the same output scenarios yield partial subtotals of
$0.523–$0.857 before the unmeasured work. This does not meet or fail a measured
lifecycle target. It shows why the seeded control alone cannot establish the
routine target and why actual reuse and useful unit selection need evaluation.

Paid execution requires explicit opt-in and an output artifact:

```sh
bun run scripts/evaluate-review-quality.ts \
  --case seeded-port-boundary --real-model \
  --output .agent/review-quality-seeded.json
```

The built-in adapter uses actual AI SDK `ToolLoopAgent` calls, production model
routing/reasoning/fallback options, the component planner, source observations,
shared executable probes, signed work persistence, progress continuations,
escalation, coverage aggregation, compact adjudication and canonical report
assembly. Verification of prior findings uses its own routed task. Production
`publishReview` sends Octokit requests into a stateful local GitHub HTTP sink.
The real-model workspace uses the same native Eve/Vercel VM backend and locked
dependency acquisition as production; credentials remain outside the workspace.
The execution VM has deny-all networking and this adapter exposes no live web
reference tool. Declared dependency acquisition uses the production separate
acquisition environment. This is a frozen-source guarantee; an adapter adding
networked public-interface probes must separately prevent access to later PR
comments, mutable branch heads and other answer-bearing future evidence.
Only exact base/head commits and ancestors are uploaded. Future fix commits,
local branches, current PR comments and uncommitted files are excluded.

This is production-logic evidence, not complete hosted fidelity. Native Eve child
hosting and workflow durability, Convex transport/admission, GitHub server
permissions, exact-head CI collection and memory retrieval are substituted.
The Git inventory currently includes all changed patches rather than applying
production trusted-base generated/vendored classification. Browser commands can
run as real probes, but native image/reference tool transport is not covered.
Do not certify visual or hosted permissions behavior from this adapter alone.
Native deterministic Eve smoke tests and an authorized hosted canary remain
separate required evidence.

`ReviewQualityExecutor` in
[`review-quality.ts`](../../src/evaluation/review-quality.ts) remains the adapter
contract. `--executor /path/to/module.ts` can select an alternative, whose default
export implements `kind` and `execute(input, config)`, or whose `createExecutor`
factory accepts `{repositoryPath, record}`. Adapter modules are not loaded during
dry runs. A text-only or assessment-only adapter cannot certify lifecycle cost.

Every provider start and result is appended to the adjacent `.events.jsonl`
artifact before progressing. The ledger retains failed model attempts, available
Gateway generation IDs, tokens, cache use and phase timing. Generation billing
lookups leave unavailable charges unknown. Publication retries reuse the staged
canonical report without model calls. In this isolated adapter the work and
publication stores are process-local; crash survival is native runtime evidence.
Sandbox/infrastructure billing is currently unknown, so a resolved model subtotal
alone never produces a successful whole-lifecycle target result.

Offline tests run actual frozen Git checkouts, an independently verified defect
and corrected control, actual Node boundary probes, official mock model transport,
retained progress and final-output steps, cross-head reuse of the unchanged
component, full/delta cost rows including a failed provider retry, stable open-to-fixed findings, thread resolution,
and a failed GitHub publication followed by recovery with zero further model
calls. An unchanged-head voice change reuses the exact verified assessment set and
its signed association to the published report, retains the open finding status,
and calls only the coordinator for presentation. Changed work still requires
finding verification. Mock findings are predetermined protocol fixtures and prove no real-model
finding quality.

The runner verifies result/cost identities, retains incomplete/failed status,
and keeps unresolved billing unknown. Quality remains unknown until independent
adjudication establishes material finding coverage, false positives, duplicates,
evidence correctness and fix/revalidation outcomes. Passing offline tests or a
cheap assessment-only probe cannot substitute for that evidence.

Before selecting release defaults, compare the same frozen lifecycle schedules
across candidate routes and the prior quality reference. Include cached and
uncached initial work, ordinary updates, an update before initial completion,
dependency/requirements invalidation and failed attempts. Report elapsed time,
complete billing, tokens/cache, retained work, coverage and adjudicated quality
together. Leave every unavailable measurement unknown.

## Claim normalization boundary

Current raw claim changes conservatively invalidate technical assessments. A
future normalization step should retain exact original text for audit, extract
versioned technical obligations separately from formatting/presentation, and
bind each obligation to affected units with authenticated application metadata.
Reuse would require unchanged obligation meaning plus existing source/probe
validation. Ambiguous or conflicting edits must invalidate affected work. A model
summary alone cannot erase a requirement or grant reuse authority. This is a
follow-up design boundary, not implemented claim-equivalence behavior.
