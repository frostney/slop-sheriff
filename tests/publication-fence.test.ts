import { expect, spyOn, test } from "bun:test";
import { fencePublicationWrites } from "../src/lifecycle/publication-fence";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
const context = { deliveryId: "attempt" } as TrustedGitHubContext;

test("publication fence preserves native endpoint metadata and guards method/object/GraphQL writes", async () => {
  const oldUrl = process.env.CONVEX_MEMORY_URL, oldToken = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.CONVEX_MEMORY_URL = "https://lifecycle.test"; process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "test-token";
  let owned = true;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(owned)) as unknown as typeof globalThis.fetch);
  let writes = 0;
  const list = Object.assign(async () => [], { endpoint: { merge: () => ({}) } });
  const write = async (_options: unknown) => { writes++; };
  const client = { rest: { issues: { listComments: list, createComment: write } }, request: write, graphql: async (_query: unknown, _options?: unknown) => { writes++; } };
  try {
    const guarded = fencePublicationWrites(client, context);
    expect(guarded.rest.issues.listComments).toBe(list);
    expect(guarded.rest.issues.listComments.endpoint.merge).toBe(list.endpoint.merge);
    expect(fencePublicationWrites(guarded, context)).toBe(guarded);
    await guarded.rest.issues.createComment({ body: "hello" });
    await guarded.request({ method: "PATCH", url: "/resource" });
    await guarded.graphql({ query: "mutation Update { update }" });
    await guarded.graphql("mutation Update { update }", {});
    expect(writes).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    owned = false;
    await expect(guarded.request({ method: "POST", url: "/resource" })).rejects.toThrow("no longer owns");
    expect(writes).toBe(4);
  } finally {
    fetch.mockRestore();
    if (oldUrl === undefined) delete process.env.CONVEX_MEMORY_URL; else process.env.CONVEX_MEMORY_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = oldToken;
  }
});
