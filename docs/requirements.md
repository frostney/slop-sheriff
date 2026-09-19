# Requirements and documentation review

Slop Sheriff prepares one shared inventory of requirement sources from the exact
base and head revisions. The claim-and-specification lane compares the change
with those obligations. The test-against-spec lane verifies applicable behavior
through the delivered UI, API, CLI, library, job, package, or migration interface.

## Discovery and scope

Discovery includes governing AGENTS, CONTEXT, README, DoD, acceptance, and
specification documents at the repository root, in `docs` or `.github`, and in
ancestors of changed files. It also includes changed documents, documents whose filenames or subtree names
relate to changed files, and local document references reachable from selected
sources. Specification and ADR directories follow the same relevance rules;
unrelated directories are not inventoried simply because they contain specs.
Unchanged and deleted base documents remain available. External references are
listed for reviewers to follow when relevant.

This inventory supplies leads for the changed scope. Reviewers classify unrelated
sources as out of scope with a concrete reason; selection does not require a
complete audit of every document's claims. The reviewer also follows directly
relevant sources that discovery did not recognize. No DoD file is required, and
the reviewer does not invent one when none exists.

Add unusual layouts through literal repository-relative files or directories in
the trusted base configuration:

```yaml
# .github/slop-sheriff.yml
requirementPaths:
  - product/contracts
  - governance/completion.md
lanes:
  - id: project-cli
    name: CLI contract
    criteria: |
      The CLI must reject invalid input with a nonzero exit status.
      - [ ] Help includes usage examples.
    referencePaths:
      - product/contracts/cli.md
    applicability:
      paths:
        - src/cli
```

Configured sources must exist at the base revision. Candidate configuration
changes do not activate new paths or replace lane criteria. An applicable project
lane receives its trusted criteria and reference documents, including linked
sources, with separate evidence obligations. See [installation](install.md) for
the complete configuration and [architecture](architecture.md) for execution.

## Established obligations and proposed changes

Each source retains the base text, proposed head text, revision identifiers, and
content integrity evidence. A head edit that deletes or weakens an obligation
does not silently replace the established requirement. An explicit maintainer
approval can supersede it; the check records that approval and its scope.

Review proceeds in both directions: code changes can leave documentation stale,
and changed documentation can claim behavior the product does not support.
Consequential findings cite the requirement and the observed behavior. Introduced,
worsened, or exposed defects belong in the primary findings. Unrelated existing
drift belongs in additional actionable concerns.

An unchecked checkbox is not itself a defect. A demonstrated outcome can satisfy
its requirement regardless of the marker. Conflicting sources require an
explanation or an approved decision; unresolved required behavior prevents a
complete, clear recommendation.

## Evidence for each criterion

The inventory extracts explicit checklist items and normative clauses containing
terms such as “must,” “shall,” and “requires.” Each extracted criterion has its own
identity and base/head line references. Checkbox completion markers do not change
that identity. Removed base criteria remain separate obligations.

A single broad pass for a document cannot cover omitted explicit criteria.
Completed requirement lanes account for each extracted item and each source.
Project lanes also account for their configured criteria and reference sources.
Configured criteria also include ordinary prose clauses; when extraction finds no
clause, the complete criteria text becomes one obligation.

This extraction is not an exhaustive natural-language specification parser.
Reviewers identify additional applicable requirements from the complete documents,
issues, PR claims, and accepted decisions. They record those requirements
separately and freeze behavioral expectations before exercising the candidate.
Reading source or running a mock does not establish real-interface success.

Every check records its requirement basis, expected and observed result,
environment, and action. Approved changes require approval evidence. A failed
required behavior remains a material claim finding; report assembly rejects its
omission. Unverified required checks cannot produce completed checkpoints.

## Verification that cannot finish

Shared setup provisions declared runtimes, locked dependencies, test tools, and
needed browser binaries. Reviewers repair and retry avoidable execution failures;
a missing installable tool is not a routine completed-review disclaimer.

Private credentials or required hardware that cannot be supplied can leave a
review incomplete. The reviewer records the exact unavailable capability and
required action. It cannot claim complete or clear while that required
verification remains unfinished.
