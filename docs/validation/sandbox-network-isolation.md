# Sandbox acquisition and execution boundary

Review VMs use native `deny-all` egress at creation and keep it for their entire
lifetime. The definition revision changes when this boundary changes, replacing
older Eve session sandboxes. Reconnection does not authorize another download
window. Package hooks, PEP 517 backends, build tools, repository browser commands,
and background processes all execute under this permanent policy.

A fresh disposable native Eve/Vercel VM acquires Git objects using a repository-
scoped credential transform. It validates the expected revisions, removes the
transform, and transfers the Git directory through sandbox file APIs. It never
checks out or executes the pull request. The review VM performs checkout offline.

Eve's trusted bootstrap VM installs the fixed Node/Bun toolchain and native
browser once, then closes egress before the native template snapshot is cached.
Bootstrap is template-scoped; Eve never invokes it on a PR session or its restored
filesystem. Every review VM starts from this trusted snapshot with deny-all
policy. This avoids transferring browser binaries and system libraries per review.

Repository-specific tool acquisition uses another fresh VM with no repository checkout, previous
review processes, or writable state from a review VM. Fixed toolchain and native
browser installers run before dependency declarations arrive. Node package
manifests are projected to dependency data; repository package-manager config,
plugins, scripts, and executable entry points do not cross this boundary. Bun,
npm, pnpm, and Yarn 1 acquisition disables scripts; pnpm also disables its hook
file. The original repository install runs in the offline review VM using the
acquired caches, so project lifecycle hooks still execute during real setup.
Python acquisition prohibits source builds, Cargo fetch receives only an official
Rust distribution channel, and Go acquisition uses declarative module inputs.
Executable dependency resolvers never receive an online execution window. LWPT
0.5.1 lock v2/v3 archives are downloaded and hash-checked as bytes, then extracted
and filtered offline before the original frozen installer verifies the graph
and runs its hooks. Custom module/archive paths and local dependencies retain
their declared behavior.

Trusted system-package files and user tool/cache directories are exported in a
compressed archive. Transfers use bounded uploads because Eve's Vercel file-write
implementation buffers its input. Archive size does not limit review eligibility
or coverage. Failed acquisition/export/materialization throws before a successful
setup receipt is produced; the acquisition VM is deleted in `finally`.

## Validation

Offline tests exercise real Git materialization, real Bun installation and root
lifecycle execution, projected malicious manifests, path traversal, Rust path
toolchain rejection, acquisition failure cleanup, and byte-preserving chunked
archive transfer. PR61 replay retains its four recorded transitions.

The provider-free native probe is `.agent/verify-isolated-template.ts`. It
fetches PR43 through the production workspace path, leaves a background registry
request running in the offline VM while the separate VM installs dependencies
and the native browser, and then exercises offline browser startup, stop/resume isolation, and repository
landing tests. It uses no model, Gateway, or judge requests. Native probe results
are recorded privately under `.agent/isolation-template-*` and `.agent/isolation-native-chunks.log`.

On September 13, 2026 the native template probe passed with Node 24.21.0, Bun
1.4.2, and agent-browser 0.37.1. Its background registry probe remained denied
throughout acquisition, the real PR43 landing tests passed offline, browser
launch/cleanup passed, and stop/resume retained denial. Total probe time was
383,952 ms including initial template preparation. The final transport primitive
separately transferred 25,165,829 bytes through independent native chunk requests
with identical source/destination SHA-256 in 35,618 ms. All probe VMs were deleted.
Earlier probes exposed whole-file request-size and long-lived stream failures;
the final transport uses independent bounded reads and writes. These are native
sandbox results, not model quality or production review-delivery certification.

## Capability boundaries

Setup failure remains an execution failure and cannot produce a completed/clear
review. The new boundary does not turn missing dependencies into an advisory
coverage note. Python source distributions needing undeclared build dependencies,
modern Yarn plugin graphs, and executable dependency graphs require acquisition
adapters before they can complete offline. The previous implementation already
had no installation path for unavailable Composer, Swift, Gradle, Maven, Ruby,
Deno, or .NET toolchains; this change does not claim those toolchains are now
supported. Installing a tool or fetching an artifact must use the isolated
acquisition boundary rather than widening the review VM's egress.
