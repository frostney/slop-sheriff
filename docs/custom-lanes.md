# Project review lanes

A standard Slop Sheriff installation supports repository-specific review lanes as
runtime configuration. The generic application capability needs one normal app
upgrade. After that, adding or editing project criteria requires no fork, custom
build, restart, or redeployment. The app reads `.github/slop-sheriff.yml` at the
pull request's exact base commit, falling back to `.github/known-good-review.yml`
only when the current file is absent. A configuration change in the pull request
cannot activate itself; it takes effect for reviews whose trusted base contains it.

```yaml
voice: understated
voiceGuide: docs/review-voice.md
requirementPaths:
  - contracts
  - product/acceptance.md
lanes:
  - id: project-api-compatibility
    name: API compatibility
    criteria: >-
      Existing public response fields and error codes must remain compatible.
      Verify the documented envelope through the public HTTP interface.
    referencePaths:
      - contracts/http-api.md
    applicability:
      paths:
        - src/api
        - contracts/http-api.md
  - id: project-accessibility
    name: Accessible controls
    criteria: Interactive controls must expose accessible names and keyboard access.
    referencePaths:
      - product/accessibility.md
    always: true
agents:
  project-api-compatibility: openai/gpt-5.6-sol
```

`id` is a stable identifier beginning with `project-`, followed by a lowercase
letter and up to 47 lowercase letters, digits, or single separating hyphens.
The prefix separates project IDs from built-in axes and routing roles. Keep the
ID stable when refining a lane; use a new ID for a different responsibility.
Names and IDs must be unique. Each name appears with its ID in an independent
Check, for example `slop-sheriff / API compatibility (project-api-compatibility)`.
The seven built-in lane IDs and Check names stay unchanged.

Each lane supplies nonempty `criteria`, an optional list of trusted reference
paths, and either `applicability.paths` or `always: true`. Applicability paths are
literal repository-relative files or directory prefixes. A directory matches only
at a path boundary. Both old and new paths of a rename count. The changed review
scope determines activation; `always` explicitly activates the lane for every
review, including an empty scope. Built-in specialists continue to be selected
from changed content and the core review retains overall correctness ownership.

Every active lane must account for its configured criteria and applicable reference
obligations with source-linked evidence. Reading a packet or checking only one
requirement per file cannot complete the lane. Unverified required checks prevent
completion and publication.

Reference and requirement paths must be literal repository-relative paths without
traversal, control characters, backslashes, query syntax, or wildcards. Reference
content is read at the exact base revision, including unchanged documentation.
The shared requirements inventory supplies sources and obligations to workers.
`requirementPaths` supports unusual repository layouts without turning each review
into an unrelated documentation audit. Configured lane references and voice guides
cannot grant tools, credentials, plugins, executable hooks, publication permissions,
or a different review scope. Additional executable integrations need a normal
application release.

The app admits at most 24 project lanes (31 including built-ins), rejecting larger
registries before dispatch. Every admitted active lane receives its own reservation
of 16 child invocations, counting its scouts, scout output recovery and checkpoint
continuations. One lane cannot consume another lane's allocation. Exhaustion is an
explicit incomplete execution requiring repair/recovery, never a dropped Check or
permission to publish a complete review. These are bounded protocol safeguards,
not finding-quality or cost acceptance criteria.

All lanes use the same generated tool schemas, evidence packets, coverage checks,
signed checkpoints, finding contract, deduplication, inline delivery and reporting.
A project lane cannot invent a severity, finding ID or verdict. Recovery and report
identities bind a digest of resolved lane definitions, and signed checkpoints bind
the same digest together with exact base/head and evidence identities. The exact
base SHA binds referenced file contents. Configuration from another repository or
base cannot replace these definitions during continuation. Legacy persisted states
for built-in-only reviews remain readable.

`voice` accepts `theatrical` (default), `understated`, or `off`. The legacy
`personality: false` overrides voice to `off`. Voice guides are read from the trusted
base, limited to 16,000 bytes, and affect wording only. They cannot change evidence,
severity, verification requirements or recommendations. `voiceGuideContent` is
application-owned and is rejected in configuration.

The saved baseline also binds normalized configuration and the exact base revision
for built-in-only reviews. Changed voice, models, requirement paths, project lanes,
or base advancement triggers a new full review even when the effective PR patch is
unchanged. Base advancement is intentionally conservative because unchanged
requirements and reference files may have changed. Old baselines without this
digest require one full review after upgrading. This behavior makes no performance
improvement claim for semantic rebases across different base revisions.
