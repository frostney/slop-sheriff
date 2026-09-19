const manualFullPattern =
  /(?:@|\/)(?:slop-sheriff|known-good-review)\s+(?:run\s+)?full\s+review\b/i;
const botMentionPattern = /@(?:slop-sheriff|known-good-review)(?=$|[^A-Za-z0-9_-])/i;

export function requestsManualFullReview(body: string): boolean {
  return manualFullPattern.test(body);
}

export function addressesKnownGoodReview(body: string): boolean {
  return botMentionPattern.test(body);
}

export function reviewControlResponse(
  body: string,
): "approve" | "stop" | "key-budget-repaired" | null {
  const response = body.replace(botMentionPattern, "").trim().toLowerCase();
  if (response === "key budget repaired") return "key-budget-repaired";
  if (response === "approve" || response === "continue" || response === "1") {
    return "approve";
  }
  if (response === "stop" || response === "2") return "stop";
  return null;
}

export function canRequestManualFull(permission: string): boolean {
  return new Set(["admin", "maintain", "write"]).has(permission.toLowerCase());
}

export async function acknowledgeManualFullReview(thread: {
  readonly react: (reaction: "eyes") => Promise<unknown>;
}): Promise<boolean> {
  try {
    await thread.react("eyes");
    return true;
  } catch {
    return false;
  }
}
