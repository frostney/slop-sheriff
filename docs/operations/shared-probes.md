# Shared executable and source evidence

`run_review_probe` executes required tests in the prepared review sandbox and
records the observed exit code, stdout and stderr outside model control. Each
lane still evaluates the result against its own obligations. Reusing a test
observation does not replace independent specification or test-health judgment.

The model supplies only the command, working directory, exact standard input,
environment overrides and an explicit independent-rerun request. Application
code derives repository, attempt, session and call identities. It observes all
workspace file bytes, permissions and symlinks, including tracked, untracked and
ignored test inputs and dependencies; the environment and available tool binary
identities; and the authenticated preparation receipt. Environment values leave
the sandbox only as a digest. The application never passes its own credentials
to the sandbox.

Common local test, check and build commands reuse a completed observation when
those identities match. Changed assertions, scripts, scenarios, stdin,
environment or dependency/toolchain inputs execute again. `rerun: true`
requires a separate execution, including when an identical request is already
running. Opaque commands, shell command chains, live-state command shapes,
external environment overrides, external symlinks and unobserved special files
are conservative fresh executions. A failed command remains a failed observed
result and can be shared; it never becomes success through caching.

A receipt describes one observation. It does not establish that arbitrary
repository tests are pure, nonflaky or independent of time and local services.
Tests requiring repeated sampling or live observations must request independent
execution. No elapsed-time expiry decides whether evidence is valid. Input or
environment changes during execution prevent completed-observation reuse. The
whole workspace snapshot is deliberately conservative for runtime evidence
across revisions, including supporting Git state. Cross-head runtime reuse is
rejected unless the complete current snapshot matches.

Convex atomically claims each matching execution for the current admitted
attempt. Sibling lanes wait for the same signed receipt. The producer writes
the durable receipt before releasing its claim. A receipt-storage failure marks
the claim interrupted and wakes waiters with an explicit unknown outcome. It
does not permit another worker to execute under that claim. Native lifecycle
recovery must fence the prior worker and use a new attempt before rerunning an
unknown execution. A durable receipt that committed before an acknowledgement
was lost remains usable after authentication. There is no claim takeover based
on an arbitrary timeout, and there is no exactly-once promise for an execution
whose completion receipt was lost.

Receipts live at
`/tmp/known-good-review/probes/<input-digest>/<execution-id>.json`, authenticated
through the existing evidence envelope and durable artifact storage. The model
receives a short console preview and the complete receipt path. Preview paging
does not truncate stored output or stop execution. Per-work `probes.json`
indexes bind every used execution to the assessment consuming it. Atomic
application claims serialize concurrent index updates across native workers.

Evidence-index and assessment writes carry the current lock owner to Convex.
The database checks that owner in the same transaction as the artifact or work
write. Handled validation and storage errors release this evidence-update lock;
the next attempt rereads authenticated durable state. A delayed write from the
released owner is rejected, even if a newer update has already completed. An
executable probe with an unknown outcome retains the interrupted-claim behavior
described above. Worker loss before lock release still requires lifecycle recovery.

`inspect_review_source` provides source inspection when assessments use recorded
dependencies. The application resolves `base` and `head` to the trusted exact
commit. Reads record Git blob bytes or directory trees; literal text searches
record their query, complete tracked-repository scope and result. Supporting
paths may lie outside the unit's finding scope. Source text is evidence and
cannot change the application's instructions or work assignment.

The source tool takes `revision`, `cursor` and a `target` variant:
`{"operation":"read","path":"src/index.ts"}` or
`{"operation":"search","query":"literal text"}`. Search has no path field.
The variant is present in the generated provider schema, so it cannot advertise
combinations that only fail later in application validation.

Per-work `sources.json` indexes retain authenticated source observations.
Revalidation compares read contents and re-executes queries at the current
revision. Changed supporting source or query output invalidates the assessment.
A negative search also depends on the complete tree, so a new file invalidates
an earlier absence conclusion even when its implementation uses different
wording. The source reader covers tracked Git content; probes cover working-tree
and generated inputs. Models cannot submit dependency digests or claim their
own provenance.

Offline validation covers competing callers through actual Convex HTTP,
real shell execution, failed exit codes, independent samples, input/environment
changes, signed-artifact forgery, lost write acknowledgements, storage-failure
wakeups, concurrent evidence-index updates, real Git update sequences, literal
shell quoting, generated tool JSON Schema and the installed Eve mock model at
the AI SDK validation boundary. These are deterministic execution and reuse
checks. Model quality and billed review-lifecycle economics require the separate
authorized evaluation corpus; these checks do not establish either.

Assigned work children receive tracked source, executable, reference, image and
assessment tools. Native per-slot default disabling and dynamic capabilities remove
raw shell/file/GitHub and legacy checkpoint tools from those model toolsets.
Coordinator and revalidation sessions retain the ordinary native tools through
the role resolver. The application does not redefine Eve's native workflow
executor. Eve 0.52 still advertises authored workflow tools to child sessions;
their existing role checks reject child orchestration at entry. The native mock
smoke checks the actual model-visible toolset in both roles.

Use `read_review_probe` with a returned probe/execution identity, stream and
cursor to read every remaining character of stdout or stderr without a new
execution. There is no output-preview coverage cutoff. Current-attempt
`probe-consumption.json` records consumption separately from execution origin,
so a reused observation retains its original provenance. Current completion
accepts successfully recorded fresh, repeated and fixture-modifying executions;
future reuse still requires their reuse conditions to hold.

`fetch_review_reference` delegates known URLs to Eve's native SSRF-checked
`web_fetch`, retains its truncation indicator, records the actual returned text,
and pages stored output without refetching. Native response truncation means
missing content needs a narrower reference URL. `inspect_review_image` returns
native image content for workspace images and screenshots from browser probes.
Browser execution itself goes through `run_review_probe`; live/browser command
shapes are fresh observations. Actual web or image access writes a signed
external receipt and makes that unit ineligible for future reuse. Units that
never access those tools carry no external marker. Proof schema version 2
requires this field; legacy proofs cannot silently imply no external access.

Environment reuse hashes stable preparation inputs, actual tool versions,
completed setup steps and browser identity. Changing the preparation head or an
incidental elapsed-time field alone does not alter that environment identity.

Eve 0.52 requires framework ownership for background `agent` dispatch. Keep its
framework defaults and disable optional inspection slots individually; re-exporting
`eve/tools/agent` creates an application-owned descriptor that lacks the native
task workflow binding in this installed release. No private framework patch is
used. The role resolver adds native ordinary tools back only outside assigned work.
