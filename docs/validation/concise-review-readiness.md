# Concise review and executable evidence validation

Validated 11 September 2026 against base `35c0e63`. This follow-up implements
shorter comments and landing copy, content-based specialist selection, shared
tool installation, and verified bot-thread closure. It does not claim measured
model-quality, latency, token or cost improvements.

## Observed checks

- `bun run check`: 331 tests, 95 deterministic Eve runtime gates, discovery with
  zero errors, TypeScript and production build passed without provider credentials.
- `bun run replay:pr61`: all four recorded review lifecycle transitions preserved.
  Its timing projections remain offline projections, not new measurements.
- Landing: 326 visible words; authentic PR42 finding rendered by the same semantic
  formatter as GitHub. The example contains 63 words and a 153-character Impact.
  Desktop (1280px) and mobile (390px) browser checks found no overflow, missing
  images or console errors.
- Actual Node execution proves engine-range selection does not depend on Bun
  globals. Local subprocess tests install locked dependencies, preserve tool PATH
  across shells, select pinned package-manager versions, and reject tracked-file
  modification by dependency lifecycle scripts.
- Actual Octokit HTTP fixtures exercise head changes, human-thread isolation,
  profile-hidden findings, persistent runtime evidence requirements, partial
  delivery failures, retry without duplicate replies, and corrected revalidation
  after rejected overlong or unsupported results.

## Hosted setup

A fresh Vercel sandbox using Eve's pinned `0.52.5` base image and the final
restricted network policy completed bootstrap, Node `24.21.0`, Bun `1.4.2`,
frozen repository dependencies, and native `agent-browser 0.37.1` installation.
Chromium opened and closed successfully; 39 landing, specialist and thread
contract tests passed at target `ff30cad`. Total observed setup and probe time
was 147,436 ms. The probe used detached command streaming like Eve and called
no model. The sandbox and its orphan snapshots were deleted afterward.

The final setup uses HTTPS apt mirrors, IPv4 transport, bounded network retries,
fresh application-owned indexes, and Chrome's official manifest/download hosts.
Earlier cold runs stalled; these observations do not isolate one setting as the
cause or prove latency parity. One diagnostic refresh interfered with another
installer's archive cleanup; that run was discarded and the successful probe
ran without competing package operations.

## Historical thread repair

PR42's exact merged head `2c500ed73a116935593b7d070f1a9b49292ad316` passed
19 focused tests and all 92 compiled Eve gates in an isolated archive. Seven
original Slop Sheriff findings received short, commit-linked fix acknowledgements.
GitHub initially rejected resolution with `FORBIDDEN`; after the owner approved
Contents write and accepted the installation update, all seven threads resolved
successfully. Retrying reused the existing acknowledgements. No model was called.

## Bounded review

The integration pass corrected a workflow import of `node:crypto`, Node production
use of Bun-only semver, forgotten setup receipts on old ledgers, runtime-fix
validation after immutable recording, and the cowboy opener's character budget.
Hosted validation caught unsupported IPv6 CIDRs and HTTP apt mirrors incompatible
with the domain firewall. The final policy uses supported private IPv4 exclusions
and HTTPS official apt mirrors while preserving credential-free package traffic.
APT pipelining is disabled for the sandbox firewall, and failed index refreshes
stop installation instead of silently using stale indexes.

The 90-day history covered every changed file, following renames. Highest code
churn was the GitHub channel (15 touches, 916 additions/152 deletions), publication
(13; 1675/333), and review state (9; 214/31). Stable-symbol history for
`replyAndResolveFinding` had one prior touch (39 additions); `prepareReviewEvidence` had six
(271 additions/31 deletions). Remaining symbols used file-level fallback. These hotspots informed the delivery recovery and
trusted-state tests; churn alone was not treated as a defect.

## PR43 production failure and recovery

The ready-for-review event ran production deployment
`dpl_7RADrpRv2KFeUz1UmALKNeMJGeEF` from base commit `35c0e63`, reviewing candidate
`6fd33c2`. The candidate's setup and presentation changes were not deployed.
Session `wrun_41M28BEBBH0GH8CSPEWW0VCP2R` stopped on 11 September 2026 at
13:48 UTC with five completed axes and no published verdict.

The discoverability scout ended with prose instead of the requested structured
result. Eve emitted `OUTPUT_SCHEMA_NOT_FULFILLED`; `ctx.agent` rejected with
a serialized `SUBAGENT_EXECUTION_FAILED` envelope carrying that exact message. The fail-fast orchestration discarded
its waiting hook while engineering quality was still completing. This was an
execution failure, not a negative review verdict or successful coverage.

The regression uses that recorded error envelope and a native Eve `mockModel`
scout that stops with prose. Scout policy now explicitly requires `final_output`.
One output-contract retry uses a new dispatch key within the existing ceiling;
other failures remain terminal, and failed evidence never becomes a successful
receipt. All dispatched siblings settle before orchestration reports failure,
so their durable checkpoints remain available to recovery. Exact request identity,
checkpoint signatures and final report validation remain required.

The booking URL remains absent until the owner creates it. Provider-free checks
prove error recovery and contract preservation; live model quality still requires
a deployed candidate and a deliberate paid canary.
