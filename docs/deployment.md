# Deployment and live validation

For a new installation, follow [self-hosting setup](install.md). For an existing
installation, preserve the Vercel project, Connect connector, GitHub App and
installation identities, Convex deployment, evidence key, and shared memory token.
Verify their IDs through authenticated provider access before changing settings.

## Release gate

The exact release commit must pass `bun run check` and `bun run replay:pr61`.
CI uses the Bun version pinned in `package.json`. Generated tool-schema and
report-assembly checks must pass before any live review. Offline replay preserves
four recorded finding transitions; it does not prove current model quality.

The local build skips sandbox prewarming. Production must run `bunx eve build`
without `--skip-sandbox-prewarm`, with permission to create sandbox templates.
The current combined build is `bunx convex deploy --cmd 'bunx eve build'`.
Use a separate Convex deployment for ordinary previews.

This release adds durable lifecycle, artifact and cost ledgers alongside the
existing Convex memory schema. It does not repeat the earlier staged-memory migration. The app-first
migration and drain procedure from PR36 is historical; consult that revision
only when changing those incompatible contracts again.

## Rename an existing installation

Rename the existing Vercel project and GitHub App registration. Do not replace
them or rotate credentials just to change the brand. Pin `GITHUB_BOT_USER_ID`
to the existing App's immutable bot ID before changing its registered name.
Keep opaque connector UIDs and `KNOWN_GOOD_REVIEW_*` environment variables.

Verify the new domain, old aliases, App ID, bot identity, installation access,
and Connect project/path after the change. Do not assume old App URLs redirect.
Update the App homepage, repository homepage, icon and social preview. Required
Checks using the old name need a deliberate owner update; the bot never edits
branch protection. Reviews remain advisory unless trusted-base config says otherwise.

## Candidate rollout and routing

Build the exact CI-green candidate with production settings and a full hosted
sandbox prewarm. A production candidate may be staged with Vercel's
`--prod --skip-domain`; verify it before promoting its production aliases.
Keep the runtime and Convex schema compatible throughout this operation.

Installed Eve 0.52.5 pins new Workflow starts to `VERCEL_DEPLOYMENT_ID`, and
accepted starts retain the accepting deployment. Existing runs remain pinned
to their original deployment. Record actual Workflow deployment IDs rather
than inferring them from the domain. Connect forwards to the project at
`/eve/v1/github`; verify which production candidate is serving that route.

Inspect active sessions before promotion. Old sleeping timeout helpers alone
do not prove that a review is running. Do not cancel unrelated work, detach
Connect, or return maintenance errors as an event-preserving pause: forwarding
has bounded retries, not a documented lossless queue.

### Protected candidate access

A protected production candidate can reject a local development OIDC token
before the app receives it. Use an existing authorized automation bypass,
signed-in browser, or production workload OIDC token. Do not disable deployment
protection for a probe. Require ready health and valid production agent info;
keep probe credentials out of logs, artifacts, and repository sandboxes.

After promotion, verify the public alias's deployment ID and landing metadata,
the authenticated Eve surface, and Connect routing. Public landing assets must
not expose sessions or create model work. Preview and local pages remain
`noindex`; only the canonical production hostname is indexable.

## Supervised self-review validation

Deploy the repaired candidate before pushing the pull-request branch. A push to
an open, ready PR is already a review trigger. Do not also post a full-review
command unless inspection proves that no current review was admitted, or an
explicit full review is needed. Do not toggle draft state to manage production
reviews. Newer commits supersede obsolete work through the review lifecycle.

The initial PR42 pilot was advisory. The current PR43 reliability validation
covers a full review followed by a delta, valid finding fixes, thread
reconciliation and billing. It does not authorize merging or changing payment
settings. Verify the existing Gateway credential is available before a paid
canary; account credit and a key's own availability are separate prerequisites.
A rejected credential is an operational interruption, never a completed review.

`REVIEW_EXECUTION_CAPACITY` sets concurrent review roots, defaulting to four.
The queue rotates across repositories. This controls execution concurrency and
does not truncate investigation or impose a spending limit.

Account credit recovery is checked without model calls. Key-budget failures
require key-specific evidence: account balance alone is insufficient. Current
automatic recovery recognizes a changed credential with successful authenticated
metadata access. A same-key scheduled reset must be verified by the operator
before an explicit retrigger; it is not yet detected automatically.

Observe exact-head publication, all required lane coverage, canonical finding
identities, duplicate and false-positive control, concise inline comments, and
verified thread resolution. Failure or missing required verification is not
completion. A green aggregate Check alone does not establish finding quality.
Inspect the actual comments and all finding dispositions.

Record start/end times, head and base SHAs, deployment IDs, provider versions,
requested/resolved models, phase latency, input/output/cache tokens, Gateway
cost, and unresolved accounting. Keep attempt totals, full-plus-delta lifecycle
totals and API-key cumulative spend separate. Include failed provider attempts
and compaction. Deduplicate model-call identities and preserve cache-inclusive
SDK totals separately from Gateway-native usage. Keep credentials and private
prompt contents out of the evidence record.

The next rollout stage is 30+ repositories. Validate a representative burst,
overlapping pushes and injected failures offline before deployment, then assess
observed review quality and actual full-plus-delta costs before expanding.
There are no arbitrary spending, token, time or diff-size acceptance caps.
Any deterministic mismatch must be reproduced and fixed offline before another
paid attempt; a canary validates the release rather than discovering contracts.

## Recovery

Do not roll back the app to a schema-incompatible version. For this additive-axis
release, examine any reports already written with new axes before reverting
readers or validators. Preserve signed evidence, revocation records, and review
state. A failed deployment should leave the prior production candidate serving;
verify provider state rather than assuming rollback succeeded. Repair forward
when compatibility cannot be established.

## Public domain

The canonical public address is `https://slop-sheriff.dev`. `www.slop-sheriff.dev` permanently redirects to that address. The existing Vercel
project owns the domain, and GitHub's repository and App homepages point there.
`src/landing/page.ts` supplies the shared origin for canonical, social-image and
sitemap URLs. Only that exact hostname on a production deployment is indexable.
The previous Vercel hostname remains an operational alias with noindex, allowing
existing links and integration routes to keep working during migration. Connect
callback and webhook URLs remain provider-managed endpoints.
