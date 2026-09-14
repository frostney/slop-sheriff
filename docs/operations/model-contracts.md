# Review model contracts

Run `bun run check` and `bun run replay:pr61` before a paid canary after changing
a tool schema, report mapper or model integration. A successful mock review
with prewritten valid reports is insufficient. The offline gate must exercise
the generated provider schema, invalid output and downstream report assembly.

`review_work` takes one `action`:

- `{"operation":"read"}` reads the assigned work and retained evidence.
- `progress` requires reviewed/remaining entry indices, observations, next
  steps, limitations and nullable escalation. No terminal report is accepted.
- `complete` requires reviewed entry indices and the full `report` object.
  The application supplies terminal status and empty progress fields. Report
  limitations belong in `report.limitations`.

Technical workers supply evidence and recommendations. Adjudication supplies
finding identity, severity, introduction, principle and risk. Persisted assessment
and canonical report formats retain their existing contracts. Old work-tool
calls are rejected rather than guessed or repaired into successful reports.

`review_work` and `inspect_review_source` request the SDK's strict tool mode.
Eve 0.52 has no authored tool `strict` option, so the shared model middleware
sets the official SDK field before Gateway serialization. Nested alternatives
use `anyOf`, every object is closed and every declared property is required.
Provider support still matters; runtime validation remains mandatory.

The gate includes:

- `review-model-contract.test.ts`: valid operation variants and invalid
  combinations through the actual SDK-generated JSON Schema and Zod validator;
  required fields, path constraints, evidence references and application-owned
  fields; conversion into the persisted checkpoint contract.
- `review-model-stream.test.ts`: the captured PR43 prefix through official SDK
  mocks and the installed Gateway's raw HTTP transport. Invalid streams cannot
  execute a tool, keep generating, or lose their failed billing identity. Valid
  current-format reports and malformed nested reports also cross both transports
  with varied chunk boundaries, escaped strings and Unicode.
- `review-work-tool.test.ts`: the actual production source and completion tools,
  real Git inspection and preparation, signed evidence, and Convex HTTP storage.
  Corrected coverage, lost responses, delayed old writes, VM artifact loss and
  superseding heads exercise recovery and fencing. The native handle response
  is recorded test data; the test does not claim a hosted native review.
- `production-quality-executor.test.ts`: a missing report returned as a tool
  error to the same investigation, followed by valid completion, persistence,
  canonical assembly, publication recovery and an actual fix sequence.
- The native Eve smoke: compiled assigned tools reject invalid source and report
  inputs before execution, return errors to the child, and let it finish. Schema
  matrices remain in unit tests.

Cross-reference validity, unique environment names, exact assigned coverage,
observed evidence and current-attempt authorization remain
application checks. JSON Schema alone cannot prove those facts. Invalid reports
must never mark a review complete or safe to merge. An irreparable streamed JSON
prefix stops the upstream request; a complete but invalid tool call can receive
the SDK's normal tool-error feedback. Neither path may fabricate evidence.

There is no hidden 24 KB report check after provider validation. Field constraints
remain in the generated schema. Evidence writes carry their application lock
owner through the storage commit, so a handled validation or transport failure
can release its lock without admitting delayed stale writes. This does not release
an unknown executable probe or claim that a lost worker finished its command.

Deploy the compatible Convex write handlers before the application that sends
write claims. An older handler rejects the new request fields. Keep live reviews
paused until both sides have been verified on the same candidate.

These gates prove contract and recovery behavior. They do not prove that a model
finds material defects, avoids false positives or delivers a viable lifecycle
cost. Those require separately authorized real-model evaluations.
