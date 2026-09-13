import type { HookEvent } from "eve/hooks";
import { z } from "zod";

/** Eve 0.52's toolResultFrom does not register inner dynamic definitions.
 * Match the native action envelope, then validate the concrete returned contract. */
export function reviewToolResult<T>(result: HookEvent<"action.result">["data"]["result"], name: string, schema: z.ZodType<T>): T | undefined {
  if (result.kind !== "tool-result" || result.isError === true || result.toolName !== name) return undefined;
  const parsed = schema.safeParse(result.output);
  return parsed.success ? parsed.data : undefined;
}
