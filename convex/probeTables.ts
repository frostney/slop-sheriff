import { defineTable } from "convex/server";
import { v } from "convex/values";

export const probeTables = {
  reviewProbeClaims: defineTable({
    attemptId: v.string(), path: v.string(), owner: v.string(),
    status: v.union(v.literal("running"), v.literal("released"), v.literal("interrupted")),
  }).index("by_attemptId_and_path", ["attemptId", "path"]),
};
