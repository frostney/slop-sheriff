import { createHash } from "node:crypto";

export interface PatchFile {
  readonly blobSha: string;
  readonly path: string;
  readonly previousPath?: string | null;
  readonly status: "added" | "copied" | "deleted" | "modified" | "renamed";
  readonly patch: string | null;
  readonly additions?: number;
  readonly deletions?: number;
}

export function hasCompletePatch(file: PatchFile): boolean {
  if (file.patch === null || file.additions === undefined || file.deletions === undefined) return false;
  let additions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  const lines = file.patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (hunk) {
      if (oldRemaining !== 0 || newRemaining !== 0) return false;
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      hunks += 1;
    } else if (line === "\\ No newline at end of file") {
      if (hunks === 0) return false;
    } else if (hunks === 0) {
      return false;
    } else if (line.startsWith("+")) {
      additions += 1;
      newRemaining -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(" ")) {
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      return false;
    }
    if (oldRemaining < 0 || newRemaining < 0) return false;
  }
  return hunks > 0 && oldRemaining === 0 && newRemaining === 0 &&
    additions === file.additions && deletions === file.deletions;
}

function normalizePatch(patch: string | null): string {
  return (patch ?? "")
    .replaceAll("\r\n", "\n")
    .replace(/^index [^\n]+\n/gm, "")
    .replace(/^@@ .* @@/gm, "@@");
}

export function effectivePatchFingerprint(files: readonly PatchFile[]): string {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      const complete = hasCompletePatch(file);
      return {
        blobSha: complete ? null : file.blobSha,
        path: file.path,
        previousPath: file.previousPath ?? null,
        status: file.status,
        // Complete patches preserve source CR bytes; only hunk positions are metadata.
        patch: complete ? file.patch?.replace(/^@@ .* @@/gm, "@@") : normalizePatch(file.patch),
      };
    });

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function effectivePatchFileFingerprints(
  files: readonly PatchFile[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    files.map((file) => [file.path, effectivePatchFingerprint([file])]),
  );
}

export function changedEffectiveFiles(
  baseline: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .filter((path) => baseline[path] !== current[path])
    .sort();
}
