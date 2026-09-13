import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { withAcquisitionSandbox, requireSandboxCommand, transferSandboxFile, type AcquisitionFactory } from "./sandbox-acquisition";

// Record system packages before trusted installers run, then export only files
// belonging to newly installed/upgraded packages and user-scoped tool/cache
// directories. The acquisition VM has never executed repository code.
const packageInventory = "if command -v rpm >/dev/null; then rpm -qa | sort; else dpkg-query -W -f='${Package}=${Version}\\n' | sort; fi";
export const beginAcquisitionCommand = `set -eu\nmkdir -p /workspace\n${packageInventory} > /tmp/review-packages-before`;
export const exportAcquisitionCommand = `set -eu
${packageInventory} > /tmp/review-packages-after
python3 - <<'PY'
import os, subprocess
before = set(open('/tmp/review-packages-before').read().splitlines())
after = set(open('/tmp/review-packages-after').read().splitlines())
paths = set()
for package in sorted(after - before):
    args = ['rpm', '-ql', package] if os.path.exists('/usr/bin/rpm') else ['dpkg-query', '-L', package.split('=')[0]]
    for path in subprocess.check_output(args, text=True).splitlines():
        if path.startswith(('/usr/', '/lib/', '/lib64/', '/etc/', '/opt/', '/bin/', '/sbin/')) and os.path.lexists(path):
            paths.add(path.lstrip('/'))
for path in [os.path.expanduser('~/'+name) for name in ['.local', '.cache', '.agent-browser', '.bun', '.npm', '.cargo', '.rustup']] + [os.path.expanduser(path) for path in []]:
    if not os.path.lexists(path): continue
    paths.add(path.lstrip('/'))
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files: paths.add(os.path.join(root, name).lstrip('/'))
with open('/tmp/review-acquisition-files', 'wb') as output:
    for path in sorted(paths): output.write(path.encode() + b'\\0')
PY
sudo tar --no-recursion --null -C / -T /tmp/review-acquisition-files -czf /tmp/review-environment.tar.gz
sudo chmod a+r /tmp/review-environment.tar.gz`;

export interface ProvisioningDestination extends Pick<SandboxSession, "writeBinaryFile"> {
  run(input: { readonly command: string }): PromiseLike<{ readonly exitCode: number; readonly stdout: unknown; readonly stderr: unknown }>;
}

export async function acquireEnvironment<T>(destination: ProvisioningDestination, provision: (sandbox: SandboxSession) => Promise<T>, factory?: AcquisitionFactory, extraRoots: () => readonly string[] = () => []): Promise<T> {
  return withAcquisitionSandbox(async (acquisition) => {
    await requireSandboxCommand(acquisition, beginAcquisitionCommand, "Tool acquisition initialization");
    const result = await provision(acquisition);
    await requireSandboxCommand(acquisition, exportAcquisitionCommand.replace("for path in []", `for path in ${JSON.stringify(extraRoots())}`), "Tool acquisition export");
    await transferSandboxFile(acquisition, destination, "/tmp/review-environment.tar.gz");
    await requireSandboxCommand(destination, "sudo tar -C / -xzf /tmp/review-environment.tar.gz && rm /tmp/review-environment.tar.gz && sudo ldconfig", "Offline tool materialization");
    return result;
  }, factory);
}

// Project configs (.npmrc, bunfig, Yarn plugins, Python backends, Gradle and
// Swift programs, etc.) never enter the acquisition VM. JSON manifests are
// projected to package resolution data and scripts are unconditionally disabled.
const dependencyMap = z.record(z.string(), z.string());
const acquisitionManifestSchema = z.object({
  name: z.string().optional(), version: z.string().optional(), private: z.boolean().optional(),
  dependencies: dependencyMap.optional(), devDependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(), peerDependencies: dependencyMap.optional(),
  overrides: z.record(z.string(), z.unknown()).optional(), resolutions: dependencyMap.optional(),
  workspaces: z.union([z.array(z.string()), z.object({ packages: z.array(z.string()) })]).optional(),
});

export function projectAcquisitionManifest(source: string): string {
  return JSON.stringify(acquisitionManifestSchema.parse(JSON.parse(source)));
}

export function acquisitionDeclarationPath(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Unsafe acquisition declaration path");
  }
  return path;
}

export function acquisitionRustChannel(files: ReadonlyMap<string, string>): string | undefined {
  const source = files.get("rust-toolchain.toml") ?? files.get("rust-toolchain");
  if (!source) return undefined;
  // Rustup path toolchains can execute a PR-provided rustc during cargo fetch.
  // Only an official distribution channel crosses the acquisition boundary.
  const channel = source.includes("[toolchain]") ? source.match(/^\s*channel\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1] : source.trim();
  if (!channel || !/^(?:\d+\.\d+(?:\.\d+)?|stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?$/.test(channel)) {
    throw new Error("Rust acquisition requires an official toolchain channel");
  }
  return channel;
}

export function dependencyAcquisitionCommand(command: string): string {
  if (/^bun install --frozen-lockfile$/.test(command)) return `${command} --ignore-scripts`;
  if (/^npm ci --no-audit --no-fund$/.test(command)) return `${command} --ignore-scripts`;
  if (/^pnpm install --frozen-lockfile$/.test(command)) return `${command} --ignore-scripts --ignore-pnpmfile`;
  // Yarn modern lockfiles may request executable plugins; do not evaluate them
  // during acquisition. Yarn 1 has a complete script-disable installation path.
  if (command === "yarn install --frozen-lockfile") return `${command} --ignore-scripts`;
  throw new Error("This dependency resolver requires an offline acquisition adapter; repository code cannot run in the download sandbox");
}
