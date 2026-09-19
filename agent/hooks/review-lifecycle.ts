import { initializeDurableEvidence } from "../../src/review/durable-evidence";
import { defineHook } from "eve/hooks";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { heartbeatReview, lifecycleConfigured } from "../../src/lifecycle/client";

export default defineHook({ events: {
  async "turn.started"(_event, ctx) {
    if (!lifecycleConfigured() || ctx.channel.kind !== "github" || ctx.session.parent) return;
    const context = trustedGitHubContext(ctx.session.auth.current);
    await initializeDurableEvidence(context, ctx.session.id);
  },
  async "step.started"(_event, ctx) {
    if (!lifecycleConfigured() || !["github", "subagent"].includes(ctx.channel.kind ?? "")) return;
    await heartbeatReview(trustedGitHubContext(ctx.session.auth.current), ctx.session.parent ? undefined : ctx.session.id, ctx.session.id);
  },
  async "step.completed"(_event, ctx) {
    if (!lifecycleConfigured() || !["github", "subagent"].includes(ctx.channel.kind ?? "")) return;
    await heartbeatReview(trustedGitHubContext(ctx.session.auth.current), ctx.session.parent ? undefined : ctx.session.id, ctx.session.id);
  },
} });
