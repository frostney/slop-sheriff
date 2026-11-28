import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import sandbox, { durableVercelTemplate } from "../agent/sandbox";
import { githubOnlyNetworkPolicy } from "../src/github/review-workspace";

// Drive the installed Eve Vercel binding, not a re-implementation of it: the
// fix depends on the order in which Eve applies bootstrap options and snapshots
// the template. Upgrading Eve must re-prove that order, so the test fails if
// the binding moves.
const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const { createVercelSandbox } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/execution/sandbox/bindings/vercel.js")).href
)) as {
  createVercelSandbox: (options: Record<string, unknown>) => {
    create(input: Record<string, unknown>): Promise<unknown>;
    prewarm(input: Record<string, unknown>): Promise<{ reused: boolean }>;
  };
};

type Call =
  | { readonly kind: "create"; readonly name: string; readonly options: Record<string, unknown> }
  | { readonly kind: "update"; readonly name: string; readonly options: Record<string, unknown> }
  | { readonly kind: "snapshot"; readonly name: string; readonly options: unknown };

function fakeVercel() {
  const calls: Call[] = [];
  const missing = () => Object.assign(new Error("not found"), { response: { status: 404 } });
  const sandboxModule = { Sandbox: { get: async () => { throw missing(); } } };
  const createSandbox = async (input: { createOptions: Record<string, unknown> }) => {
    const name = String(input.createOptions.name);
    calls.push({ kind: "create", name, options: input.createOptions });
    return {
      name,
      status: "running",
      currentSnapshotId: undefined,
      tags: input.createOptions.tags,
      async update(options: Record<string, unknown>) {
        calls.push({ kind: "update", name, options });
      },
      async runCommand() {
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      },
      async writeFiles() {},
      async snapshot(options?: unknown) {
        calls.push({ kind: "snapshot", name, options });
        return { snapshotId: "snap_template" };
      },
    };
  };
  const backend = createVercelSandbox({
    createOptions: {
      networkPolicy: githubOnlyNetworkPolicy,
      resources: { vcpus: 2 },
      projectId: "prj_test",
      teamId: "team_test",
      token: "test-token",
    },
    createSandbox,
    loadSandboxModule: async () => sandboxModule,
  });
  return { backend, calls };
}

test("the deployed sandbox template stays persistent and its snapshot never expires", async () => {
  const { backend, calls } = fakeVercel();
  const templateKey = "eve-sbx-tpl-vercel-test";

  const result = await backend.prewarm({
    bootstrap: sandbox.bootstrap,
    runtimeContext: { appRoot: process.cwd() },
    seedFiles: [],
    templateKey,
  });

  expect(result.reused).toBe(false);
  const template = calls.filter((call) => call.name === templateKey);
  const durable = template.findIndex((call) =>
    call.kind === "update" &&
    call.options.persistent === durableVercelTemplate.persistent &&
    call.options.snapshotExpiration === durableVercelTemplate.snapshotExpiration);
  const snapshot = template.findIndex((call) => call.kind === "snapshot");
  expect(durable).toBeGreaterThan(-1);
  expect(snapshot).toBeGreaterThan(durable);
  // Eve passes no per-snapshot expiration, so the template's own
  // snapshotExpiration (0: never) is what Vercel applies to this snapshot.
  expect(template[snapshot]).toEqual({ kind: "snapshot", name: templateKey, options: undefined });
  expect(durableVercelTemplate).toEqual({ persistent: true, snapshotExpiration: 0 });
});

test("review session sandboxes keep the provider's default snapshot expiration", async () => {
  const { backend, calls } = fakeVercel();
  const templateKey = "eve-sbx-tpl-vercel-test";
  await backend.prewarm({
    bootstrap: sandbox.bootstrap,
    runtimeContext: { appRoot: process.cwd() },
    seedFiles: [],
    templateKey,
  });

  await backend.create({
    runtimeContext: { appRoot: process.cwd() },
    sessionKey: "eve-sbx-ses-vercel-test",
    templateKey,
  });

  const session = calls.filter((call) => call.name === "eve-sbx-ses-vercel-test");
  const created = session.find((call) => call.kind === "create");
  expect(created?.options.source).toEqual({ snapshotId: "snap_template", type: "snapshot" });
  expect(created?.options).not.toHaveProperty("snapshotExpiration");
  expect(session.some((call) => call.kind === "update" && "snapshotExpiration" in call.options)).toBe(false);
});
