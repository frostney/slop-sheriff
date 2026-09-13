# Put a sheriff on your pull requests

Slop Sheriff is self-hosted. You run your own GitHub App, Vercel project,
Sandbox, AI Gateway account, and Convex deployment. Model calls, sandbox compute,
storage, and hosting are charged to those accounts. The public website does not
accept hosted installations.

## 1. Get the code and validate it

Fork [frostney/slop-sheriff](https://github.com/frostney/slop-sheriff), then clone
your fork. Install the Bun version pinned in `package.json` (currently 1.4.2)
and Node 24 for the deployed Eve runtime.

```sh
git clone https://github.com/YOUR-ACCOUNT/slop-sheriff.git
cd slop-sheriff
# Launch candidate: PR42 is deployed before merging into main.
git fetch https://github.com/frostney/slop-sheriff.git refs/pull/42/head
git switch --create slop-sheriff-launch FETCH_HEAD
git push --set-upstream origin slop-sheriff-launch
bun install --frozen-lockfile
bun run check
bun run replay:pr61
```

These checks do not spend model credits. Real reviews do. Keep your first test
pull request in draft until the production setup is complete.

## 2. Create your infrastructure

Import your fork into a Vercel project in your own team. Set its production
branch to `slop-sheriff-launch` for this candidate. Select Node 24 and Bun.
Link the local checkout with `bun x vercel link`, selecting that existing project.
Use `bun x convex dev` to create and configure your own Convex project and generate
its bindings. Stop the development watcher when setup is complete.

In Vercel's project settings, set the production build command to:

```sh
bunx convex deploy --cmd 'bunx eve build'
```

Add the production Convex deploy key as `CONVEX_DEPLOY_KEY` in Vercel's production
build environment. Configure previews with a separate Convex preview deployment;
do not point routine preview builds at your production backend. The hosted build
must permit Eve to prewarm its Vercel Sandbox template. The local `bun run build`
intentionally skips this paid infrastructure step.

Enable AI Gateway for your Vercel team and choose supported models with tool use.
The Vercel runtime uses OIDC for Gateway access. Convex runs outside Vercel and
needs its own `AI_GATEWAY_API_KEY` in the Convex production environment.

## 3. Provision your GitHub App through Connect

Use the Vercel CLI's Connect flow from the linked checkout. Pick a unique App
name belonging to your deployment. This is the provisioning surface used by
installed Eve 0.52.5, without replacing Slop Sheriff's authored GitHub channel.
Do not run `eve add channel/github` or its setup-only continuation in this
checkout: the generic setup writes `agent/channels/github.ts`.

```sh
bun x vercel connect create github \
  --name YOUR-UNIQUE-SHERIFF-NAME \
  --triggers --trigger-path /eve/v1/github \
  --trigger-event pull_request \
  --trigger-event issue_comment
```

Complete the GitHub registration steps offered by Connect. Record the connector
UID, such as `github/your-unique-sheriff-name`, and attach it to your production
project if the creation flow has not already done so:

```sh
bun x vercel connect attach YOUR-CONNECTOR-UID \
  --project YOUR-VERCEL-PROJECT --environment production \
  --triggers --trigger-path /eve/v1/github
```

Verify the App has repository metadata and Actions **read** access,
and contents, pull requests, issues, and Checks **read/write** access.
GitHub requires Contents write to resolve verified fixed review threads; the
application exposes no push or merge tools. For existing installations, accept
the permission update in GitHub installation settings. GitHub sends
`installation` and `installation_repositories` events to Apps automatically;
they cannot be selected as manual subscriptions. Verify Connect forwards those
lifecycle events as well as PRs and comments to the production project. Keep
App credentials in Connect; repository sandboxes must never receive them.

Use the App settings' installation page to install **your** App on selected
repositories. Slop Sheriff's own App is not a public hosted service. Obtain the
App's immutable bot user ID from GitHub's user API for `YOUR-APP-SLUG[bot]`, or
from its published Check/comment author metadata. Configure that numeric ID
before reviewing: a custom App name cannot use the legacy login fallback.

## 4. Configure the app and memory

Set these values in Vercel's production environment. Keep local values in the
ignored `.env.local` file; `.env.example` lists names without credentials.

| Variable | Value |
| --- | --- |
| `KNOWN_GOOD_REVIEW_GITHUB_CONNECTOR` | Your Connect connector UID, not this project's legacy default |
| `GITHUB_BOT_USER_ID` | Your App's immutable numeric bot user ID |
| `KNOWN_GOOD_REVIEW_EVIDENCE_KEY` | 32 random bytes encoded as 64 hexadecimal characters; app only |
| `CONVEX_MEMORY_URL` | Your production Convex HTTP-actions URL, ending in `.convex.site` |
| `KNOWN_GOOD_REVIEW_MEMORY_TOKEN` | A random bearer token shared by this app and your Convex deployment |
| `CONVEX_DEPLOY_KEY` | Your production Convex build credential |

Set `KNOWN_GOOD_REVIEW_MEMORY_TOKEN` to the same value in Convex, and set
`AI_GATEWAY_API_KEY` there. Preserve the evidence key across deployments and
replicas. Generate and store secrets through your normal password manager or
provider environment controls; never commit them or copy them into a sandbox.

## 5. Choose the review policy

Merge this file into the **base branch** of each repository before opening a
reviewable test PR. The bot never trusts configuration proposed by the PR itself.

```yaml
# .github/slop-sheriff.yml
blocking: false
personality: true
profile: balanced
```

Select `voice: theatrical` (default), `voice: understated`, or `voice: off`.
`personality: false` also disables cowboy language. Add `voiceGuide` with a trusted-base
repository-relative Markdown path for custom style; see [the tone guide](brand.md).
Evidence and recommendations remain invariant across modes. Advisory mode keeps merge decisions with you. Setting
`blocking: true` enables approval/request-changes reviews; configuring required
Checks is a separate repository-owner decision. See the
[configuration reference](../README.md#trusted-repository-configuration) for
models, per-lane overrides, publication profiles, and public content roots.

## 6. Deploy, then take the first patrol

Deploy the validated revision to production. Confirm the full hosted build,
sandbox prewarming, Convex deployment, and Connect destination succeeded before
making the test PR ready. A draft-to-ready transition starts a paid full review
immediately. A PR opened ready has a trailing ten-minute debounce.

Keep the PR head fixed while the first review runs. Verify the aggregate Check,
lane coverage, summary, and inline findings refer to that exact commit. A failed
or incomplete lane is not a clean review. Inspect findings and usage before
allowing routine automatic reviews. Returning the test PR to draft stops further
review work while you assess the result.

Authorized repository maintainers can use `@slop-sheriff run full review` to
request a new full review, or `@slop-sheriff continue` for eligible recorded
recovery. These are literal command tokens even when your App has a different
registered name. A draft PR is ignored, including manual commands.

See the [deployment and pilot guide](deployment.md) for exact-revision rollout,
observability, and recovery. Slop Sheriff reviews code; it does not push fixes,
merge PRs, or change repository settings.

## Accepting a finding without a code fix

A repository maintainer with write, maintain, or admin permission can comment:

```text
@slop-sheriff dismiss CR-1 The booking link is explicitly deferred until the owner creates it.
```

The command requires an explicit reason and a completed review of the current
base and head. Slop Sheriff records the maintainer, reason and commit, removes
that concern from the outstanding count, and resolves its own thread with an
acceptance reply. It does not claim a verified fix. Resolving a thread manually
alone does not dismiss its finding.

The same accepted concern retains its disposition in subsequent reviews.
Changed consequence, remedy, severity or file scope requires a new assessment;
acceptance cannot silently suppress a different concern. The model cannot create
or alter maintainer dismissal metadata.
