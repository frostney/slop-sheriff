# Slop Sheriff validation

## Accepted scope

Own the runtime review policy, rename the repository and public branding,
provide configurable cowboy voice and clean artwork, retain the core lanes,
add spec-testing, writing-quality and test-health specialists, and show each
finding's consequence in at most 300 characters with expandable full analysis.
The initial scope excluded production deployment and paid review. Later
authorized extensions and their validation results are recorded below.

The comparison baseline is `b1e10994224000a79cae97cbc281193fd58dab13`.
The selected approach preserves Eve's authored workflow, native child sessions,
signed checkpoints, exact-head recovery and deterministic publication.

## Offline evidence

On 10 September 2026, with Bun 1.4.2, Eve 0.52.5 and AI SDK 7.0.97:

- `bun run check`: TypeScript, 265 tests, 32 native Eve runtime gates,
  discovery with no diagnostics, and production build passed.
- `bun run replay:pr61`: all four recorded finding transitions passed.
- Generated tool JSON Schema checks cover all finding categories, required
  bounded impact summaries, application-owned fields, path constraints,
  duplicate identities and specialist reports.
- The authenticated Convex memory HTTP path accepts all three new axes through
  the real internal action validators without model calls.
- A temporary mutation allowing 301-character impact summaries made three
  impact contract tests fail. The source was restored byte for byte before
  the completion gate.
- The native smoke test caught and now covers Eve's first-child timing:
  standing instructions resolve before the incoming routing message. Fixed
  child authority and an application-authored task policy cover that first
  turn; later turns use the bound role.
- A repeated smoke run exposed a fixture race in Eve's local `just-bash`
  metadata snapshot writes and concurrent reconnects. A native-backend
  regression reproduces the truncated-file failure; the fixture serializes
  only metadata lifecycle operations for the same sandbox. Review lanes and
  independent sandboxes remain concurrent; the Vercel backend is unchanged.

## Visible comments and artwork

The production presenter generated synthetic before/after examples, rendered
locally with Bun Markdown. The browser checks covered collapsed and expanded
impact, both voice settings, keyboard Enter toggling, all progress/failure
states, clean and changes-requested results, and a 390-pixel viewport with no
horizontal overflow. GitHub's own styling was not exercised by this local
render. No PR comment was posted as a test.

- [Before/after and status captures](slop-sheriff-comments.png)
- [Narrow-screen expanded impact](slop-sheriff-comments-mobile.png)

The brand image and avatar were visually inspected after removing grain,
book lettering and subtitles. The image tool does not report its model version.

## Bounded implementation review

Reviewed the complete branch and working-tree change against the accepted
scope, with reuse, claim/specification and engineering-quality coverage.
Discoverability was inactive because no public website or crawler behavior
changed. The review included config authority, old state and Check migration,
canonical identities, specialist scope, signed report assembly, Eve lifecycle,
comment escaping and the voice toggle. The Convex change only extends the
existing internal action's axis validator; storage and authorization stay on
the existing path.

The 90-day history inspection used file-level fallback for the large channel
and publication modules. Hotspots were the old standing instructions and
architecture document (19 touches each), GitHub channel (14 touches,
891 additions/110 deletions), and publication (12 touches, 1,643 additions/306
deletions). No additional architectural defect was established from churn.
The new design reuses the existing workflow and preserves migration identities.
Symbol history also covered `findingBody` (four touches, 35 additions/eight
deletions) and `fetchTrustedConfig` (one touch, 18 additions).

The review corrected the policy's location rule to allow base-side findings
for deleted files. No unresolved Blocking or Important implementation finding
remained. No Definition of Ready or Definition of Done exists in this checkout;
the declared repository gate and workflow checks were used.

## Measurement limits

The [policy inventory](slop-sheriff-policy-metrics.json) counts authored policy
text with `o200k_base`, including the first child task procedure. It excludes
framework/tool schemas, evidence, model history and provider cache effects.
This is a prompt-size comparison, not a latency, billed-token or cost benchmark.

The new lanes have deterministic routing and reporting coverage. Their
model-dependent finding quality, false positives, duplicate control and real
review completion remain unmeasured. A separately authorized real-model canary
must compare the same exact revisions and requirements, preserve canonical
finding and revalidation outcomes, and report phase latency, input/output
and cache tokens, and cost. Existing replay measurements describe recorded
production data, not observed performance of this new policy.

## Public launch extension (10 September 2026)

Reviewed the launch delta from `153174e` plus the earlier recorded runtime
review. Active axes: reuse, claim/specification, engineering quality and public
web discoverability. The extension adds a native Eve home channel, static
landing responses and image bytes, install/deployment documentation, and artwork.
It does not change review tools, lane schemas, authentication or model routing.
No outstanding Blocking or Important implementation finding remains.

`bun run check` passed 272 tests, 32 deterministic Eve runtime gates, zero
Eve discovery errors/warnings, and the production build. `bun run replay:pr61`
preserved all four recorded finding transitions. Logs are retained locally as
`/tmp/slop-sheriff-launch-check.log` and `/tmp/slop-sheriff-launch-replay.log`.

Compiled HTTP probes exercised GET/HEAD, robots and sitemap, exact asset hashes,
unknown-path rejection, and the existing Eve health route. The literal robots
route uses Rou3's literal group syntax because Eve/Nitro treated a virtual
handler ending in `.txt` as text and returned 500; the corrected compiled route
returns 200 at `/robots.txt` and rejects the literal braces URL.

Browser QA checked desktop and 390×844 layouts, loaded images, no horizontal
mobile overflow, native keyboard expansion of the example finding, and readable
installation/configuration content. The synthetic example is labelled and
contains no customer code. The hero export is 143,968 bytes; the App icon is
59,841 bytes. Social preview is 1280×640 JPEG and under 1 MB.

Production indexing requires both production deployment metadata and the exact
canonical hostname. Preview, local, candidate, and old aliases remain noindex.
Documentation links accept only a 40-hex deployment revision before embedding
it in the GitHub URL. Asset equivalence checks reject stale generated bundles.
The native JSON import is necessary because source-relative file reads fail
when Eve relocates authored modules; no second web framework was introduced.

A 90-day file-history review found README changes across 15 commits, primarily
accumulated feature documentation; deployment guidance had one prior addition.
The landing module/channel/tests are new. No recurring repair pattern or mixed
runtime responsibility was found in the added module. Earlier runtime churn
and review evidence remain in the preceding sections. Hosted rollout and the
single paid pilot are separate validation stages, not inferred from these checks.

## Self-review pilot and evidence repair (10 September 2026)

The public site and renamed App were deployed from `1dedabe9fdf8b3a0a8f3cd4d87167590278f1225`.
Both public domains passed health checks; the new domain has canonical indexing
and the old alias remains noindex. The existing App and Vercel project retained
their identities and credentials. The App icon and repository social image were
saved. Actions read access and access to this repository were explicitly approved
for the pilot.

The one paid advisory pilot failed. All seven lanes rejected the prepared
evidence packet with `Prepared evidence components failed ledger validation`.
The resulting missing checkpoint caused the authored workflow's output-schema
failure. The bot published an incomplete summary and action-required Checks,
without a finding verdict. Root execution lasted 125.851 seconds; common
preparation took 51.524 seconds and the authored workflow call 39.882 seconds.
These are failure timings, not a completed-review benchmark.

The regression now runs real Git preparation through lane packet reads, with
included source, generated files and a binary image. It reproduced the same
ledger rejection before the fix. Excluded entries were hashed before schema
parsing changed their property order; readers hashed the parsed representation.
Preparation and digest boundaries now use the same schema-parsed manifest.
All seven lane packets and prepared-snapshot reuse pass. Changed evidence still
fails validation. The previous empty-manifest tool fixture missed this boundary.

`bun run check` passed 272 tests, 32 native Eve gates, zero discovery diagnostics
and the production build after the repair. `bun run replay:pr61` preserved all
four recorded finding transitions. The bounded repair review covered reuse,
the exact failure claim and integrity enforcement; no unresolved Blocking or
Important repair finding remains. The 90-day Git history shows earlier evidence
preparation and concurrency changes; this fix changes no lane contract, model
routing or publication behavior. The guide also now selects the unmerged launch
candidate explicitly and treats installation events as automatic subscriptions.

Observed SDK usage for the pilot was 349,921 input and 10,103 output tokens,
with 282,363 cache-read and 67,460 cache-write tokens included in the input total,
costing $0.3153972. The separate draft-transition turn added $0.007178. Fifteen
generation reconciliations remained unresolved at collection time, so these
are observed SDK totals, not certified billing. Cancelled requests may have
unreported usage. The draft turn attempted cleanup, which the trusted-plan guard
rejected before sandbox access; no sandbox-stop failure was observed.

PR42 was returned to draft and the App's access to this repository was removed
after assessment, pausing automatic self-review. Its access to pascal-mcp-sdk
and Actions read permission remain. No second paid review or merge was performed.
Review quality, complete delivery, latency and token savings remain unproven;
another paid pilot needs separate authorization and restored repository access.

## Coordinator quota repair (11 September 2026)

The user authorized a second review on `47f820b`, then explicitly asked for
end-to-end repair and review completion. All seven lanes completed on the
second run, but the coordinator stopped before reconciliation: Eve charged
10,283,914 input tokens against the application's 8,000,000-token override.
The completed workflow itself returned only a compact receipt; the coordinator
had made 37,778 input tokens of its own calls. The failure was the inherited
whole-tree quota, not another evidence-ledger or workflow-awaiting failure.

The native mock runtime now reports the recorded descendant input through a
completed child and requires the same parent to execute its next tool and
finish. Before the fix, `bun run test:e2e:mock` failed the completion and tool
assertions. It passes after removing the custom input override and inheriting
installed Eve 0.52.5's documented 40,000,000-token root default. The separate
512,000-output-token guard, dispatch window, signed coverage and fail-closed
publication remain. This changes execution capacity, not review coverage or
quality criteria, and makes no token-saving claim.

The native test replaces seven tests that duplicated budget arithmetic and
assumed a four-lane fan-out. The updated suite passes 265 unit/integration tests
and 35 native Eve gates. The PR61 replay still preserves all four transitions.
The live retry and completed delivery must be verified separately after deploying
the exact repaired commit. Local evidence is in `/tmp/slop-sheriff-budget-red.log`,
`/tmp/slop-sheriff-budget-check.log` and `/tmp/slop-sheriff-budget-replay.log`.

## Completed self-review and finding repairs

The deployed `d48ea81` review completed all seven lanes and publication on
11 September 2026. Run `wrun_41M26WMZJ20GS9F5QZ5X018GG9` delivered all six
findings inline: two Important and four Improvements, with no Blocking finding.
The aggregate check reported `REVIEW COMPLETE` with an advisory neutral result.
The successful continuation confirms the repaired root quota boundary for this
run; it does not establish quality parity or token savings.

All six findings were verified against the candidate. Follow-up repairs bound
serialized evidence packets, including omitted and excluded metadata, JSON
escaping, obligations and continuation bookkeeping. Regressions reproduce both
metadata and escaped-text overflow, then prove complete ordered coverage,
idempotent recovery and lossless Unicode patch reconstruction across packets.
The public aliases allow crawling so their noindex directive can be observed.
Unversioned images use a one-hour cache lifetime and content-hash ETags. The
compiled Eve smoke now imports the production home channel and exercises public
GET and HEAD routes, including the literal-brace route failure case. Ambiguous
trusted-base and initial-scope wording was also clarified.

The hosted review reported sandbox capability limitations, including missing
Bun/dependencies and runtime/browser evidence. Those limitations remain explicit;
local and CI checks provide separate validation, not proof that its behavioral
specialist checks executed successfully in the review sandbox.

The repair candidate passes `bun run check`: TypeScript, 269 tests, 92 native
Eve gates, discovery without diagnostics and production build. The recorded
PR 61 replay preserves all four canonical transitions.

## September 12: production integration of the agreed review design

This revision implements the accepted grilling decisions in the application,
not just the earlier isolated custom-lane feasibility probe.

- Findings use severity emoji, a severity-only line, a 25–45-word introduction,
  expandable evidence/principle/remedy, and visible Impact and Risk. The complete
  comment remains within 200 words; Impact remains within 300 characters.
- The model receives technically fluent cowboy-robot instructions with theatrical,
  understated and off presets, plus a trusted-base custom voice guide. No runtime
  opener table supplies personality. The historical PR42 finding in the landing
  page uses the same formatter. See [all three examples](../review-examples.md).
- Trusted configuration creates independently named project lanes in the standard
  application. Routing, evidence, signed checkpoints, recovery, schemas, reports,
  memory validation and GitHub Checks recognize their bounded registry. The native
  Eve fixture exercises two project lanes through the production workflow.
- Shared base/head requirement inventory includes relevant unchanged and linked
  documents, DoD and configurable paths. Explicit checklist and normative clauses
  carry individual evidence obligations. Required unverified checks block completion.
- New-head state immediately withdraws old merge clearance. Authorized explicit
  maintainer dismissals preserve attribution, remain distinct from verified fixes,
  and survive matching later reviews. Model revalidation cannot forge dismissals.
- Incomplete lockfile changes now receive conservative specialist coverage.
  Failure continuation reconstructs specialist selection details from the trusted
  configuration. Browser setup uses the installed native helper's version default.

Validation on Bun 1.4.2, Eve 0.52.5 and AI SDK 7.0.97:

- `bun run check`: both TypeScript projects, 347 tests with 1,860 assertions,
  102/102 deterministic native Eve runtime gates, clean discovery and production
  build passed.
- `bun run replay:pr61`: all four recorded finding transitions preserved.
- Browser checks verified collapsed/expanded details, keyboard activation, all
  three voice examples and visible Impact/Risk. The 390px mobile page measured
  390px document width, with no horizontal overflow.
- The revised square robot icon was checked at 20, 24, 40, 64 and 128 pixels in
  square and circular crops. Website asset export contains the new icon.

Rendered evidence: [comments](assets/review-comments.png),
[mobile landing](assets/landing-mobile.png), [avatar crops](assets/avatar-crops.png).

This round ran no paid model review. Deterministic workflow checks establish the
application contract, not model quality or comparative speed, token use or cost.
Production still needs a rollout of this generic capability. The GitHub App icon
upload requires fresh GitHub security authentication. The previously identified
sandbox outbound-access finding remains unresolved; this PR is not certified for
production or merge readiness by these implementation checks.
