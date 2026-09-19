import { randomUUID } from "node:crypto";
import { vercel } from "eve/sandbox/vercel";
import type { SandboxSession, SandboxNetworkPolicy } from "eve/sandbox";

// This policy belongs exclusively to fresh acquisition VMs. A review VM must
// never receive it, even during setup, retry, or filesystem restoration.
export const acquisitionNetworkPolicy: SandboxNetworkPolicy = {
  allow: [
    "github.com", "*.github.com", "*.githubusercontent.com",
    "registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org", "bun.sh",
    "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "*.archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com",
    "cdn.amazonlinux.com", "*.amazonlinux.com", "downloads.freepascal.org",
    "astral.sh", "releases.astral.sh", "pypi.org", "files.pythonhosted.org",
    "sh.rustup.rs", "static.rust-lang.org", "index.crates.io", "static.crates.io", "crates.io",
    "proxy.golang.org", "sum.golang.org", "go.dev", "dl.google.com", "storage.googleapis.com",
    "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "cdn.puppeteer.dev", "googlechromelabs.github.io",
  ],
  subnets: { deny: ["10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"] },
};

export interface AcquisitionSandbox {
  readonly session: SandboxSession;
  delete(): Promise<void>;
}
export type AcquisitionFactory = () => Promise<AcquisitionSandbox>;

// Native Eve/Vercel lifecycle, a unique physical VM on every acquisition. Never
// fork a review VM or reuse its home, /tmp, executable search path, or processes.
export const createAcquisitionSandbox: AcquisitionFactory = async () => {
  const backend = vercel({ networkPolicy: acquisitionNetworkPolicy, resources: { vcpus: 2 } });
  return backend.create({ templateKey: null, sessionKey: `review-acquisition-${randomUUID()}`, runtimeContext: { appRoot: process.cwd() } });
};

export async function withAcquisitionSandbox<T>(work: (sandbox: SandboxSession) => Promise<T>, factory: AcquisitionFactory = createAcquisitionSandbox): Promise<T> {
  const acquired = await factory();
  try { return await work(acquired.session); }
  finally { await acquired.delete(); }
}

export async function requireSandboxCommand(sandbox: { run(input: { readonly command: string }): PromiseLike<{ readonly exitCode: number; readonly stdout: unknown; readonly stderr: unknown }> }, command: string, operation: string): Promise<void> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) throw new Error(`${operation} failed (exit ${result.exitCode}): ${String(result.stderr || result.stdout).slice(-2000)}`);
}

export async function transferSandboxFile(source: Pick<SandboxSession, "readBinaryFile"> & Parameters<typeof requireSandboxCommand>[0], destination: Pick<SandboxSession, "writeBinaryFile"> & Parameters<typeof requireSandboxCommand>[0], path: string): Promise<void> {
  if (!/^\/tmp\/review-[a-z-]+\.tar(?:\.gz)?$/.test(path)) throw new Error("Invalid acquisition artifact path");
  // Eve buffers Vercel file writes. A single long-lived read also expires during
  // large transfers. Separate bounded file requests avoid both failure modes.
  // Chunk size governs transport only; every byte of any size archive is sent.
  const uploadBytes = 8 * 1024 * 1024;
  const prefix = `${path}.${randomUUID()}.chunk-`;
  const divided = await source.run({ command: `split -b ${uploadBytes} -d -a 12 '${path}' '${prefix}' && stat -c '%s' '${path}'` });
  const observedSize = String(divided.stdout).trim();
  const size = Number(observedSize);
  if (divided.exitCode !== 0 || !/^\d+$/.test(observedSize) || !Number.isSafeInteger(size) || size < 0) throw new Error("Acquisition artifact chunk preparation failed");
  await requireSandboxCommand(destination, `rm -f '${path}' && touch '${path}'`, "Acquisition artifact initialization");
  for (let index = 0; index < Math.ceil(size / uploadBytes); index++) {
    const chunk = `${prefix}${String(index).padStart(12, "0")}`;
    const content = await source.readBinaryFile({ path: chunk });
    if (content === null || content.length !== Math.min(uploadBytes, size - index * uploadBytes)) throw new Error("Acquisition artifact chunk was truncated");
    await destination.writeBinaryFile({ path: chunk, content });
    await requireSandboxCommand(destination, `cat '${chunk}' >> '${path}' && rm '${chunk}'`, "Acquisition artifact transfer");
  }
}
