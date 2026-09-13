/** Revision metadata only. Later reviews, fixes and current PR bodies are never model input. */
export const reviewQualityCorpus = [
  {
    id: "goccia-workers",
    repository: "frostney/GocciaScript",
    pullRequest: 1238,
    kind: "routine-code-fix",
    languages: ["Pascal"],
    claim:
      "Use the detected processor count for default compliance workers while preserving explicit overrides and CLI file-count limits.",
    revisions: [
      {
        base: "029aa827b2723b2d9bf96fbfb3d0f910e91e07ab",
        head: "39babf06ab6f07c37c8771f6785fc7fa68d1d2d7",
      },
      {
        base: "029aa827b2723b2d9bf96fbfb3d0f910e91e07ab",
        head: "d56fa99ee8860e52259fdb2ecb2bbccf9ee7743b",
      },
    ],
    evidenceStatus:
      "Historical review and correction available; independent corpus adjudication pending.",
  },
  {
    id: "delivery-invocation-docs",
    repository: "frostney/known-good-route",
    pullRequest: 59,
    kind: "docs-only",
    languages: ["Markdown"],
    claim:
      "Document the actual delivery-wait command flags and update its callers' instructions to match the existing executable interface.",
    revisions: [
      {
        base: "47a0a55effefe5c0252be2abf6ed887119dfa824",
        head: "08709a51402b5eabaf7e851dea0352aa5d509f22",
      },
      {
        base: "47a0a55effefe5c0252be2abf6ed887119dfa824",
        head: "c58c44bec8c61f30151da1fe3ae8da1e17e1cc1a",
      },
    ],
    evidenceStatus:
      "Parent-linked corrections; separate push timing unverified. Adjudication pending.",
  },
  {
    id: "sheriff-dependencies",
    repository: "frostney/slop-sheriff",
    pullRequest: 37,
    kind: "dependencies-and-configuration",
    languages: ["TypeScript", "YAML"],
    claim:
      "Upgrade the agent dependencies and adapt integrations while preserving review contracts and offline runtime coverage.",
    revisions: [
      {
        base: "11bfa50636b5aa69278af3a6806cfd384241fcc1",
        head: "4efcece20f5f533e1d8df41d82645ca2641e9f87",
      },
      {
        base: "11bfa50636b5aa69278af3a6806cfd384241fcc1",
        head: "062a6413b02f6d0c66b66508fa2169036630b745",
      },
    ],
    evidenceStatus: "Two historical revisions; adjudication pending.",
  },
  {
    id: "sheriff-orchestration",
    repository: "frostney/slop-sheriff",
    pullRequest: 38,
    kind: "refactor-and-tests",
    languages: ["TypeScript"],
    claim:
      "Move lane and scout orchestration into application-owned Eve workflows, preserving trusted routing, checkpoint validation and recovery.",
    revisions: [
      {
        base: "d72c5aebbdfeffe436281741f88cfb553168bb55",
        head: "4d0c3458499a433c3235056ced535606b8f792d5",
      },
    ],
    evidenceStatus:
      "One historical revision; no natural update sequence. Adjudication pending.",
  },
  {
    id: "lantaarn-input",
    repository: "frostney/lantaarn",
    pullRequest: 9,
    kind: "public-contract-and-stack-update",
    languages: ["Pascal"],
    claim:
      "Validate wire input before injection and preserve consistent input bounds in the client, MCP surface and documentation.",
    revisions: [
      {
        base: "01946cd8eb36ca9ad2f345270a1f78de5d9493dc",
        head: "0be99f496b822be00dbdbdebcaeb125746d5cb84",
      },
      {
        base: "8329970a4ff8747ed28880928dfdf85b287fd4b5",
        head: "2c20bf9488b17c2c86d7877c9846511e45976e83",
      },
    ],
    evidenceStatus:
      "Draft stack with an actual base merge. Platform-specific verification and adjudication pending.",
  },
  {
    id: "gravelbyte-recovery",
    repository: "frostney/gravelbyte",
    pullRequest: 4,
    kind: "mixed-runtime-browser-and-tests",
    languages: ["C++", "JavaScript", "Python"],
    claim:
      "Harden off-road recovery, interrupted saves and browser controls while preserving rendered behavior through refactoring.",
    revisions: [
      {
        base: "0a0935b553341ca2e9b6a3f490c0ee3591740e4d",
        head: "4bb99f5bbbab822fd5a52320c183cf62de143d4f",
      },
    ],
    evidenceStatus:
      "One historical revision. Physical-device claims require device evidence. Adjudication pending.",
  },
] as const;

export interface ReviewQualityCase {
  readonly id: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly kind: string;
  readonly languages: readonly string[];
  readonly claim: string;
  readonly revisions: readonly {
    readonly base: string;
    readonly head: string;
  }[];
  readonly evidenceStatus: string;
}

/** Broad cross-cutting migration, kept outside routine lifecycle aggregates. */
export const reviewQualityStressCorpus: readonly ReviewQualityCase[] = [
  {
    id: "sheriff-cross-cutting-stress",
    repository: "frostney/slop-sheriff",
    pullRequest: 43,
    kind: "cross-cutting-stress",
    languages: ["TypeScript", "Markdown", "YAML"],
    claim:
      "Add trusted project-specific review lanes, configurable voice, review output improvements and reliable review recovery while preserving current findings and coverage.",
    revisions: [
      {
        base: "35c0e63f5b86643665eeb1733bc559774ffd5942",
        head: "b204ca34d651d2071e6951e93a9ac7f4ea1150ae",
      },
      {
        base: "35c0e63f5b86643665eeb1733bc559774ffd5942",
        head: "98c4114a8ca745dc5adaa01d19f7a2f713d3fbdd",
      },
    ],
    evidenceStatus:
      "Exact GitHub commit sequence verified September 13, 2026; full defect set remains unadjudicated. Excluded from routine cost aggregation before evaluation.",
  },
];
