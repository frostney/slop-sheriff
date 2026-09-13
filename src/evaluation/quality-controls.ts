import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewQualityCase } from "./review-quality-corpus";

/** Independent public-contract oracle. This file and its labels are never copied into reviewer inputs. */
export const portBoundaryOracle = `import assert from 'node:assert/strict';
const {parsePort}=await import(process.argv[2]);
assert.equal(parsePort('80'),80);
assert.equal(parsePort(65535),65535);
assert.throws(()=>parsePort(65536),RangeError);
assert.throws(()=>parsePort('12x'));
assert.throws(()=>parsePort(0),RangeError);
`;
export const qualityControlLabels = [
  {
    id: "port-boundary-65536",
    revision: "defect",
    expected: "material-finding",
    path: "src/port.mjs",
    principle:
      "The documented upper bound is inclusive at 65535; 65536 must be rejected.",
    basis:
      "Independent Node assert oracle fails only at the upper-bound rejection.",
  },
  {
    id: "port-boundary-65536",
    revision: "corrected",
    expected: "fixed",
    path: "src/port.mjs",
    principle: "The same frozen oracle passes after the boundary is corrected.",
    basis:
      "Independent Node assert oracle; this establishes the targeted clean control, not absence of every possible defect.",
  },
] as const;

/** Deterministic commits let a routine initial/fix lifecycle include validated defect and clean controls. */
export async function createQualityControlRepository() {
  const root = await mkdtemp(join(tmpdir(), "sheriff-quality-control-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", root, "-c", "core.hooksPath=/dev/null", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "Frozen evaluation revision");
    return git("rev-parse", "HEAD");
  };
  await mkdir(join(root, "src"));
  await mkdir(join(root, "client"));
  await mkdir(join(root, "tests"));
  git("init", "--quiet");
  git("config", "user.name", "Slop Sheriff evaluation");
  git("config", "user.email", "evaluation@example.invalid");
  const base = `export function parsePort(value) { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError('invalid port'); return value; }\n`;
  const defect = `export function parsePort(value) { if (!/^\\d+$/.test(String(value))) throw new TypeError('invalid decimal port'); const port=Number(value); if (port < 1 || port > 65536) throw new RangeError('invalid port'); return port; }\n`;
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { test: "node tests/public.mjs" },
    }),
  );
  await writeFile(
    join(root, "README.md"),
    "# Port parser\n\nThe public parsePort function must accept integer ports from 1 through 65535 inclusive and reject all other values.\n",
  );
  await writeFile(join(root, "src/port.mjs"), base);
  await writeFile(
    join(root, "tests/public.mjs"),
    "import assert from 'node:assert/strict'; import {parsePort} from '../src/port.mjs'; assert.equal(parsePort(80),80); assert.throws(()=>parsePort(0)); assert.throws(()=>parsePort(65536),RangeError); console.log('public checks passed');\n",
  );
  await writeFile(
    join(root, "client/label.mjs"),
    "export const portLabel = 'Port';\n",
  );
  const baseSha = commit();
  await writeFile(join(root, "src/port.mjs"), defect);
  await writeFile(
    join(root, "client/label.mjs"),
    "export const portLabel = 'TCP port';\n",
  );
  const defectiveHead = commit();
  await writeFile(
    join(root, "src/port.mjs"),
    defect.replace("port > 65536", "port > 65535"),
  );
  const correctedHead = commit();
  const testCase: ReviewQualityCase = {
    id: "seeded-port-boundary",
    repository: "evaluation/port-boundary",
    pullRequest: 1,
    kind: "routine-seeded-control",
    languages: ["JavaScript"],
    claim:
      "Accept decimal string ports as well as integer ports, preserving the documented valid range and rejection behavior. Clarify the client label as TCP port.",
    revisions: [
      { base: baseSha, head: defectiveHead },
      { base: baseSha, head: correctedHead },
    ],
    evidenceStatus:
      "Seeded public-contract defect plus targeted clean control. Frozen external oracle validates this one obligation; full finding quality still needs adjudication.",
  };
  return {
    root,
    testCase,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
