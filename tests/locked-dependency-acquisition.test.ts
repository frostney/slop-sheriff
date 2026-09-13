import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { acquireLockedEcosystemDependencies, materializeLockedEcosystemDependencies } from "../src/review/locked-dependency-acquisition";
import fixture from "./fixtures/lwpt-0.5.1-acquisition.json";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function environment() {
  const temporary = await mkdtemp(join(tmpdir(), "lwpt-acquisition-test-"));
  const project = join(temporary, "project"), cache = join(temporary, "cache");
  await mkdir(project); await mkdir(cache);
  for (const [path, content] of Object.entries(fixture.localFiles)) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const commands: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sandbox = { async run({ command }: { command: string }) {
    commands.push(command);
    const rewritten = command.replace(" /workspace ", ` ${quote(project)} `).replaceAll("/tmp/slop-sheriff-locked-cache", cache);
    const process = Bun.spawn(["sh", "-c", rewritten], { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { exitCode, stdout, stderr };
  } } as unknown as SandboxSession;
  return { temporary, project, cache, commands, env, sandbox, files: new Map([["lwpt.toml", fixture.manifest], ["lwpt.lock", fixture.lock]]),
    async cleanup() { await rm(temporary, { recursive: true, force: true }); } };
}

test("materializes the native 0.5.1 frozen-verified filtered archive and local package without running hooks", async () => {
  const env = await environment();
  try {
    await writeFile(join(env.cache, fixture.archiveSha256 + ".tar.gz"), Buffer.from(fixture.archiveBase64, "base64"));
    expect(await acquireLockedEcosystemDependencies(env.sandbox, env.files, [])).toEqual(["/tmp/slop-sheriff-locked-cache"]);
    expect(await Bun.file(join(env.project, "hook-ran")).exists()).toBe(false);
    await materializeLockedEcosystemDependencies(env.sandbox, env.files);
    expect(await readFile(join(env.project, "vendor/modules/remote/packages/lib/Keep.pas"), "utf8")).toContain("unit Keep;");
    expect(await Bun.file(join(env.project, "vendor/modules/remote/packages/lib/Drop.Test.pas")).exists()).toBe(false);
    expect(await Bun.file(join(env.project, "vendor/modules/remote/README.md")).exists()).toBe(false);
    expect(await readFile(join(env.project, "vendor/modules/localdep/src/Local.pas"), "utf8")).toContain("unit Local;");
    expect(await Bun.file(join(env.project, "vendor/modules/localdep/Skip.txt")).exists()).toBe(false);
    expect(await Bun.file(join(env.project, "hook-ran")).exists()).toBe(false);
    expect(env.commands.every(command => command.startsWith("python3 -I -c "))).toBe(true);
    // Existing materialization is evidence: never overwrite it to force a green hash.
    const changed = join(env.project, "vendor/modules/remote/packages/lib/Keep.pas");
    await writeFile(changed, "changed repository materialization");
    await materializeLockedEcosystemDependencies(env.sandbox, env.files);
    expect(await readFile(changed, "utf8")).toBe("changed repository materialization");
    expect(fixture.nativeFrozenOutput).toContain("archive + tree hashes both match");
  } finally { await env.cleanup(); }
});

test("downloads only locked HTTPS archive bytes and rejects content-hash mismatch before materialization", async () => {
  const env = await environment();
  const key = join(env.temporary, "key.pem"), cert = join(env.temporary, "cert.pem");
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdout: "pipe", stderr: "pipe" });
  expect(await openssl.exited).toBe(0);
  const requests: string[] = [];
  let corrupt = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: await readFile(key), cert: await readFile(cert) },
    fetch(request) { requests.push(new URL(request.url).pathname); return new Response(corrupt ? "wrong archive" : Buffer.from(fixture.archiveBase64, "base64")); } });
  try {
    env.env.SSL_CERT_FILE = cert;
    env.files.set("lwpt.lock", fixture.lock.replace("https://github.com/acme/lwpt-fixture/archive/pinned.tar.gz\"\ncomputedHash", `https://localhost:${server.port}/pinned.tar.gz"\ncomputedHash`));
    await acquireLockedEcosystemDependencies(env.sandbox, env.files, []);
    expect(requests).toEqual(["/pinned.tar.gz"]);
    expect(await Bun.file(join(env.project, "hook-ran")).exists()).toBe(false);
    expect(createHash("sha256").update(await readFile(join(env.cache, fixture.archiveSha256 + ".tar.gz"))).digest("hex")).toBe(fixture.archiveSha256);
    await rm(join(env.cache, fixture.archiveSha256 + ".tar.gz"));
    corrupt = true;
    await expect(acquireLockedEcosystemDependencies(env.sandbox, env.files, [])).rejects.toThrow("SHA-256 mismatch");
    expect(await Bun.file(join(env.cache, fixture.archiveSha256 + ".tar.gz")).exists()).toBe(false);
    expect(await Bun.file(join(env.project, "hook-ran")).exists()).toBe(false);
  } finally { server.stop(); await env.cleanup(); }
});

test.each(["parent-path", "link-escape"])("offline extraction rejects %s even when the malicious archive hash is pinned", async kind => {
  const env = await environment();
  try {
    const file = join(env.temporary, "malicious.tar.gz");
    const code = `import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo('root/../../escape' if sys.argv[2]=='parent-path' else 'root/link')\n if sys.argv[2]=='parent-path':\n  m.size=1;t.addfile(m,io.BytesIO(b'x'))\n else:\n  m.type=tarfile.SYMTYPE;m.linkname='../../escape';t.addfile(m)\n`;
    const process = Bun.spawn(["python3", "-I", "-c", code, file, kind], { stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    const archive = await readFile(file), digest = createHash("sha256").update(archive).digest("hex");
    await writeFile(join(env.cache, digest + ".tar.gz"), archive);
    env.files.set("lwpt.lock", fixture.lock.replaceAll(fixture.archiveSha256, digest));
    await expect(materializeLockedEcosystemDependencies(env.sandbox, env.files)).rejects.toThrow(kind === "parent-path" ? "Unsafe LWPT archive entry" : "escapes its root");
    expect(await Bun.file(join(env.project, "escape")).exists()).toBe(false);
  } finally { await env.cleanup(); }
});

test("legacy policies come from inert manifests and unsafe local roots are rejected", async () => {
  const env = await environment();
  try {
    await writeFile(join(env.cache, fixture.archiveSha256 + ".tar.gz"), Buffer.from(fixture.archiveBase64, "base64"));
    env.files.set("lwpt.lock", fixture.lock.replace(/^sourceIdentity = .*\n/gm, "").replace("version = 3", "version = 2"));
    await materializeLockedEcosystemDependencies(env.sandbox, env.files);
    expect(await Bun.file(join(env.project, "vendor/modules/remote/packages/lib/Drop.Test.pas")).exists()).toBe(false);
    await rm(join(env.project, "vendor/modules/localdep"), { recursive: true });
    env.files.set("lwpt.lock", fixture.lock.replace("local|packages/local", "local|../../outside"));
    await expect(materializeLockedEcosystemDependencies(env.sandbox, env.files)).rejects.toThrow("Unsafe LWPT path");
  } finally { await env.cleanup(); }
});
