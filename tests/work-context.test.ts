import { expect, test } from "bun:test";
import { reviewWorkContext } from "../src/review/work-execution";
import { workOrchestrationFixture } from "./work-orchestration-fixture";

test("written requirements are delivered once while specialists retain every frozen clause and source location", () => {
  const f = workOrchestrationFixture([
    "engineering-quality",
    "claim-and-specification",
  ]);
  const text = "Historical narrative that is available for context. ".repeat(
    500,
  );
  const obligation = {
    id: `ob-${"b".repeat(24)}`,
    base: { line: 2, text: "The CLI must reject invalid input." },
    head: { line: 2, text: "The CLI must reject invalid input." },
  };
  const source = {
    id: `req-${"a".repeat(24)}`,
    kind: "document" as const,
    path: "docs/contract.md",
    reason: "governance" as const,
    referencedBy: [],
    references: [],
    obligations: [obligation],
    laneIds: [],
    baseBlob: "a".repeat(40),
    headBlob: "b".repeat(40),
    contentDigest: "c".repeat(64),
    characters: text.length,
  };
  for (const packet of f.packets.values()) {
    packet.unit.requirementIds = [source.id];
    packet.requirements = [{ source, baseText: text, headText: text }];
    const context = reviewWorkContext(packet);
    expect(context.requirements[0]?.obligations).toEqual([obligation]);
    expect(context.requirements[0]?.path).toBe(source.path);
    expect(packet.requirements[0]?.baseText).toBe(text);
    if (packet.unit.axis === "claim-and-specification") {
      expect(context.requirements[0]?.baseText).toBe(text);
    } else {
      expect(context.requirements[0]?.baseText).toBeNull();
      expect(context.requirements[0]?.sourceText).toContain(
        "inspect_review_source",
      );
      expect(JSON.stringify(context)).not.toContain("Historical narrative");
    }
  }
});
