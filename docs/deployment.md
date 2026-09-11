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

`vercel.json` sets the production Build Command to `bunx eve build` so a Vercel
Git deploy can publish the Eve/Nitro output when the production
`CONVEX_DEPLOY_KEY` lacks `deployment:data:view` (Convex CLI 1.45 refuses the
push without it). Restore the combined command
`bunx convex deploy --cmd 'bunx eve build'` in `vercel.json` once the deploy key
grants both `deployment:deploy` and `deployment:data:view`, or run
`bunx convex deploy` separately when the Convex schema changes. Use a separate
Convex deployment for ordinary previews.

The Slop Sheriff release adds allowed review-axis values to the existing Convex
schema. It does not repeat the earlier staged-memory migration. The app-first
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

## One advisory self-review pilot

The approved launch pilot extends PR42 and deploys its validated candidate
before merging. There is no merge authorization. After exact-head CI and
production validation pass, make PR42 ready once. That transition is the single
paid trigger; do not also post a manual full-review command.

Freeze the head and deployments while the review runs. Confirm the repository
is included in the existing App installation and trusted-base policy remains
advisory. Observe completion, exact-head publication, all required lane coverage,
canonical finding identities, duplicate and false-positive control, impact
summaries, concise inline comments, and verified thread resolution. Failure or missing coverage is not completion.
Return PR42 to draft after the terminal result before pushing any follow-up fix.
Assess the result before enabling ongoing automatic self-review.

Record start/end times, head and base SHAs, deployment IDs, provider versions,
requested/resolved models, phase latency, input/output/cache tokens, Gateway
cost, and unresolved accounting. Deduplicate model-call identities and preserve
cache-inclusive SDK totals separately from Gateway-native usage. Keep secrets,
raw credentials, and private prompt contents out of the evidence record.

One pilot measures that run. It does not establish performance or quality parity,
or justify another paid run without authorization. A deterministic mismatch
must be reproduced and fixed offline before another live attempt.

## Recovery

Do not roll back the app to a schema-incompatible version. For this additive-axis
release, examine any reports already written with new axes before reverting
readers or validators. Preserve signed evidence, revocation records, and review
state. A failed deployment should leave the prior production candidate serving;
verify provider state rather than assuming rollback succeeded. Repair forward
when compatibility cannot be established.
