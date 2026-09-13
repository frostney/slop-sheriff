# Review cost accounting

Every provider invocation is durably admitted in Convex before the SDK sends it.
The installed AI SDK telemetry wrapper records transport retries, regular model
calls and Eve compaction calls. Early streamed Gateway metadata is persisted
before forwarding the chunk; an interrupted stream retains its generation ID
and failure outcome. Only identities, usage and billing metadata are stored.
Prompts, tools, responses and credentials are excluded.

The attempt key is the trusted execution delivery ID. Reports group by repository,
pull request, head, full/delta kind and attempt, including failed calls. The separate
review lifecycle ledger owns the execution's terminal status. A successful model
call can still belong to a failed review or publication attempt.

`costGenerations` deduplicates Gateway generation IDs across SDK/native envelopes.
An independent Convex cron reconciles pending IDs every minute, even after the
Eve session has failed. Delayed records and lookup failures remain pending and are
retried with backoff. Scheduling batches limit telemetry service load, never the
review's time, tokens, spend, lanes or coverage. Gateway credentials stay in the
trusted Convex action environment. Set `AI_GATEWAY_API_KEY` on that deployment.

Run `bun scripts/review-costs.ts <repository-node-id> <pull-request-number>` with
the trusted service's `CONVEX_MEMORY_URL` and `KNOWN_GOOD_REVIEW_MEMORY_TOKEN`.
The command follows every `/cost/report` page and prints cumulative, full, delta,
per-head and per-attempt totals. Both `/cost/record` and `/cost/report` require the
existing service bearer token. These credentials must never enter the repository
execution sandbox.

SDK known cost and Gateway known cost are separate observations, not additive.
Per-phase `modelActivitySpanMs` spans the first durable model admission through
the last terminal observation for that attempt. It includes stream consumption
and recording overhead. Overlapping calls are not added together, and missing
boundaries remain unknown. Full review wall time also includes preparation,
queueing and publication, so record it from the lifecycle separately.

`totalCostUsd` is null while any call is unresolved, including a failed request
without a generation ID. `missingGenerationCalls`, `unknownTokenCalls`, failed
and unfinished counts expose what is still unknown. A zero known subtotal does
not mean an unresolved call was free. Native Gateway token categories remain
stored separately from cache-inclusive SDK token counts.

Accounting applies to calls admitted after this release. Historical log fragments
and dashboard snapshots are not silently imported as complete ledgers. In
particular, the previously observed SDK and Gateway subtotals cannot establish
the user's approximately $80 attempt total without all its billing records.
Offline tests prove accounting and recovery behavior; they do not establish paid
review savings or model quality.

Gateway authentication/payment admission rejections are recorded from the installed provider's typed errors, with generation IDs preserved even on thrown failures. The authenticated `/cost/nonbillable-attempt` endpoint checks the complete paginated attempt: at least one recorded failed request, explicit rejection classification for every request, no generation IDs and no positive recorded usage. Absent or unfinished telemetry never proves zero work. Recovery uses this narrow proof for a saved admission-only receipt; accounting still leaves unreconciled billing quantities explicitly unknown. Paid full/delta continuations triggered by review control responses retain their review accounting identity.
