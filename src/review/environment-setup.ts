import { createHash } from "node:crypto";
import { buildAgentBrowserCommand, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { rcompare, satisfies } from "semver";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { ReviewEvidenceIdentity } from "./evidence-bundle";
import { discoverabilityApplies } from "./discoverability";

interface SetupSandbox {
  run(options: { readonly command: string }): PromiseLike<{
    readonly exitCode: number; readonly stdout: unknown; readonly stderr: unknown;
  }>;
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
}

const setupRevision = "review-environment-v1";
const declarations = [
  "package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json",
  "pnpm-lock.yaml", "yarn.lock", ".node-version", ".nvmrc", ".bun-version",
  "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "go.mod", "go.sum",
  "pyproject.toml", "uv.lock", "requirements.txt", ".python-version", "Makefile",
  "fpmake.pp", "lwpt.toml", "lwpt.lock", ".lwpt-version", ".fpc-version", "CMakeLists.txt", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "Package.swift", "build.gradle", "build.gradle.kts",
  "gradlew", "mvnw", "pom.xml", "deno.json", "deno.jsonc", "global.json",
] as const;

export const environmentSetupSchema = z.strictObject({
  revision: z.literal(setupRevision),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(z.strictObject({ name: z.string(), version: z.string().min(1) })),
  completedSteps: z.array(z.string()),
  browser: z.strictObject({ provider: z.literal("agent-browser"), command: z.string().startsWith("/"), version: z.string().min(1) }).optional(),
});
export type EnvironmentSetup = z.infer<typeof environmentSetupSchema>;

function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const persistReviewPathCommand = [
  "export PATH=\"$HOME/.local/bin:$PATH\"",
  "mkdir -p \"$HOME/.local/bin\"",
  "review_profile=\"$HOME/.bash_profile\"",
  "if [ ! -f \"$review_profile\" ]; then for candidate in \"$HOME/.bash_login\" \"$HOME/.profile\"; do if [ -f \"$candidate\" ]; then review_profile=\"$candidate\"; break; fi; done; fi",
  "touch \"$review_profile\"",
  "grep -Fqx 'export PATH=\"$HOME/.local/bin:$PATH\"' \"$review_profile\" || printf '\\n%s\\n' 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$review_profile\"",
].join("\n");

// These commands execute only inside Eve's credential-free Linux sandbox.
// No app environment or repository secrets are passed to package installers.
export function systemPackages(debian: string, rpm = debian): string {
  return `if command -v apt-get >/dev/null; then ${httpsAptSourcesCommand}\nsudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ${debian}; elif command -v dnf >/dev/null; then sudo dnf install -y ${rpm}; else echo 'No supported system package manager (apt-get or dnf)' >&2; exit 1; fi`;
}

// Vercel's domain firewall identifies HTTPS by SNI. Official base images can
// still declare HTTP apt mirrors, so normalize those before any apt consumer.
export const httpsAptSourcesCommand = [
  "for review_apt_source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do",
  "[ -f \"$review_apt_source\" ] || continue",
  "sudo sed -i -E 's#http://((archive|security|ports)\\.ubuntu\\.com|deb\\.debian\\.org|security\\.debian\\.org)/#https://\\1/#g' \"$review_apt_source\"",
  "done",
].join("\n");

export const bootstrapCommand = [
  "set -eu",
  // Installed Eve backends launch each command with bash -lc. Persist this in
  // the login profile so later built-in tools and shared children see it too.
  persistReviewPathCommand,
  httpsAptSourcesCommand,
  "if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v unzip >/dev/null || ! command -v xz >/dev/null || ! command -v make >/dev/null || ! command -v gcc >/dev/null || ! command -v python3 >/dev/null; then",
  systemPackages("git curl ca-certificates unzip xz-utils tar gzip make gcc g++ python3", "git curl ca-certificates unzip xz tar gzip make gcc gcc-c++ python3"),
  "fi",
  "if ! command -v rg >/dev/null; then",
  "case $(uname -m) in x86_64) target=x86_64-unknown-linux-musl;; aarch64|arm64) target=aarch64-unknown-linux-gnu;; *) echo 'Unsupported ripgrep architecture' >&2; exit 1;; esac",
  "mkdir -p \"$HOME/.local/bin\" /tmp/review-ripgrep",
  "curl --fail --location --silent --show-error \"https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-$target.tar.gz\" -o /tmp/review-ripgrep.tar.gz",
  "tar -xzf /tmp/review-ripgrep.tar.gz -C /tmp/review-ripgrep --strip-components=1",
  "install /tmp/review-ripgrep/rg \"$HOME/.local/bin/rg\"",
  "fi",
  "for tool in git curl unzip tar rg make; do command -v \"$tool\" >/dev/null; done",
].join("\n");

export async function bootstrapReviewEnvironment(sandbox: Pick<SetupSandbox, "run">): Promise<void> {
  const result = await sandbox.run({ command: bootstrapCommand });
  if (result.exitCode !== 0) throw new Error(`Review environment bootstrap failed (exit ${result.exitCode}): ${String(result.stderr || result.stdout).slice(-2000)}`);
}

export interface EnvironmentStep { readonly name: string; readonly command: string }
export interface EnvironmentPlan {
  readonly steps: readonly EnvironmentStep[];
  readonly tools: ReadonlyMap<string, string>;
}

const packageManifestSchema = z.object({
  packageManager: z.string().optional(), engines: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(), devDependencies: z.record(z.string(), z.unknown()).optional(),
});

export function selectNodeVersion(requirement: string, versions: readonly string[]): string {
  const selected = versions.map((value) => value.replace(/^v/, ""))
    .filter((value) => /^\d+\.\d+\.\d+$/.test(value) && satisfies(value, requirement))
    .sort(rcompare)[0];
  if (!selected) throw new Error(`No public Node release satisfies ${JSON.stringify(requirement)}`);
  return selected;
}

async function resolveNodeRuntime(sandbox: SetupSandbox, files: ReadonlyMap<string, string>, browserRequired: boolean): Promise<string | undefined> {
  const source = files.get("package.json") ?? (browserRequired ? "{}" : undefined);
  if (!source) return undefined;
  const pkg = packageManifestSchema.parse(JSON.parse(source));
  const pin = files.get(".node-version") ?? files.get(".nvmrc");
  const requirement = pin?.trim() ?? pkg.engines?.node ?? "24.x";
  const current = await sandbox.run({ command: 'export PATH="$HOME/.local/bin:$PATH"\nnode --version' });
  const installed = String(current.stdout).trim().replace(/^v/, "");
  let selected: string;
  if (current.exitCode === 0 && /^\d+\.\d+\.\d+$/.test(installed) && satisfies(installed, requirement)) {
    selected = installed;
  } else {
    const result = await sandbox.run({ command: "curl --fail --silent --show-error https://nodejs.org/dist/index.json" });
    if (result.exitCode !== 0) throw new Error("Review environment setup could not resolve the declared Node version");
    const releases = z.array(z.object({ version: z.string() })).parse(JSON.parse(String(result.stdout)));
    selected = selectNodeVersion(requirement, releases.map((release) => release.version));
  }
  if (pkg.engines?.node && !satisfies(selected, pkg.engines.node)) {
    throw new Error("Declared Node pin does not satisfy package.json engines.node");
  }
  return selected;
}

function version(value: string, label: string): string {
  const normalized = value.trim().replace(/^v/, "");
  if (!/^\d+(?:\.\d+){0,2}(?:-[a-zA-Z0-9.-]+)?$/.test(normalized)) {
    throw new Error(`Review environment setup cannot resolve ${label} version ${JSON.stringify(value)}; declare a numeric version`);
  }
  return normalized;
}

export function planReviewEnvironment(files: ReadonlyMap<string, string>, paths: readonly string[], resolvedNodeVersion?: string, browserRequired = false): EnvironmentPlan {
  const steps: EnvironmentStep[] = [];
  const tools = new Map<string, string>();
  function step(name: string, command: string) { steps.push({ name, command }); }
  function requireTool(name: string, install?: string, probe = `${name} --version`) {
    if (install) step(`install-${name}`, `if ! command -v ${name} >/dev/null; then ${install}; fi`);
    tools.set(name, probe);
  }
  const packageSource = files.get("package.json") ?? (browserRequired ? "{}" : undefined);
  if (packageSource) {
    const pkg = packageManifestSchema.parse(JSON.parse(packageSource));
    const nodeDeclaration = files.get(".node-version") ?? files.get(".nvmrc") ?? pkg.engines?.node;
    const nodeVersion = resolvedNodeVersion ?? (nodeDeclaration ? version(nodeDeclaration.replace(/\.x$/, ""), "Node") : "24");
    // Official Node release index resolves a major pin; exact pins use their archive directly.
    step("node-runtime", [
      `wanted=${quote(nodeVersion)}`,
      `if ! command -v node >/dev/null || ! node -e ${quote(`process.exit(process.versions.node === ${JSON.stringify(nodeVersion)} || process.versions.node.startsWith(${JSON.stringify(`${nodeVersion}.`)}) ? 0 : 1)`)}; then`,
      "case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported Node architecture' >&2; exit 1;; esac",
      "case $wanted in *.*.*) ;; *) wanted=$(curl --fail --silent --show-error https://nodejs.org/dist/index.tab | awk -v prefix=\"v$wanted.\" 'index($1,prefix)==1 { print substr($1,2); exit }'); test -n \"$wanted\";; esac",
      "mkdir -p \"$HOME/.local/node\" \"$HOME/.local/bin\"",
      "curl --fail --location --silent --show-error \"https://nodejs.org/dist/v$wanted/node-v$wanted-linux-$arch.tar.xz\" -o /tmp/review-node.tar.xz",
      "tar -xJf /tmp/review-node.tar.xz -C \"$HOME/.local/node\" --strip-components=1",
      "for tool in node npm npx; do ln -sf \"$HOME/.local/node/bin/$tool\" \"$HOME/.local/bin/$tool\"; done",
      "hash -r",
      "fi",
    ].join("\n"));
    tools.set("node", "node --version");
    const inferred = files.has("bun.lock") || files.has("bun.lockb") ? "bun" : files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : "npm";
    const manager = pkg.packageManager?.match(/^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$/);
    if (pkg.packageManager && !manager) throw new Error("Review environment setup requires a supported exact packageManager version");
    const name = manager?.[1] ?? inferred;
    const pin = manager?.[2] ?? (name === "bun" ? version(files.get(".bun-version") ?? pkg.engines?.bun ?? "1.4.2", "Bun") : undefined);
    if (name !== "npm" && !pin) throw new Error(`Review environment setup requires packageManager ${name}@<version>`);
    if (pin) {
      const managerLinks = name === "npm" ? ["npm", "npx"] : [name];
      // A separate prefix avoids npm refusing to replace the symlinks from the
      // Node archive. Only after installation succeeds do we switch PATH links.
      step(`${name}-runtime`, [
        `if ! command -v ${name} >/dev/null || [ \"$(${name} --version)\" != ${quote(pin)} ]; then`,
        `npm install --global --prefix "$HOME/.local/package-managers/${name}-${pin}" ${quote(`${name}@${pin}`)}`,
        `for tool in ${managerLinks.join(" ")}; do ln -sf "$HOME/.local/package-managers/${name}-${pin}/bin/$tool" "$HOME/.local/bin/$tool"; done`,
        "hash -r",
        "fi",
        `[ \"$(${name} --version)\" = ${quote(pin)} ]`,
      ].join("\n"));
    }
    tools.set(name, `${name} --version`);
    const locks: Record<string, readonly string[]> = { bun: ["bun.lock", "bun.lockb"], npm: ["package-lock.json", "npm-shrinkwrap.json"], pnpm: ["pnpm-lock.yaml"], yarn: ["yarn.lock"] };
    const locked = locks[name]!.some((path) => files.has(path));
    const hasDependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    if (hasDependencies && !locked) throw new Error(`Review environment setup requires the ${name} lockfile for reproducible dependency installation`);
    if (locked || hasDependencies) {
      const install = name === "npm" ? "npm ci --no-audit --no-fund" : name === "yarn" ? `yarn install ${pin?.startsWith("1.") ? "--frozen-lockfile" : "--immutable"}` : `${name} install --frozen-lockfile`;
      step("repository-dependencies", install);
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ("@playwright/test" in deps || "playwright" in deps) {
      step("browser-runtime", [
        "test -x node_modules/.bin/playwright",
        "if command -v apt-get >/dev/null; then node_modules/.bin/playwright install --with-deps chromium;",
        "elif command -v dnf >/dev/null; then",
        "sudo dnf install -y atk at-spi2-atk at-spi2-core cups-libs libdrm libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon mesa-libgbm nss nspr alsa-lib pango cairo",
        "node_modules/.bin/playwright install chromium",
        "else echo 'No supported browser library installer for this platform' >&2; exit 1; fi",
      ].join("\n"));
      const browserModule = "playwright" in deps ? "playwright" : "@playwright/test";
      step("browser-smoke", `node --input-type=module -e ${quote(`import { chromium } from ${JSON.stringify(browserModule)}; const browser = await chromium.launch(); try { const page = await browser.newPage(); if (await page.evaluate(() => 1 + 1) !== 2) throw new Error('Browser execution failed'); } finally { await browser.close(); }`)}`);
    }
    if (browserRequired) step("reviewer-browser-runtime", "@agent-browser/eve/sandbox:installAgentBrowser");
  }
  if (paths.some((path) => /\.(pas|pp|lpr)$/i.test(path)) || files.has("fpmake.pp")) {
    const fpcVersion = version(files.get(".fpc-version") ?? "3.2.2", "FPC");
    requireTool("fpc", [
      "if command -v apt-get >/dev/null; then",
      "sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y fp-compiler fp-units-base fp-units-fcl fp-units-net",
      "elif command -v dnf >/dev/null && [ \"$(uname -m)\" = x86_64 ]; then",
      // Amazon Linux does not provide FPC in its default repositories. Use the
      // official upstream RPM, which contains the compiler and standard units.
      `sudo dnf install -y ${quote(`https://downloads.freepascal.org/fpc/dist/${fpcVersion}/x86_64-linux/fpc-${fpcVersion}-1.x86_64.rpm`)}`,
      "else echo 'No supported FPC installer for this platform' >&2; exit 1; fi",
    ].join("\n"), "fpc -iV");
    requireTool("make", systemPackages("make"));
    if (files.has(".fpc-version")) step("fpc-version", `[ \"$(fpc -iV)\" = ${quote(version(files.get(".fpc-version")!, "FPC"))} ] || { echo 'Installed FPC does not match .fpc-version' >&2; exit 1; }`);
  }
  if (files.has("lwpt.toml")) {
    const pins = new Set<string>();
    if (files.has(".lwpt-version")) pins.add(version(files.get(".lwpt-version")!, "LWPT"));
    for (const [path, source] of files) {
      if (!path.startsWith(".github/workflows/")) continue;
      const workflow = z.object({ env: z.object({ LWPT_VERSION: z.string().optional() }).passthrough().optional() }).passthrough().parse(parseYaml(source));
      if (workflow.env?.LWPT_VERSION) pins.add(version(workflow.env.LWPT_VERSION, "LWPT"));
    }
    if (pins.size !== 1) throw new Error("Review environment setup needs one unambiguous LWPT version in .lwpt-version or workflow env.LWPT_VERSION");
    const pin = [...pins][0]!;
    step("lwpt-runtime", [
      "case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported LWPT architecture' >&2; exit 1;; esac",
      `asset=lwpt-${pin}-linux-$arch`,
      `base=https://github.com/frostney/lwpt/releases/download/${pin}`,
      "mkdir -p /tmp/review-lwpt \"$HOME/.local/bin\"",
      "curl --fail --location --silent --show-error \"$base/$asset.tar.gz\" -o \"/tmp/review-lwpt/$asset.tar.gz\"",
      `curl --fail --location --silent --show-error "$base/lwpt-${pin}-checksums.txt" -o /tmp/review-lwpt/checksums.txt`,
      "(cd /tmp/review-lwpt && awk -v asset=\"$asset.tar.gz\" '$2 == asset { print; found=1 } END { if (!found) exit 1 }' checksums.txt > selected-checksum && sha256sum -c selected-checksum)",
      "tar -xzf \"/tmp/review-lwpt/$asset.tar.gz\" -C /tmp/review-lwpt",
      "install \"/tmp/review-lwpt/$asset/lwpt\" \"$HOME/.local/bin/lwpt\"",
    ].join("\n"));
    tools.set("lwpt", "lwpt --version");
    if (!files.has("lwpt.lock")) throw new Error("Review environment setup requires lwpt.lock");
    step("pascal-dependencies", "lwpt install --frozen");
  }
  if (files.has("pyproject.toml") || files.has("requirements.txt")) {
    requireTool("uv", "curl --fail --location --silent --show-error https://astral.sh/uv/install.sh -o /tmp/review-uv-install.sh && sh /tmp/review-uv-install.sh");
    if (files.has("uv.lock")) step("python-dependencies", "uv sync --frozen");
    else if (files.has("requirements.txt")) step("python-dependencies", "uv venv && uv pip sync requirements.txt");
    else throw new Error("Review environment setup needs uv.lock or requirements.txt for this Python project");
    tools.set("python", "uv run --no-sync python --version");
  }
  if (files.has("Cargo.toml")) {
    requireTool("cargo", "curl --fail --location --silent --show-error https://sh.rustup.rs -o /tmp/review-rustup.sh && sh /tmp/review-rustup.sh -y --profile minimal && ln -sf \"$HOME/.cargo/bin/cargo\" \"$HOME/.local/bin/cargo\" && ln -sf \"$HOME/.cargo/bin/rustc\" \"$HOME/.local/bin/rustc\"");
    tools.set("rustc", "rustc --version");
    if (!files.has("Cargo.lock")) throw new Error("Review environment setup requires Cargo.lock");
    step("rust-dependencies", "cargo fetch --locked");
  }
  if (files.has("go.mod")) {
    requireTool("go", systemPackages("golang-go", "golang"), "go version");
    step("go-dependencies", "go mod download");
  }
  if (files.has("CMakeLists.txt")) requireTool("cmake", systemPackages("cmake"));
  if (files.has("Makefile")) requireTool("make", systemPackages("make"));
  for (const [marker, command, probe] of [
    ["Gemfile", "bundle", "bundle check"], ["composer.json", "composer", "composer install --no-interaction --prefer-dist"],
    ["Package.swift", "swift", "swift package resolve"], ["build.gradle", "gradle", "gradle dependencies"],
    ["build.gradle.kts", "gradle", "gradle dependencies"], ["pom.xml", "mvn", "mvn dependency:go-offline"],
    ["deno.json", "deno", "deno install --frozen"], ["deno.jsonc", "deno", "deno install --frozen"],
    ["global.json", "dotnet", "dotnet restore --locked-mode"],
  ] as const) {
    if (!files.has(marker)) continue;
    // Unavailable platform/toolchain requirements are execution failures, never a successful inventory gap.
    step(`${command}-dependencies`, `command -v ${command} >/dev/null || { echo ${quote(`Required ${command} toolchain is unavailable; no supported installer for this sandbox`)} >&2; exit 1; }\n${probe}`);
    tools.set(command, `${command} --version`);
  }
  return { steps, tools };
}

export const reviewerBrowserInstallSpec = "agent-browser@0.37.1";

export async function prepareReviewerBrowser(sandbox: Pick<SetupSandbox, "run">): Promise<NonNullable<EnvironmentSetup["browser"]>> {
  const nativeSandbox = {
    id: "review-setup",
    async run({ command }: { readonly command: string }) {
      const result = await sandbox.run({ command: `export PATH="$HOME/.local/bin:$PATH"\nexport NPM_CONFIG_PREFIX="$HOME/.local"\n${command}` });
      return { exitCode: result.exitCode, stdout: String(result.stdout), stderr: String(result.stderr) };
    },
  };
  await installAgentBrowser(nativeSandbox, { installSpec: reviewerBrowserInstallSpec });
  const location = await sandbox.run({ command: 'printf "%s/.local/bin/agent-browser" "$HOME"' });
  const command = String(location.stdout).trim();
  if (location.exitCode !== 0 || !command.startsWith("/")) throw new Error("Review browser installer did not provide an absolute executable path");
  const version = await nativeSandbox.run({ command: `${quote(command)} --version` });
  if (version.exitCode !== 0 || !version.stdout.trim()) throw new Error("Review browser executable verification failed");
  try {
    const opened = await nativeSandbox.run({ command: buildAgentBrowserCommand(["open", "about:blank"], { binary: command, session: "review-setup", json: false }) });
    if (opened.exitCode !== 0) throw new Error(`Review browser smoke failed: ${opened.stderr.slice(-1000)}`);
  } finally {
    const closed = await nativeSandbox.run({ command: buildAgentBrowserCommand(["close"], { binary: command, session: "review-setup", json: false }) });
    if (closed.exitCode !== 0) throw new Error(`Review browser cleanup failed: ${closed.stderr.slice(-1000)}`);
  }
  return { provider: "agent-browser", command, version: version.stdout.trim() };
}

export async function prepareReviewEnvironment(sandbox: SetupSandbox, identity: ReviewEvidenceIdentity, review: { readonly paths: readonly string[]; readonly publicRoots: readonly string[] } = { paths: [], publicRoots: [] }): Promise<EnvironmentSetup> {
  const listed = await sandbox.run({ command: "cd /workspace && git ls-files -z" });
  if (listed.exitCode !== 0) throw new Error("Review environment setup could not inventory the exact checkout");
  const paths = String(listed.stdout).split("\0").filter(Boolean);
  const files = new Map<string, string>();
  const inputPaths = [...declarations, ...paths.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))];
  for (const path of inputPaths) {
    if (!paths.includes(path)) continue;
    // Read the committed declaration so setup cannot use a leftover dependency manifest.
    const result = await sandbox.run({ command: `cd /workspace && git show ${quote(`${identity.headSha}:${path}`)}${path === "bun.lockb" ? " | sha256sum" : ""}` });
    if (result.exitCode !== 0) throw new Error(`Review environment setup could not read ${path}`);
    files.set(path, String(result.stdout));
  }
  const browserRequired = discoverabilityApplies(review.paths, review.publicRoots) || review.paths.some((path) => /\.(?:[jt]sx|vue|svelte|html?)$/i.test(path));
  const plan = planReviewEnvironment(files, paths, await resolveNodeRuntime(sandbox, files, browserRequired), browserRequired);
  const completedSteps: string[] = [];
  let browser: EnvironmentSetup["browser"];
  for (const step of plan.steps) {
    if (step.name === "reviewer-browser-runtime") {
      browser = await prepareReviewerBrowser(sandbox);
      completedSteps.push(step.name);
      continue;
    }
    const result = await sandbox.run({ command: `set -eu\nexport PATH=\"$HOME/.local/bin:$PATH\"\ncd /workspace\n${step.command}` });
    if (result.exitCode !== 0) throw new Error(`Review environment setup failed at ${step.name} (exit ${result.exitCode}): ${String(result.stderr || result.stdout).slice(-2000)}`);
    completedSteps.push(step.name);
  }
  const observedTools: EnvironmentSetup["tools"] = [];
  for (const [name, command] of plan.tools) {
    const result = await sandbox.run({ command: `export PATH=\"$HOME/.local/bin:$PATH\"\ncd /workspace && ${command}` });
    if (result.exitCode !== 0 || !String(result.stdout).trim()) throw new Error(`Review environment setup could not verify ${name}`);
    observedTools.push({ name, version: String(result.stdout).trim().slice(0, 500) });
  }
  const unchanged = await sandbox.run({ command: `cd /workspace && git diff --exit-code ${quote(identity.headSha)} -- && test \"$(git rev-parse HEAD)\" = ${quote(identity.headSha)}` });
  if (unchanged.exitCode !== 0) throw new Error("Review environment setup changed the checkout or dependency declarations");
  return environmentSetupSchema.parse({ revision: setupRevision, headSha: identity.headSha, inputsDigest: digest([...files]), tools: observedTools, completedSteps, ...(browser ? { browser } : {}) });
}
