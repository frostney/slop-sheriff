import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewAxis } from "./axes";
import { reviewAxisSchema } from "./axes";
import { specialistEntryScope } from "./specialist-scope";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const patchFileSchema = z.string().regex(/^patch-[a-f0-9]{64}\.diff$/);
export const reviewFileStatusSchema = z.enum([
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
]);
export const repositoryPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => segment === "." || segment === ".."),
    "Review evidence paths must be repository-relative",
  );

const commonEntrySchema = z.object({
  path: repositoryPathSchema,
  status: reviewFileStatusSchema,
  patchCharacters: z.number().int().nonnegative(),
  patchTokens: z.number().int().nonnegative(),
  patchSha256: fingerprintSchema,
});

const includedEvidenceSchema = commonEntrySchema.extend({
  kind: z.literal("included"),
  patchFile: patchFileSchema,
});

const excludedEvidenceSchema = commonEntrySchema.extend({
  kind: z.literal("excluded"),
  classification: z.array(z.enum(["generated", "vendored", "binary"])).min(1),
  addedLines: z.number().int().nonnegative(),
  deletedLines: z.number().int().nonnegative(),
});

export const reviewEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseSha: revisionSchema,
    headSha: revisionSchema,
    patchFingerprint: fingerprintSchema,
    entries: z.array(
      z.discriminatedUnion("kind", [
        includedEvidenceSchema,
        excludedEvidenceSchema,
      ]),
    ),
  })
  .superRefine((manifest, ctx) => {
    const paths = manifest.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Review evidence paths must be unique",
      });
    }
    const patchFiles = manifest.entries.flatMap((entry) =>
      entry.kind === "included" ? [entry.patchFile] : [],
    );
    if (new Set(patchFiles).size !== patchFiles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Included review patch files must be unique",
      });
    }
  });

export type ReviewEvidenceManifest = z.infer<
  typeof reviewEvidenceManifestSchema
>;
export type IncludedReviewEvidence = z.infer<typeof includedEvidenceSchema>;
export type ExcludedReviewEvidence = z.infer<typeof excludedEvidenceSchema>;

export interface ReviewEvidenceSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  removePath(options: {
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  writeTextFile(options: {
    readonly content: string;
    readonly path: string;
  }): PromiseLike<void>;
}

export interface ReviewEvidenceIdentity {
  readonly baseSha: string;
  readonly headSha: string;
  readonly patchFingerprint: string;
}

export const reviewEvidencePageSize = 50;
export const reviewEvidencePatchCharacters = 16_000;
export const reviewEvidencePacketCharacters = 500_000;

const reviewEvidenceCursorSchema = z.object({
  entryIndex: z.number().int().nonnegative(),
  characterOffset: z.number().int().nonnegative(),
});

const reviewEvidenceProgressSchema = z.object({
  cursor: reviewEvidenceCursorSchema.nullable(),
  completedEntries: z.array(z.number().int().nonnegative()),
});

const packetEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  entry: z.discriminatedUnion("kind", [
    includedEvidenceSchema,
    excludedEvidenceSchema,
  ]),
  characterOffset: z.number().int().nonnegative(),
  content: z.string().optional(),
  nextCharacterOffset: z.number().int().nonnegative().nullable(),
  obligation: z.string().optional(),
  patchOmissionReason: z.string().optional(),
});

const reviewEvidencePacketSchema = z.object({
  entries: z.array(packetEntrySchema),
  completedEntries: z.array(z.number().int().nonnegative()),
  nextCursor: reviewEvidenceCursorSchema.nullable(),
  totalEntries: z.number().int().nonnegative(),
});

const packetReceiptSchema = z.object({
  before: reviewEvidenceProgressSchema,
  after: reviewEvidenceProgressSchema,
  packet: reviewEvidencePacketSchema,
});
const packetSessionSchema = z.object({ checkpointRevision: z.number().int().nonnegative() });

export type ReviewEvidenceProgress = z.infer<
  typeof reviewEvidenceProgressSchema
>;

export function reviewEvidenceDirectory(patchFingerprint: string): string {
  return `/tmp/known-good-review/evidence/${fingerprintSchema.parse(patchFingerprint)}`;
}

export function reviewEvidenceManifestPath(patchFingerprint: string): string {
  return `${reviewEvidenceDirectory(patchFingerprint)}/manifest.json`;
}

export function reviewEvidencePatchFile(
  patchFingerprint: string,
  path: string,
): { readonly fileName: string; readonly filePath: string } {
  const fileName = `patch-${createHash("sha256").update(path).digest("hex")}.diff`;
  return {
    fileName,
    filePath: `${reviewEvidenceDirectory(patchFingerprint)}/${fileName}`,
  };
}

function reviewEvidenceProgressPath(
  patchFingerprint: string,
  axis: ReviewAxis,
): string {
  return `${reviewEvidenceDirectory(patchFingerprint)}/progress/${reviewAxisSchema.parse(axis)}.json`;
}

function reviewEvidencePacketReceiptPath(
  patchFingerprint: string,
  axis: ReviewAxis,
  sessionId: string,
): string {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return `${reviewEvidenceDirectory(patchFingerprint)}/packets/${reviewAxisSchema.parse(axis)}-${sessionHash}.json`;
}

export async function resetReviewEvidence(
  sandbox: ReviewEvidenceSandbox,
  patchFingerprint: string,
): Promise<void> {
  await sandbox.removePath({
    path: reviewEvidenceDirectory(patchFingerprint),
    recursive: true,
    force: true,
  });
}

export async function writeIncludedReviewEvidence(
  sandbox: ReviewEvidenceSandbox,
  input: {
    readonly patchFingerprint: string;
    readonly path: string;
    readonly patch: string;
    readonly patchTokens: number;
    readonly status: z.infer<typeof reviewFileStatusSchema>;
  },
): Promise<IncludedReviewEvidence> {
  const patchSha256 = createHash("sha256").update(input.patch).digest("hex");
  const patchFile = reviewEvidencePatchFile(input.patchFingerprint, input.path);
  await sandbox.writeTextFile({
    path: patchFile.filePath,
    content: input.patch,
  });
  return includedEvidenceSchema.parse({
    kind: "included",
    path: input.path,
    status: input.status,
    patchCharacters: input.patch.length,
    patchTokens: input.patchTokens,
    patchSha256,
    patchFile: patchFile.fileName,
  });
}

export async function writeReviewEvidenceManifest(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
): Promise<void> {
  const parsed = reviewEvidenceManifestSchema.parse(manifest);
  await sandbox.writeTextFile({
    path: reviewEvidenceManifestPath(parsed.patchFingerprint),
    content: `${JSON.stringify(parsed)}\n`,
  });
}

export async function readReviewEvidenceManifest(
  sandbox: ReviewEvidenceSandbox,
  identity: ReviewEvidenceIdentity,
): Promise<ReviewEvidenceManifest> {
  const source = await sandbox.readTextFile({
    path: reviewEvidenceManifestPath(identity.patchFingerprint),
  });
  if (source === null) {
    throw new Error("Prepared review evidence is unavailable");
  }
  const manifest = reviewEvidenceManifestSchema.parse(JSON.parse(source));
  if (
    manifest.baseSha !== identity.baseSha ||
    manifest.headSha !== identity.headSha ||
    manifest.patchFingerprint !== identity.patchFingerprint
  ) {
    throw new Error(
      "Prepared review evidence does not match the trusted review",
    );
  }
  return manifest;
}

export function reviewEvidencePage(
  manifest: ReviewEvidenceManifest,
  cursor: number,
) {
  const start = z.number().int().nonnegative().parse(cursor);
  const entries = manifest.entries
    .slice(start, start + reviewEvidencePageSize)
    .map((entry, offset) => ({ index: start + offset, ...entry }));
  const nextCursor = start + entries.length;
  return {
    entries,
    nextCursor: nextCursor < manifest.entries.length ? nextCursor : null,
    totalEntries: manifest.entries.length,
  };
}

export async function readReviewEvidencePatch(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  input: {
    readonly path: string;
    readonly cursor: number;
    readonly maxCharacters?: number;
  },
) {
  const entry = manifest.entries.find(
    (candidate): candidate is IncludedReviewEvidence =>
      candidate.kind === "included" && candidate.path === input.path,
  );
  if (!entry) {
    throw new Error(`No included review patch exists for ${input.path}`);
  }
  const source = await sandbox.readTextFile({
    path: `${reviewEvidenceDirectory(manifest.patchFingerprint)}/${entry.patchFile}`,
  });
  if (source === null) {
    throw new Error(`Prepared review patch is unavailable for ${input.path}`);
  }
  const observedSha256 = createHash("sha256").update(source).digest("hex");
  if (observedSha256 !== entry.patchSha256) {
    throw new Error(
      `Prepared review patch failed integrity validation for ${input.path}`,
    );
  }
  const cursor = z
    .number()
    .int()
    .nonnegative()
    .max(source.length)
    .parse(input.cursor);
  const maxCharacters = z
    .number()
    .int()
    .positive()
    .max(reviewEvidencePacketCharacters)
    .parse(input.maxCharacters ?? reviewEvidencePatchCharacters);
  let end = Math.min(cursor + maxCharacters, source.length);
  if (
    end < source.length &&
    source.charCodeAt(end - 1) >= 0xd800 &&
    source.charCodeAt(end - 1) <= 0xdbff &&
    source.charCodeAt(end) >= 0xdc00 &&
    source.charCodeAt(end) <= 0xdfff
  ) {
    end += 1;
  }
  const content = source.slice(cursor, end);
  const nextCursor = cursor + content.length;
  return {
    path: entry.path,
    patchSha256: entry.patchSha256,
    cursor,
    content,
    nextCursor: nextCursor < source.length ? nextCursor : null,
    totalCharacters: source.length,
  };
}

export async function readReviewEvidenceProgress(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
): Promise<ReviewEvidenceProgress> {
  const source = await sandbox.readTextFile({
    path: reviewEvidenceProgressPath(manifest.patchFingerprint, axis),
  });
  if (source === null) {
    return {
      cursor:
        manifest.entries.length === 0
          ? null
          : { entryIndex: 0, characterOffset: 0 },
      completedEntries: [],
    };
  }
  const progress = reviewEvidenceProgressSchema.parse(JSON.parse(source));
  validateReviewEvidenceProgress(progress, manifest);
  return progress;
}

function validateReviewEvidenceProgress(
  progress: ReviewEvidenceProgress,
  manifest: ReviewEvidenceManifest,
): void {
  const index = progress.cursor?.entryIndex ?? manifest.entries.length;
  const entry = manifest.entries[index];
  if (
    progress.completedEntries.length !== index ||
    progress.completedEntries.some((completed, offset) => completed !== offset) ||
    (progress.cursor !== null && (
      !entry ||
      (progress.cursor.characterOffset > 0 && (
        entry.kind !== "included" ||
        progress.cursor.characterOffset >= entry.patchCharacters
      ))
    ))
  ) {
    throw new Error("Review evidence progress does not match the exact manifest");
  }
}

async function writeReviewEvidenceProgress(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
  progress: ReviewEvidenceProgress,
): Promise<void> {
  await sandbox.writeTextFile({
    path: reviewEvidenceProgressPath(manifest.patchFingerprint, axis),
    content: `${JSON.stringify(reviewEvidenceProgressSchema.parse(progress))}\n`,
  });
}

async function buildReviewEvidencePacket(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  progress: ReviewEvidenceProgress,
  axis: ReviewAxis,
) {
  validateReviewEvidenceProgress(progress, manifest);
  if (progress.cursor === null) {
    return reviewEvidencePacketSchema.parse({
      entries: [],
      completedEntries: progress.completedEntries,
      nextCursor: null,
      totalEntries: manifest.entries.length,
    });
  }
  let entryIndex = progress.cursor.entryIndex;
  let characterOffset = progress.cursor.characterOffset;
  // Reserve the largest envelope this manifest can need, including completed
  // indices and the continuation cursor. Every entry is charged as JSON below.
  const envelopeCharacters = JSON.stringify({
    entries: [],
    completedEntries: manifest.entries.map((_, index) => index),
    nextCursor: {
      entryIndex: manifest.entries.length,
      characterOffset: manifest.entries.reduce((largest, entry) => Math.max(largest, entry.patchCharacters), 0),
    },
    totalEntries: manifest.entries.length,
  }).length;
  let remainingCharacters = reviewEvidencePacketCharacters - envelopeCharacters;
  const entries: Array<z.infer<typeof packetEntrySchema>> = [];
  const completedEntries = [...progress.completedEntries];

  while (entryIndex < manifest.entries.length) {
    const entry = manifest.entries[entryIndex];
    if (!entry) break;
    const scope = specialistEntryScope(axis, entry.path);
    if (entry.kind === "excluded" || scope?.includePatch === false) {
      const candidate = {
        index: entryIndex,
        entry,
        characterOffset: 0,
        nextCharacterOffset: null,
        ...(scope ? { obligation: scope.obligation, patchOmissionReason: entry.kind === "excluded" ? `Trusted-base classification: ${entry.classification.join(", ")}` : scope.reason } : {}),
      };
      const characters = JSON.stringify(candidate).length + 1;
      if (characters > remainingCharacters) break;
      entries.push(candidate);
      remainingCharacters -= characters;
      completedEntries.push(entryIndex);
      entryIndex += 1;
      characterOffset = 0;
      continue;
    }
    if (remainingCharacters <= 0) break;
    const patch = await readReviewEvidencePatch(sandbox, manifest, {
      path: entry.path,
      cursor: characterOffset,
      maxCharacters: remainingCharacters,
    });
    const candidate = {
      index: entryIndex,
      entry,
      characterOffset,
      content: patch.content,
      nextCharacterOffset: patch.nextCursor,
      ...(scope ? { obligation: scope.obligation } : {}),
    };
    if (JSON.stringify(candidate).length + 1 > remainingCharacters) {
      // JSON escaping can expand patches. Find a fitting prefix without reading
      // or hashing the source again, keeping UTF-16 surrogate pairs together.
      let low = 0;
      let high = patch.content.length;
      const prefix = (length: number) => {
        const previous = patch.content.charCodeAt(length - 1);
        const next = patch.content.charCodeAt(length);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) length -= 1;
        return patch.content.slice(0, length);
      };
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        candidate.content = prefix(middle);
        candidate.nextCharacterOffset = characterOffset + candidate.content.length;
        if (JSON.stringify(candidate).length + 1 <= remainingCharacters) low = middle;
        else high = middle - 1;
      }
      candidate.content = prefix(low);
      candidate.nextCharacterOffset = characterOffset + candidate.content.length;
      if (candidate.content.length === 0) break;
    }
    entries.push(candidate);
    remainingCharacters -= JSON.stringify(candidate).length + 1;
    if (candidate.nextCharacterOffset !== null) {
      characterOffset = candidate.nextCharacterOffset;
      break;
    }
    completedEntries.push(entryIndex);
    entryIndex += 1;
    characterOffset = 0;
  }

  if (entries.length === 0) {
    throw new Error("Review evidence metadata exceeds the packet budget");
  }

  return reviewEvidencePacketSchema.parse({
    entries,
    completedEntries,
    nextCursor:
      entryIndex < manifest.entries.length
        ? { entryIndex, characterOffset }
        : null,
    totalEntries: manifest.entries.length,
  });
}

export async function readNextReviewEvidencePacket(
  sandbox: ReviewEvidenceSandbox,
  manifest: ReviewEvidenceManifest,
  axis: ReviewAxis,
  sessionId: string,
  checkpointRevision: number,
) {
  const receiptPath = reviewEvidencePacketReceiptPath(
    manifest.patchFingerprint,
    axis,
    sessionId,
  );
  const sessionSource = await sandbox.readTextFile({ path: receiptPath });
  const session = sessionSource === null
    ? null
    : packetSessionSchema.parse(JSON.parse(sessionSource));
  const revision = session?.checkpointRevision ??
    z.number().int().nonnegative().parse(checkpointRevision);
  const revisionReceiptPath = `${reviewEvidenceDirectory(manifest.patchFingerprint)}/packets/${axis}-revision-${revision}.json`;
  const existingReceipt = await sandbox.readTextFile({ path: revisionReceiptPath });
  if (existingReceipt !== null) {
    const receipt = packetReceiptSchema.parse(JSON.parse(existingReceipt));
    const expected = await buildReviewEvidencePacket(
      sandbox, manifest, receipt.before, axis,
    );
    if (
      JSON.stringify(receipt.packet) !== JSON.stringify(expected) ||
      JSON.stringify(receipt.after) !== JSON.stringify({
        cursor: expected.nextCursor,
        completedEntries: expected.completedEntries,
      })
    ) {
      throw new Error("Review evidence packet failed integrity validation");
    }
    const current = await readReviewEvidenceProgress(sandbox, manifest, axis);
    if (JSON.stringify(current) === JSON.stringify(receipt.before)) {
      await writeReviewEvidenceProgress(
        sandbox,
        manifest,
        axis,
        receipt.after,
      );
    } else if (JSON.stringify(current) !== JSON.stringify(receipt.after)) {
      throw new Error("Review evidence packet progress is inconsistent");
    }
    if (!session) {
      await sandbox.writeTextFile({
        path: receiptPath,
        content: `${JSON.stringify({ checkpointRevision: revision })}\n`,
      });
    }
    return receipt.packet;
  }

  const before = await readReviewEvidenceProgress(sandbox, manifest, axis);
  if (session || (revision === 0 && (
    before.completedEntries.length > 0 || (before.cursor?.characterOffset ?? 0) > 0
  ))) {
    throw new Error("Review evidence progress is missing its checkpoint-bound receipt");
  }
  const packet = await buildReviewEvidencePacket(sandbox, manifest, before, axis);
  const after = reviewEvidenceProgressSchema.parse({
    cursor: packet.nextCursor,
    completedEntries: packet.completedEntries,
  });
  const receipt = packetReceiptSchema.parse({ before, after, packet });
  // Delivery can finish before the lane saves its findings. A replacement
  // session at the same checkpoint revision must receive that same packet.
  await sandbox.writeTextFile({
    path: revisionReceiptPath,
    content: `${JSON.stringify(receipt)}\n`,
  });
  await sandbox.writeTextFile({
    path: receiptPath,
    content: `${JSON.stringify({ checkpointRevision: revision })}\n`,
  });
  await writeReviewEvidenceProgress(sandbox, manifest, axis, after);
  return packet;
}
