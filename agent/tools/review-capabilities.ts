import { defineDynamic, defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";
import { glob } from "eve/tools/glob";
import { grep } from "eve/tools/grep";
import { todo } from "eve/tools/todo";
import { loadSkill } from "eve/tools/load_skill";
import { webFetch } from "eve/tools/web_fetch";
import { currentReviewRoute } from "../lib/review-route";
import { isAssignedReviewWork } from "../lib/review-capabilities";

export default defineDynamic({ events: {
  "step.started": (_event, ctx) => {
    if (isAssignedReviewWork(currentReviewRoute(ctx.channel.kind, ctx.messages))) return null;
    // Inline authored callbacks preserve Eve's durable dynamic descriptors.
    // Native executors retain their installed implementation and validation.
    return {
      bash: defineTool({ description: bash.description, inputSchema: bash.inputSchema,
        async execute(input, toolContext) { return bash.execute(input, toolContext); } }),
      read_file: defineTool({ description: readFile.description, inputSchema: readFile.inputSchema,
        async execute(input, toolContext) { return readFile.execute(input, toolContext); } }),
      write_file: defineTool({ description: writeFile.description, inputSchema: writeFile.inputSchema,
        async execute(input, toolContext) { return writeFile.execute(input, toolContext); } }),
      glob: defineTool({ description: glob.description, inputSchema: glob.inputSchema,
        async execute(input, toolContext) { return glob.execute(input, toolContext); } }),
      grep: defineTool({ description: grep.description, inputSchema: grep.inputSchema,
        async execute(input, toolContext) { return grep.execute(input, toolContext); } }),
      todo: defineTool({ description: todo.description, inputSchema: todo.inputSchema,
        async execute(input, toolContext) { return todo.execute(input, toolContext); } }),
      load_skill: defineTool({ description: loadSkill.description, inputSchema: loadSkill.inputSchema,
        async execute(input, toolContext) { return loadSkill.execute(input, toolContext); } }),
      web_fetch: defineTool({ description: webFetch.description, inputSchema: webFetch.inputSchema,
        async execute(input, toolContext) { return webFetch.execute(input, toolContext); } }),
    };
  },
} });
