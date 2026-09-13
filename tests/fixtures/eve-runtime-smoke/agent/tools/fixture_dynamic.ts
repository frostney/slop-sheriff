import { defineTool } from "eve/tools";
import { z } from "zod";
import { outsideReviewWork } from "../../../../../agent/lib/review-capabilities";
export const definition = defineTool({ description: "Exercise native dynamic tool identity.", inputSchema: z.strictObject({}), async execute() { return { observed: true }; } });
export default outsideReviewWork(definition);
