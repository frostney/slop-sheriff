import { expect, spyOn, test } from "bun:test";
import { validateConfiguredModels } from "../src/models/catalog";
import { parseReviewConfig } from "../src/config/review-config";

test("shares concurrent catalog requests and retries a failed refresh", async () => {
  const config = parseReviewConfig("model: test/language\nagents: test/language\nembedding: test/embedding\nembeddingDimension: 128");
  let fail = false;
  const now = spyOn(Date, "now").mockReturnValue(1_000_000);
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => fail
    ? new Response(null, { status: 503 })
    : Response.json({ data: [
      { id: "test/language", type: "language", tags: ["tool-use"] },
      { id: "test/embedding", type: "embedding" },
    ] }), { preconnect: () => {} }));
  try {
    await Promise.all(Array.from({ length: 12 }, () => validateConfiguredModels(config)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await validateConfiguredModels(config);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now.mockReturnValue(2_000_000);
    fail = true;
    const failed = await Promise.allSettled(Array.from({ length: 12 }, () => validateConfiguredModels(config)));
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fail = false;
    await validateConfiguredModels(config);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { fetcher.mockRestore(); now.mockRestore(); }
});

test("task-specific and escalation models are checked before review dispatch", async () => {
  const now = spyOn(Date, "now").mockReturnValue(10_000_000);
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ data: [
    { id: "test/language", type: "language", tags: ["tool-use"] }, { id: "test/embedding", type: "embedding" },
  ] }), { preconnect: () => {} }));
  try {
    const base = "model: test/language\nagents: test/language\nembedding: test/embedding\nembeddingDimension: 128\n";
    for (const field of ["model", "escalationModel"]) {
      const config = parseReviewConfig(`${base}tasks:\n  analysis:\n    ${field}: missing/task-model\n`);
      await expect(validateConfiguredModels(config)).rejects.toThrow("missing/task-model");
    }
  } finally { fetcher.mockRestore(); now.mockRestore(); }
});
