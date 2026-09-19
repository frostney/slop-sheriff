import { Octokit } from "@octokit/rest";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { reviewBotLogin } from "../github/comment-identity";

/** Stateful HTTP boundary for the real publication implementation. No request escapes this sink. */
export function createQualityPublicationSink(
  beforeRequest?: (request: {
    method: string;
    path: string;
    body: unknown;
  }) => void,
) {
  let sequence = 0;
  let context: TrustedGitHubContext | undefined;
  let files: readonly Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [],
    inline: Record<string, unknown>[] = [],
    checks: Record<string, unknown>[] = [];
  const threads: {
    id: string;
    isResolved: boolean;
    comments: { nodes: { databaseId: number; body: string }[] };
  }[] = [];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const user = {
    id: Number(process.env.GITHUB_BOT_USER_ID ?? 1),
    login: reviewBotLogin,
    type: "Bot",
  };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  const octokit = new Octokit({
    request: {
      fetch: async (resource: Request | string | URL, init?: RequestInit) => {
        if (!context)
          throw new Error("Publication sink has no current revision");
        const request = new Request(resource, init);
        const url = new URL(request.url),
          path = url.pathname,
          method = request.method;
        const raw = await request.text();
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        requests.push({ method, path, body });
        beforeRequest?.({ method, path, body });
        const prefix = `/repos/${context.owner}/${context.repo}`;
        if (path !== "/graphql" && !path.startsWith(`${prefix}/`))
          throw new Error("Publication attempted another repository");
        const pr = `${prefix}/pulls/${context.pullRequest}`;
        if (method === "GET" && path === pr)
          return json({
            state: "open",
            draft: false,
            base: { sha: context.baseSha },
            head: { sha: context.headSha },
          });
        if (method === "GET" && path === `${pr}/files`) return json(files);
        if (path.endsWith("/check-runs") && method === "GET")
          return json({ check_runs: checks, total_count: checks.length });
        if (path === `${prefix}/check-runs` && method === "POST") {
          const check = {
            ...body,
            id: ++sequence,
            html_url: `https://evaluation.invalid/checks/${sequence}`,
          };
          checks.push(check);
          return json(check);
        }
        if (path.startsWith(`${prefix}/check-runs/`) && method === "PATCH") {
          const check = checks.find(
            (item) => item.id === Number(path.split("/").at(-1)),
          );
          if (!check) throw new Error("Unknown check update");
          Object.assign(check, body);
          return json(check);
        }
        if (path === `${prefix}/issues/${context.pullRequest}/comments`) {
          if (method === "GET") return json(comments);
          if (method === "POST") {
            const comment = { ...body, id: ++sequence, user };
            comments.push(comment);
            return json(comment);
          }
        }
        if (
          path.startsWith(`${prefix}/issues/comments/`) &&
          method === "PATCH"
        ) {
          const comment = comments.find(
            (item) => item.id === Number(path.split("/").at(-1)),
          );
          if (!comment) throw new Error("Unknown summary update");
          Object.assign(comment, body);
          return json(comment);
        }
        if (path === `${pr}/comments` && method === "GET") return json(inline);
        if (
          path.startsWith(`${prefix}/pulls/comments/`) &&
          method === "PATCH"
        ) {
          const comment = inline.find(
            (item) => item.id === Number(path.split("/").at(-1)),
          );
          if (!comment) throw new Error("Unknown inline update");
          Object.assign(comment, body);
          return json(comment);
        }
        if (
          path.startsWith(`${pr}/comments/`) &&
          path.endsWith("/replies") &&
          method === "POST"
        ) {
          const comment = {
            ...body,
            id: ++sequence,
            user,
            in_reply_to_id: Number(path.split("/").at(-2)),
          };
          inline.push(comment);
          return json(comment);
        }
        if (path === `${pr}/reviews`) {
          if (method === "GET") return json([]);
          if (method === "POST")
            return json({ id: ++sequence, node_id: `PRR_${sequence}` });
        }
        if (
          path.startsWith(`${pr}/reviews/`) &&
          (method === "DELETE" ||
            (path.endsWith("/events") && method === "POST"))
        )
          return json({
            id: Number(path.split("/").at(-2)),
            state: "COMMENTED",
          });
        if (path === "/graphql" && method === "POST") {
          const query = String(body.query),
            variables = body.variables as Record<string, unknown>;
          if (query.includes("KnownGoodReviewThreads"))
            return json({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: threads,
                      pageInfo: { endCursor: null, hasNextPage: false },
                    },
                  },
                },
              },
            });
          if (query.includes("KnownGoodReviewAddReviewThread")) {
            const input = variables.input as {
              body: string;
              path: string;
              line?: number;
              side?: string;
              subjectType: string;
            };
            const id = ++sequence,
              comment = {
                id,
                user,
                body: input.body,
                path: input.path,
                line: input.line ?? null,
                side: input.side ?? null,
                subject_type: input.subjectType.toLowerCase(),
                commit_id: context.headSha,
                in_reply_to_id: null,
              };
            inline.push(comment);
            const thread = {
              id: `PRRT_${id}`,
              isResolved: false,
              comments: { nodes: [{ databaseId: id, body: input.body }] },
            };
            threads.push(thread);
            return json({
              data: {
                addPullRequestReviewThread: { thread: { id: thread.id } },
              },
            });
          }
          if (query.includes("KnownGoodReviewResolveThread")) {
            const thread = threads.find(
              (item) => item.id === variables.threadId,
            );
            if (!thread) throw new Error("Unknown thread resolution");
            thread.isResolved = true;
            return json({
              data: {
                resolveReviewThread: {
                  thread: { id: thread.id, isResolved: true },
                },
              },
            });
          }
        }
        throw new Error(
          `Unexpected isolated GitHub operation: ${method} ${path}`,
        );
      },
    },
  });
  return {
    octokit,
    requests,
    comments,
    inline,
    threads,
    checks,
    setRevision(
      current: TrustedGitHubContext,
      changed: readonly Record<string, unknown>[],
    ) {
      context = current;
      files = changed;
    },
  };
}
