import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { routingEnvelope } from "../../../../../src/models/routing";
import { assertStrictToolSchema } from "../../../strict-tool-schema";

export function capabilityProbeResponse(request: MockModelRequest): MockModelResponse | string | null {
  const prompt = request.userMessages.join("\n");
  if (!prompt.includes("KGR-EVAL-CAPABILITY-")) return null;
  const names = request.tools.map(tool => tool.name);
  if (prompt.includes("KGR-EVAL-CAPABILITY-CHILD")) {
    const forbidden = ["bash", "read_file", "write_file", "glob", "grep", "web_fetch", "load_skill", "read_review_evidence", "fixture_dynamic", "agent", "task_cancel"];
    const expected = ["inspect_review_source", "run_review_probe", "read_review_probe", "fetch_review_reference", "inspect_review_image", "review_work"];
    if (forbidden.some(name => names.includes(name)) || expected.some(name => !names.includes(name))) throw new Error(`Unexpected assigned work capabilities: ${JSON.stringify(names)}`);
    // One native-build guard checks the actual resolved request. The variant
    // matrices remain in bun test, using the same strict-subset assertions.
    for (const tool of request.tools.filter(tool => ["review_work", "inspect_review_source"].includes(tool.name))) {
      assertStrictToolSchema(tool.inputSchema, tool.name);
    }
    // Replay the two failure shapes through Eve's compiled tool boundary. They
    // must return validation errors to this same child before sandbox execution.
    const source = request.toolResults.find(result => result.name === "inspect_review_source");
    if (!source) return { toolCalls: [{ name: "inspect_review_source", input: {
      revision: "head", cursor: null, target: { operation: "search", path: "src/config.ts", query: "routing" },
    } }] };
    if (!source.isError || !JSON.stringify(source.output).includes("input")) throw new Error("Native source schema did not reject the recorded contradiction");
    const work = request.toolResults.find(result => result.name === "review_work");
    if (!work) return { toolCalls: [{ name: "review_work", input: { action: { operation: "complete", reviewedEntries: [0] } } }] };
    if (!work.isError || !JSON.stringify(work.output).includes("input")) throw new Error("Native work schema did not reject the missing report");
    return "CAPABILITY-CHILD-COMPLETE SOURCE-AND-REPORT-INPUTS-REJECTED";
  }
  for (const name of ["bash", "read_file", "write_file", "glob", "grep", "web_fetch", "read_review_evidence", "fixture_dynamic", "agent"]) {
    if (!names.includes(name)) throw new Error(`Coordinator lost native capability ${name}: ${JSON.stringify(names)}`);
  }
  if (names.includes("inspect_review_source") || names.includes("review_work")) throw new Error("Coordinator acquired assigned-only capabilities");
  if (!request.toolResults.some(result => result.name === "fixture_dynamic")) return { toolCalls: [{ name: "fixture_dynamic", input: {} }] };
  const result = request.toolResults.find(result => result.name === "fixture_workflow");
  if (result) {
    if (result.isError || !JSON.stringify(result.output).includes("CAPABILITY-CHILD-COMPLETE")) throw new Error(`Capability child failed: ${JSON.stringify(result)}`);
    return "CAPABILITY-RESOLUTION-COMPLETE";
  }
  return { toolCalls: [{ name: "fixture_workflow", input: { message: `${routingEnvelope({ role: "lane", axis: "engineering-quality", attempt: 0, workId: "a".repeat(64) })}\nKGR-EVAL-CAPABILITY-CHILD` } }] };
}
