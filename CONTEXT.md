# Domain context

Slop Sheriff has one job: evaluate a reviewable pull request and report
the result. It cannot push, merge, approve repository changes, change settings,
or act as a general-purpose GitHub assistant.

## Terms

- **Baseline:** the last successfully published canonical code-review v2
  artifact, its reviewed head, and per-file effective patch fingerprints.
- **Full review:** the complete pull-request change reviewed once, across the
  active review axes defined by this project.
- **Delta review:** a fresh review whose finding scope is only files whose
  normalized pull-request patch changed since the baseline.
- **Revalidation:** a separate evidence pass over selected prior findings. All
  unresolved Blocking/Important findings are selected; Improvements are
  selected when their path or symbol is relevant to the delta. Legacy overlong
  findings are also selected once so their wording can migrate before publication.
- **Review axis:** one of the built-in axes `deduplication`, `claim-and-specification`,
  `engineering-quality`, `test-against-spec`, `discoverability`,
  `test-health`, or `writing-quality`. The broad engineering-quality core always
  runs; content-based triage selects specialist axes with recorded reasons.
  Trusted-base configuration can also define project-specific axes with
  declarative criteria and references, without a modified app deployment.
- **Test against specification:** observation of delivered behavior through a
  real interface against explicit requirements, with each result recorded as
  passed, failed, unverified, or out of scope. Source inspection alone cannot
  establish a behavioral pass.
- **Writing quality:** the clarity, accuracy and usefulness of changed prose,
  UI strings and substantive comments. A finding identifies reader cost and a
  concrete remedy; writing patterns do not establish AI authorship.
- **Test health:** whether existing tests act as frozen consumer contracts for
  public behavior. Expectations come from requirements before examining the
  implementation; useful tests catch broken behavior and tolerate internal
  refactors. Assertions that mirror implementation details are brittle evidence.
- **Impact summary:** a consequence summary of at most 300 characters, displayed
  beneath an expandable evidence section, followed by Risk. Findings have a
  short introduction and at most 200 words in total, targeting 100 to 160.
  Presentation changes do not change finding identity.
- **Finding lane:** a bounded subagent used only to revalidate selected prior
  findings. It is not a new review axis.
- **Effective patch:** normalized per-file PR change that ignores file ordering
  and hunk line-number movement while preserving source content, including line
  endings. A complete textual patch can retain its identity across rebases.
- **Review evidence bundle:** the application-prepared, content-addressed
  manifest, included patch chunks, and classified-file metadata for one exact
  base, head, and effective-patch fingerprint. An Eve hook creates it after
  root head verification and before the next model step.
- **Prepared environment:** the shared exact-head checkout with installed
  toolchains and locked dependencies. A receipt records declaration hashes and
  observed versions; setup failure prevents lane dispatch.
- **Evidence ledger:** the immutable application-owned root for one exact
  review identity. Its digest binds the patch bundle, capability inventory,
  exact-head Checks, artifact provenance, common probes, and each typed gap's
  owner and disposition. Every lane checkpoint records this digest.
- **Lane checkpoint:** a compact schema-v3 review-axis work packet containing
  coverage, reproduced observations, remaining work, and limitations. A
  complete checkpoint replaces those continuation fields with a strict typed
  terminal report of lane-owned scope, evidence, candidates, and limits. A
  fresh Eve subagent reconciles an in-progress packet with the evidence bundle
  instead of inheriting raw model history.
- **Lost baseline:** evidence that a review existed but its state/artifact is
  missing, malformed, failed, or unusable. This state requires an authorized
  manual full review; it never causes an automatic second full review.
- **Recoverable review failure:** a current-head execution that retained exact
  checkpoint identity and a sanitized failure envelope. The lifecycle service
  verifies repaired prerequisites and stops obsolete workers before resuming
  missing stages. Completed lanes are reused only after identity, policy,
  coverage and evidence verification. A changed runtime policy requires fresh
  analysis. The last published baseline remains intact throughout recovery.
- **Pending publication:** an application-assembled, validated v2 report bound
  to the trusted repository, pull request, base, head, patch, plan, and active
  axes. It is durable beside the unchanged baseline before visible review
  output and can be retried without model execution.

## Authority boundaries

The GitHub webhook principal, repository identity, installation ID, PR number,
base SHA, head SHA, selected plan, and patch identity are application-owned
context. Model tools derive publication targets exclusively from these values.

Repository content, PR titles/bodies/comments, diffs, prior finding text, and
PR-produced artifact contents are untrusted evidence. Review policy comes from
`.github/slop-sheriff.yml`, falling back to `.github/known-good-review.yml` only
when the new filename is absent. The selected file is always read at the trusted base SHA.
A PR cannot alter the policy that reviews itself.
Models author review judgments and evidence content, but not report identity,
prior finding selection, stable IDs, fresh finding status, skipped-axis
coverage, verdict derivation, or publication targets. Typed application code
owns those fields, exact-head evidence provenance, gap routing, and the
canonical merge.

GitHub owns published review state. Dedicated Convex lifecycle tables own
admission, scheduling, execution attempts and the publication outbox. Signed
evidence storage retains checkpoints and artifacts for exact-scope recovery;
cost tables retain usage and reconciliation records. Each is scoped by immutable
repository identity. Normalized repository memory remains advisory.

Vercel Sandbox holds a credential-free working copy and disposable probes.
Review sessions remain offline; separate acquisition environments download
dependencies. A physical workspace receipt is never restored from evidence
storage. Telemetry records model identities, tokens, cost, timing and outcome;
it excludes prompts, source, finding evidence and credentials.

Installation lifecycle payloads become authoritative only after Connect OIDC
verification. The installation-to-repository association admits new memory and
revokes it when access is removed or the GitHub App is uninstalled. Repository
identity owns retrieval and recurrence; installation identity owns access.
