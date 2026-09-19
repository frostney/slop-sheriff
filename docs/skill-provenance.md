# Skill provenance

Project development skills were installed with the owner-maintained Skills
CLI (`skills` 1.5.22). `skills-lock.json` records their hashes computed with the
CLI's content-hash algorithm. Runtime review policy is authored locally.

## Slop Sheriff runtime policy

`agent/instructions.ts` selects the locally authored role policy from
`src/review/policy.ts`. The optional `agent/skills/review-policy/` guide
provides deeper investigation prompts. Application code owns axes, scoped
evidence delivery, signed checkpoints, orchestration, recovery and publication.
No runtime policy is installed or refreshed from known-good-route.

The review principles acknowledge known-good-route's `code-review`,
`test-against-spec` and writing guidance at revision
`4bb09419189430000711893b7ed10ad7d22c6211` (Unlicense OR MIT). This is attribution,
not an execution dependency. The development `code-review` entry in
`skills-lock.json` still describes `.agents/skills/code-review`, not the runtime.

## known-good-route

- Source: `https://github.com/frostney/known-good-route`
- Handoff revision: `8cc9ce28814f26e4bc56680bb284ef2ac307739a`
- Fetched main used for hardening: `2664e3045f6bf5674b5464ccd5fcf260f5baf03d`
- Source pull request: `https://github.com/frostney/known-good-route/pull/38`
- Consumed merged revision: `e3aad669dc127e5af6b1fea1ccccf0cc70b0e093`
- Commit subject: `feat(code-review): define review axes and v2 findings (#38)`
- Latest checked main revision: `0b54d8adb0b2a827120a954d5905827e51d3236b`
- Nitpick/profile source pull request: `https://github.com/frostney/known-good-route/pull/40`
- Nitpick/profile consumed revision: `88b96fc5f8804ac7ebe0bb2c5dfdf20161261ab9`

The local commit clarifies fresh review, targeted revalidation, and combined
operations; names review axes consistently; requires one lane per active axis;
uses all-candidate collection before coordinator filtering; and upgrades both
`code-review` and `codebase-audit` findings JSON to schema version 2 with no v1
reader or migration.

The historical runtime copy of `code-review` and its references has been
replaced by the locally authored policy above. The project-local development
suite under `.agents/skills` still includes `code-review`, `agent-writing` and
`typescript-stack`. The catalog's Convex, React, and FreePascal stack skills are
not installed because they do not apply to this repository. `skills-lock.json`
records `frostney/known-good-route` as the source and the Skills CLI content hash
for those installed development skills; this repository does not author them.

`test-against-spec` is also installed through the Skills CLI and recorded in
`skills-lock.json`. Together with `code-review`, it is a mandatory development
review for every change, as specified in `AGENTS.md`. These development reviews
do not add runtime agents or require additional paid model calls.

## mattpocock/skills

- Source: `https://github.com/mattpocock/skills`
- Revision fetched at install time: `068b6e0c62393147daf03530149cdce209c93da8`
- Installed project skills: `grilling`, `grill-with-docs`, `domain-modeling`

These were fetched from the current upstream repository by the Skills CLI, not
copied from a global Claude/Codex installation. `run-retro` and the other
development workflow skills are project-local known-good-route installs.

The upstream `grill-with-docs` frontmatter contains the Claude-specific
`disable-model-invocation` key. The current Agent Skills validator rejects that
non-standard key, so the project-local copy removes only that key; its skill
body remains the fetched revision above and it is still invoked explicitly by
the workflow skills.
