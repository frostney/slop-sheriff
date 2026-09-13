import { defineHook } from "eve/hooks";
import { z } from "zod";
import { reviewToolResult } from "../../../../../agent/lib/review-tool-results";
export default defineHook({ events: { "action.result": (event) => {
  if (event.data.result.kind === "tool-result" && event.data.result.toolName === "fixture_dynamic" && !reviewToolResult(event.data.result, "fixture_dynamic", z.strictObject({ observed: z.literal(true) }))) throw new Error("Dynamic tool lost validated native action result");
} } });
