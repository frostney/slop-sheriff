import { z } from "zod";

export const findingSchema = z.object({
  id: z.string().regex(/^CR-[1-9]\d*$/),
  severity: z.enum(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
  status: z.enum(["open", "fixed", "deferred"]),
  dismissal: z.object({ reason: z.string(), actor: z.string(), head: z.string(), commentId: z.string() }).optional(),
  location: z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    symbol: z.string().nullable(),
  }),
});

export type PriorFinding = z.infer<typeof findingSchema>;

export function findingsToRevalidate(
  findings: readonly PriorFinding[],
  changedFiles: ReadonlySet<string>,
  changedSymbols: ReadonlySet<string> = new Set(),
): PriorFinding[] {
  return findings.filter((finding) => {
    if (finding.status === "fixed" || finding.dismissal) {
      return false;
    }
    if (
      finding.severity !== "IMPROVEMENT" &&
      finding.severity !== "NITPICK"
    ) {
      return true;
    }
    return (
      changedFiles.has(finding.location.path) ||
      (finding.location.symbol !== null &&
        changedSymbols.has(finding.location.symbol))
    );
  });
}
