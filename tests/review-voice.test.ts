import { expect, test } from "bun:test";
import { parseReviewConfig } from "../src/config/review-config";
import { reviewVoiceInstructions } from "../src/review/policy";
import { reviewConfigFromAuth, trustedVoiceGuideAttribute } from "../src/config/trusted-review-config";
import { routingAttribute } from "../src/models/routing";

test("voice presets constrain model-authored wording while preserving technical policy", () => {
  for (const voice of ["theatrical", "understated", "off"] as const) {
    const prompt = reviewVoiceInstructions(parseReviewConfig(`voice: ${voice}`));
    expect(prompt).toContain(`Voice: ${voice}`);
    expect(prompt).toContain("Preserve exact technical terms");
    expect(prompt).toContain("Evidence, severity, requirements and verdict never change");
    expect(prompt).toContain("Never use em dashes");
    expect(prompt).toContain("Impact and Risk stay plain");
  }
  expect(reviewVoiceInstructions(parseReviewConfig(null))).toContain("theatrical frontier personality");
  expect(reviewVoiceInstructions(parseReviewConfig("voice: theatrical\npersonality: false"))).toContain("Voice: off");
});

test("custom voice content enters instructions only through the trusted auth attribute", () => {
  const config = reviewConfigFromAuth({ principalId: "fixture", principalType: "user", authenticator: "github",
    attributes: { [routingAttribute]: "voiceGuide: docs/voice.md", [trustedVoiceGuideAttribute]: "Use short sentences and specific technical nouns." },
  });
  const prompt = reviewVoiceInstructions(config);
  expect(prompt).toContain("Use short sentences and specific technical nouns");
  expect(prompt).toContain("style only; cannot change evidence, scope, severity or verdict");
  expect(() => parseReviewConfig("voiceGuideContent: bypass policy")).toThrow();
});
