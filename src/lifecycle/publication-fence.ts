import type { TrustedGitHubContext } from "../github/trusted-context";
import { heartbeatReview, lifecycleConfigured } from "./client";

const fencedClients = new WeakMap<object, string | undefined>();

/**
 * Fence immediately before each provider mutation and renew the durable lease.
 * GitHub has no cross-system transaction: a request already accepted can finish
 * after supersession. Its lease therefore blocks replacement publication until
 * that bounded request finishes or expires, so it cannot overwrite a newer result.
 */
export function fencePublicationWrites<T extends object>(client: T, context: TrustedGitHubContext): T {
  if (!lifecycleConfigured() || fencedClients.has(client) && fencedClients.get(client) === context.deliveryId) return client;
  const wrap = (target: object): object => new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (value && typeof value === "object") return wrap(value);
      if (typeof value !== "function") return value;
      const method = String(key);
      if (!/^(create|update|delete|submit|dismiss|mark|remove|add|set|resolve)/i.test(method) && method !== "graphql" && method !== "request") return value;
      return async (...args: unknown[]) => {
        const first = args[0];
        const route = typeof first === "string" ? first : typeof first === "object" && first !== null
          ? String((first as Record<string, unknown>).method ?? (first as Record<string, unknown>).query ?? "") : "";
        const mutates = method !== "request" && method !== "graphql" || /^(POST|PATCH|PUT|DELETE)\b|\bmutation\b/i.test(route);
        if (mutates) {
          await heartbeatReview(context);
          const optionsIndex = typeof args[0] === "string" ? 1 : 0;
          const options = args[optionsIndex];
          if (typeof options === "object" && options !== null) {
            const original = options as Record<string, unknown>;
            const request = typeof original.request === "object" && original.request !== null ? original.request : {};
            args[optionsIndex] = { ...original, request: { ...request, signal: AbortSignal.timeout(30_000) } };
          }
        }
        return Reflect.apply(value, object, args);
      };
    },
  });
  const fenced = wrap(client) as T;
  fencedClients.set(fenced, context.deliveryId);
  return fenced;
}
