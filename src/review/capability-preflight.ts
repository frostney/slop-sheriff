import { createHash } from "node:crypto";
import { z } from "zod";
import { reviewEvidenceDirectory, type ReviewEvidenceIdentity } from "./evidence-bundle";
import { environmentSetupSchema, type EnvironmentSetup } from "./environment-setup";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const commandNameSchema = z.string().regex(/^[a-z0-9][a-z0-9+._-]*$/);

export const capabilityCommandNames = [
  "bash",
  "bundle",
  "bun",
  "cargo",
  "cmake",
  "composer",
  "deno",
  "dotnet",
  "fpc",
  "git",
  "go",
  "gradle",
  "java",
  "lwpt",
  "make",
  "mvn",
  "node",
  "npm",
  "php",
  "pnpm",
  "python",
  "python3",
  "rg",
  "ruby",
  "rustc",
  "swift",
  "uv",
  "xcodebuild",
  "yarn",
] as const;

export const capabilityRepositoryMarkers = [
  ".github/workflows",
  "Cargo.toml",
  "CMakeLists.txt",
  "Gemfile",
  "Makefile",
  "Package.swift",
  "build.gradle",
  "build.gradle.kts",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "go.mod",
  "gradlew",
  "lwpt.toml",
  "lwpt.lock",
  "mvnw",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
] as const;

const capabilityPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
    network: z.enum(["github-only", "public-dependencies"]),
    setup: environmentSetupSchema.optional(),
    commands: z.array(
      z.strictObject({ name: commandNameSchema, available: z.boolean() }),
    ),
    repositoryMarkers: z.array(z.string().min(1)),
  });

export const capabilityPreflightSchema = capabilityPayloadSchema
  .extend({ digest: fingerprintSchema });

export type CapabilityPreflight = z.infer<typeof capabilityPreflightSchema>;

interface CapabilityPreflightReader {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
}

interface CapabilityPreflightSandbox extends CapabilityPreflightReader {
  run(options: { readonly command: string }): PromiseLike<{
    readonly exitCode: number;
    readonly stderr: unknown;
    readonly stdout: unknown;
  }>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function capabilityPreflightPath(patchFingerprint: string): string {
  return `${reviewEvidenceDirectory(patchFingerprint)}/capabilities.json`;
}

function digestPayload(payload: z.infer<typeof capabilityPayloadSchema>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateIdentity(
  preflight: CapabilityPreflight,
  identity: ReviewEvidenceIdentity,
): void {
  if (
    preflight.baseSha !== identity.baseSha ||
    preflight.headSha !== identity.headSha ||
    preflight.patchFingerprint !== identity.patchFingerprint
  ) {
    throw new Error("Capability preflight does not match the trusted review");
  }
}

function validateContents(preflight: CapabilityPreflight): void {
  if (
    preflight.commands.length !== capabilityCommandNames.length ||
    preflight.commands.some(
      (command, index) => command.name !== capabilityCommandNames[index],
    )
  ) {
    throw new Error("Capability preflight command inventory is incomplete");
  }
  const allowedMarkers = new Set<string>(capabilityRepositoryMarkers);
  if (
    new Set(preflight.repositoryMarkers).size !==
      preflight.repositoryMarkers.length ||
    preflight.repositoryMarkers.some((marker) => !allowedMarkers.has(marker))
  ) {
    throw new Error("Capability preflight repository markers are invalid");
  }
}

export async function readCapabilityPreflight(
  sandbox: CapabilityPreflightReader,
  identity: ReviewEvidenceIdentity,
): Promise<CapabilityPreflight> {
  const source = await sandbox.readTextFile({
    path: capabilityPreflightPath(identity.patchFingerprint),
  });
  if (source === null) throw new Error("Capability preflight is unavailable");
  const preflight = capabilityPreflightSchema.parse(JSON.parse(source));
  validateIdentity(preflight, identity);
  validateContents(preflight);
  const { digest, ...payload } = preflight;
  if (digestPayload(payload) !== digest) {
    throw new Error("Capability preflight failed integrity validation");
  }
  return preflight;
}

export async function runCapabilityPreflight(
  sandbox: CapabilityPreflightSandbox,
  identity: ReviewEvidenceIdentity,
  setup?: EnvironmentSetup,
): Promise<{ readonly created: boolean; readonly preflight: CapabilityPreflight }> {
  try {
    const preflight = await readCapabilityPreflight(sandbox, identity);
    if (setup && JSON.stringify(preflight.setup) !== JSON.stringify(setup)) {
      throw new Error("Capability preflight predates the prepared environment");
    }
    return {
      created: false,
      preflight,
    };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Capability preflight is unavailable") {
      throw error;
    }
  }

  const commands = capabilityCommandNames.map(shellQuote).join(" ");
  const markers = capabilityRepositoryMarkers.map(shellQuote).join(" ");
  const result = await sandbox.run({
    command: [
      "cd /workspace &&",
      `for name in ${commands}; do`,
      "if command -v \"$name\" >/dev/null 2>&1; then available=1; else available=0; fi;",
      "printf 'command\\t%s\\t%s\\n' \"$name\" \"$available\";",
      "done;",
      `for path in ${markers}; do`,
      "if [ -e \"$path\" ]; then printf 'marker\\t%s\\t1\\n' \"$path\"; fi;",
      "done",
    ].join(" "),
  });
  if (result.exitCode !== 0) {
    throw new Error("Capability preflight failed");
  }

  const availability = new Map<string, boolean>();
  const repositoryMarkers: string[] = [];
  for (const line of String(result.stdout).split("\n")) {
    if (line.length === 0) continue;
    const [kind, name, value] = line.split("\t");
    if (kind === "command" && name && (value === "0" || value === "1")) {
      availability.set(name, value === "1");
    } else if (kind === "marker" && name && value === "1") {
      repositoryMarkers.push(name);
    } else {
      throw new Error("Capability preflight returned malformed output");
    }
  }
  if (
    availability.size !== capabilityCommandNames.length ||
    capabilityCommandNames.some((name) => !availability.has(name))
  ) {
    throw new Error("Capability preflight did not report every command");
  }

  const payload = capabilityPayloadSchema.parse({
    schemaVersion: 1,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    patchFingerprint: identity.patchFingerprint,
    network: "public-dependencies",
    ...(setup ? { setup } : {}),
    commands: capabilityCommandNames.map((name) => ({
      name,
      available: availability.get(name) ?? false,
    })),
    repositoryMarkers: [...new Set(repositoryMarkers)].sort(),
  });
  const preflight = capabilityPreflightSchema.parse({
    ...payload,
    digest: digestPayload(payload),
  });
  await sandbox.writeTextFile({
    path: capabilityPreflightPath(identity.patchFingerprint),
    content: `${JSON.stringify(preflight)}\n`,
  });
  return { created: true, preflight };
}
