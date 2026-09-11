import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import definition from "../agent/sandbox";
import { bootstrapCommand, httpsAptSourcesCommand, persistReviewPathCommand, planReviewEnvironment, prepareReviewEnvironment, prepareReviewerBrowser, selectNodeVersion } from "../src/review/environment-setup";
import { reviewNetworkPolicy } from "../src/github/review-workspace";
import { discoverabilityApplies } from "../src/review/discoverability";

describe("review environment setup", () => {
  test("rewrites official HTTP apt mirrors in list and deb822 sources for the domain firewall", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-apt-"));
    try {
      await mkdir(join(root, "sources.list.d"));
      await writeFile(join(root, "sources.list"), "deb http://deb.debian.org/debian stable main\ndeb http://private.example/repo stable main\n");
      await writeFile(join(root, "sources.list.d/ubuntu.sources"), "URIs: http://archive.ubuntu.com/ubuntu/ http://security.ubuntu.com/ubuntu/\n");
      const command = httpsAptSourcesCommand.replaceAll("/etc/apt", root).replaceAll("/var/lib/slop-sheriff", join(root, "state")).replace("sudo sed -i -E", process.platform === "darwin" ? "sed -i '' -E" : "sed -i -E").replaceAll("sudo ", "");
      const child = Bun.spawn(["bash", "-ec", command], { stdout: "pipe", stderr: "pipe" });
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      expect(await readFile(join(root, "apt.conf.d/99-review-network"), "utf8")).toContain('Acquire::https::Pipeline-Depth "0";');
      expect(await readFile(join(root, "sources.list"), "utf8")).toBe("deb https://deb.debian.org/debian stable main\ndeb http://private.example/repo stable main\n");
      expect(await readFile(join(root, "sources.list.d/ubuntu.sources"), "utf8")).toBe("URIs: https://archive.ubuntu.com/ubuntu/ https://security.ubuntu.com/ubuntu/\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("official Eve bootstrap hook rejects a nonzero command before caching", async () => {
    let command = "";
    const use = async () => ({
      run: async (input: { command: string }) => {
        command = input.command;
        return { exitCode: 17, stdout: "", stderr: "registry unavailable" };
      },
    }) as unknown as SandboxSession;
    await expect(definition.bootstrap!({ use })).rejects.toThrow("bootstrap failed (exit 17)");
    expect(command).toBe(bootstrapCommand);
    await expect(definition.bootstrap!({ use: async () => ({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) as unknown as SandboxSession })).resolves.toBeUndefined();
  });

  test("Bun 1.4.2, Node 24 and locked dependencies are installed before browser setup", () => {
    const plan = planReviewEnvironment(new Map([
      ["package.json", JSON.stringify({ packageManager: "bun@1.4.2", engines: { node: "24.x" }, devDependencies: { "@playwright/test": "1.55.0" } })],
      ["bun.lock", "fixture lockfile"],
    ]), ["package.json", "bun.lock"], undefined, true);
    expect(plan.steps.map((step) => step.name)).toEqual(["node-runtime", "bun-runtime", "repository-dependencies", "browser-runtime", "browser-smoke", "reviewer-browser-runtime"]);
    expect(plan.steps[1]!.command).toContain("bun@1.4.2");
    expect(plan.steps[2]!.command).toBe("bun install --frozen-lockfile");
    expect(plan.steps[3]!.command).toContain("node_modules/.bin/playwright install --with-deps chromium");
  });

  test("this repo's changed landing gets a reviewer browser; a README delta does not", async () => {
    const manifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const files = new Map([["package.json", manifest], ["bun.lock", "fixture-lock"]]);
    const repositoryPaths = ["package.json", "bun.lock", "src/landing/page.ts", "README.md"];
    const ui = planReviewEnvironment(files, repositoryPaths, "24.18.0", discoverabilityApplies(["src/landing/page.ts"], []));
    expect(ui.steps.map((step) => step.name)).toContain("reviewer-browser-runtime");
    expect(ui.steps.map((step) => step.name)).not.toContain("browser-runtime");
    const docs = planReviewEnvironment(files, repositoryPaths, "24.18.0", discoverabilityApplies(["README.md"], []));
    expect(docs.steps.some((step) => step.name.includes("browser"))).toBe(false);
    expect(discoverabilityApplies(["src/views/product.ts"], ["src/views"])).toBe(true);
  });

  test("native Eve browser installation uses a local prefix and checks launch and cleanup", async () => {
    const commands: string[] = [];
    const browser = await prepareReviewerBrowser({
      run: async ({ command }) => {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: command.startsWith("printf") ? "/home/vercel-sandbox/.local/bin/agent-browser" : command.includes("--version") ? "agent-browser 0.37.1" : "" };
      },
    });
    expect(browser).toEqual({ provider: "agent-browser", command: "/home/vercel-sandbox/.local/bin/agent-browser", version: "agent-browser 0.37.1" });
    expect(commands.some((command) => command.includes("install -g agent-browser@0.37.1") && command.includes('NPM_CONFIG_PREFIX="$HOME/.local"'))).toBe(true);
    expect(commands.some((command) => command.includes("open about:blank"))).toBe(true);
    expect(commands.at(-1)).toContain("close");
    await expect(prepareReviewerBrowser({ run: async () => ({ exitCode: 9, stdout: "", stderr: "browser packages unavailable" }) })).rejects.toThrow();
  });

  test("resolves ordinary Node engine ranges with the installed semver implementation", () => {
    const versions = ["v18.20.8", "v20.19.0", "v22.16.0", "v24.18.0", "v25.0.0-rc.1"];
    expect(selectNodeVersion(">=18", versions)).toBe("24.18.0");
    expect(selectNodeVersion("^20.10.0 || >=22 <24", versions)).toBe("22.16.0");
    expect(selectNodeVersion("~20.19.0", versions)).toBe("20.19.0");
    expect(() => selectNodeVersion("<18", versions)).toThrow("No public Node release");
  });

  test("the production resolver executes under Node without a Bun global", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-node-runtime-"));
    try {
      const entry = join(root, "entry.ts");
      const modulePath = new URL("../src/review/environment-setup.ts", import.meta.url).pathname;
      await writeFile(entry, `import { selectNodeVersion } from ${JSON.stringify(modulePath)};\nif (typeof Bun !== "undefined") throw new Error("Expected the production Node runtime");\nconsole.log(JSON.stringify({ runtime: process.release.name, selected: selectNodeVersion(">=18 <24", ["18.20.8", "22.16.0", "24.18.0"]) }));\n`);
      const bundled = await Bun.build({ entrypoints: [entry], outdir: root, target: "node", format: "esm", naming: "resolver.mjs" });
      expect(bundled.success).toBe(true);
      const child = Bun.spawn(["node", join(root, "resolver.mjs")], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ runtime: "node", selected: "22.16.0" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("persists installed command precedence across fresh shells", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-path-"));
    async function run(command: string) {
      const child = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "/usr/bin:/bin" } });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode) throw new Error(stderr);
      return stdout.trim();
    }
    try {
      // Isolate profile writes without changing this process's HOME. A fresh
      // shell explicitly sources the same login profile Eve's bash -lc loads.
      const persist = persistReviewPathCommand.replaceAll("$HOME", root);
      await run(persist);
      await writeFile(join(root, ".local/bin/review-path-fixture"), "#!/bin/sh\nprintf 'prepared-runtime'\n", { mode: 0o755 });
      expect(await run(`. '${root}/.bash_profile' && review-path-fixture`)).toBe("prepared-runtime");
      await run(persist);
      expect((await readFile(join(root, ".bash_profile"), "utf8")).split("export PATH=").length).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("pinned npm switches Node archive symlinks only after installing into its own prefix", async () => {
    const plan = planReviewEnvironment(new Map([["package.json", JSON.stringify({ packageManager: "npm@11.5.2" })]]), ["package.json"]);
    const install = plan.steps.find((step) => step.name === "npm-runtime")!.command;
    const root = await mkdtemp(join(tmpdir(), "review-npm-"));
    async function run(command: string) {
      const child = Bun.spawn(["bash", "-c", command.replaceAll("$HOME", root)], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode) throw new Error(stderr);
      return stdout.trim();
    }
    try {
      await run('mkdir -p "$HOME/.local/bin" "$HOME/.local/node/bin"');
      // Simulate only an executable package installer, not an AI/provider mock.
      await writeFile(join(root, ".local/node/bin/npm"), `#!/bin/sh\nset -eu\nif [ "$1" = --version ]; then echo 10.0.0; exit; fi\n[ "$1" = install ] && [ "$2" = --global ] && [ "$3" = --prefix ]\ncase "$4" in */package-managers/npm-11.5.2) ;; *) exit 31;; esac\nmkdir -p "$4/bin"\nprintf '#!/bin/sh\\necho 11.5.2\\n' > "$4/bin/npm"\nchmod +x "$4/bin/npm"\ncp "$4/bin/npm" "$4/bin/npx"\n`, { mode: 0o755 });
      await run('ln -s "$HOME/.local/node/bin/npm" "$HOME/.local/bin/npm"');
      expect(await run(`set -eu\nexport PATH="$HOME/.local/bin:$PATH"\n${install}\nnpm --version\nnpx --version`)).toBe("11.5.2\n11.5.2");
      expect(await run('"$HOME/.local/node/bin/npm" --version')).toBe("10.0.0");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("Pascal uses FPC and the declared checksum-verified LWPT release", () => {
    const plan = planReviewEnvironment(new Map([
      ["lwpt.toml", "[package]\nname='fixture'"], ["lwpt.lock", "fixture lock"],
      [".github/workflows/ci.yml", 'env:\n  LWPT_VERSION: "0.5.1"\n'],
    ]), ["source/main.pas", "lwpt.toml", "lwpt.lock"]);
    expect(plan.steps.find((step) => step.name === "install-fpc")?.command).toContain("fp-units-fcl");
    expect(plan.steps.find((step) => step.name === "lwpt-runtime")?.command).toContain("releases/download/0.5.1");
    expect(plan.steps.find((step) => step.name === "lwpt-runtime")?.command).toContain("sha256sum -c");
    expect(plan.steps.at(-1)?.command).toBe("lwpt install --frozen");
    expect(plan.tools.get("fpc")).toBe("fpc -iV");
  });

  test("unlocked dependencies and ambiguous runtime declarations fail before execution", () => {
    expect(() => planReviewEnvironment(new Map([["package.json", JSON.stringify({ dependencies: { react: "19.0.0" } })]]), ["package.json"]))
      .toThrow("requires the npm lockfile");
    expect(() => planReviewEnvironment(new Map([["package.json", JSON.stringify({ packageManager: "bun@$(env)" })]]), ["package.json"]))
      .toThrow("supported exact packageManager");
    expect(() => planReviewEnvironment(new Map([["lwpt.toml", ""]]), ["main.pas", "lwpt.toml"]))
      .toThrow("unambiguous LWPT version");
  });

  test("package policy is credential-free and denies supported private network ranges", () => {
    expect(reviewNetworkPolicy).toMatchObject({ subnets: { deny: expect.arrayContaining(["127.0.0.0/8", "10.0.0.0/8", "169.254.0.0/16"]) } });
    expect(JSON.stringify(reviewNetworkPolicy)).not.toContain("transform");
    expect(JSON.stringify(reviewNetworkPolicy)).toContain("registry.npmjs.org");
    expect(JSON.stringify(reviewNetworkPolicy)).toContain("googlechromelabs.github.io");
  });

  test("a failing installer produces no success receipt or later inventory", async () => {
    const commands: string[] = [];
    const manifest = JSON.stringify({ packageManager: "bun@1.4.2", engines: { node: "24.x" } });
    await expect(prepareReviewEnvironment({
      readTextFile: async () => null,
      run: async ({ command }) => {
        commands.push(command);
        if (command.endsWith("node --version")) return { exitCode: 0, stdout: "v24.18.0", stderr: "" };
        if (command.endsWith("git ls-files -z")) return { exitCode: 0, stdout: "package.json\0bun.lock\0", stderr: "" };
        if (command.includes("git show")) return { exitCode: 0, stdout: command.includes(":package.json") ? manifest : "lock", stderr: "" };
        if (command.includes("bun install --frozen-lockfile")) return { exitCode: 1, stdout: "", stderr: "Private package requires authorization" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }, { baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64) }))
      .rejects.toThrow("repository-dependencies (exit 1)");
    expect(commands.at(-1)).toContain("bun install --frozen-lockfile");
  });

  test("runs a real locked local Bun dependency install and binds the receipt to checkout inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-environment-"));
    async function run(command: string) {
      // This local fixture must never download/install host runtimes. Production
      // commands execute normally when the already-installed versions match.
      const offlineGuards = "curl() { echo 'Fixture forbids network downloads' >&2; return 90; }; npm() { echo 'Fixture forbids host runtime installation' >&2; return 90; };\n";
      const child = Bun.spawn(["bash", "-c", offlineGuards + command.replaceAll("/workspace", root)], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    }
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "offline-setup-fixture", packageManager: `bun@${Bun.version}`, engines: { node: ">=18" }, dependencies: { "local-fixture": "file:./dependency" }, scripts: { postinstall: `node -e 'const fs = require("fs"); if (fs.existsSync("mutate-marker")) fs.writeFileSync("app.js", "mutated");'` } }));
      await writeFile(join(root, "app.js"), "export const original = true;\n");
      const mkdir = await run("mkdir dependency");
      expect(mkdir.exitCode).toBe(0);
      await writeFile(join(root, "dependency/package.json"), JSON.stringify({ name: "local-fixture", version: "1.0.0", main: "index.js" }));
      await writeFile(join(root, "dependency/index.js"), "module.exports = 42;\n");
      expect((await run("bun install --lockfile-only")).exitCode).toBe(0);
      expect((await run("git init -q && git -c user.name=Fixture -c user.email=fixture@example.test add package.json bun.lock dependency app.js && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture")).exitCode).toBe(0);
      const headSha = (await run("git rev-parse HEAD")).stdout.trim();
      const setup = await prepareReviewEnvironment({ run: ({ command }) => run(command), readTextFile: async () => null }, { baseSha: headSha, headSha, patchFingerprint: "c".repeat(64) });
      expect(setup.headSha).toBe(headSha);
      expect(setup.inputsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(setup.tools).toContainEqual({ name: "bun", version: Bun.version });
      expect(setup.completedSteps).toContain("repository-dependencies");
      expect((await run("bun -e 'if (require(\"local-fixture\") !== 42) process.exit(1)' ")).exitCode).toBe(0);
      await writeFile(join(root, "mutate-marker"), "");
      await expect(prepareReviewEnvironment({ run: ({ command }) => run(command), readTextFile: async () => null }, { baseSha: headSha, headSha, patchFingerprint: "c".repeat(64) }))
        .rejects.toThrow("changed the checkout");
      expect(await readFile(join(root, "app.js"), "utf8")).toBe("mutated");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
