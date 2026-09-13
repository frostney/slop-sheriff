import { expect, test } from "bun:test";
import { ToolInputJsonPrefix, toolInputStreamValidator } from "../src/models/tool-input-stream";

test("valid JSON survives every stream split, nesting, escapes and long technical input", () => {
  const sources = [JSON.stringify({ command: 'printf "hello"\n', evidence: [null, true, false, -3.25e20, {}, [], { key: "🤠" }] }), ' "\\uD83E\\uDD20" ', "-12.34e-56", "[0,1E+4]", JSON.stringify({ description: "technical terms ".repeat(10000) })];
  for (const source of sources) {
    // Include single-character chunking, so strings and escapes cross boundaries.
    const parser = new ToolInputJsonPrefix();
    for (const char of source) parser.append(char);
    expect(() => parser.finish()).not.toThrow();
    if (source.length > 1000) continue;
    for (let split = 0; split <= source.length; split++) {
      const fragmented = new ToolInputJsonPrefix();
      fragmented.append(source.slice(0, split)); fragmented.append(source.slice(split));
      expect(() => fragmented.finish()).not.toThrow();
    }
  }
});

test.each(['{"command":"bun test",}', '{"command":"x"} extra', '{"key" garbage', '{"x":"raw\nnewline"}', '[1,]', '[01]', '[1e]', '[true false]', '{"x":"\\q"}', '{"x":"\\u0z"}', '{]'])('rejects irreparable prefix %s', source => {
  const parser = new ToolInputJsonPrefix();
  expect(() => parser.append(source)).toThrow("Invalid streamed tool JSON");
});

test.each(['{"x":', '{"x":"', '[1e', 'tru', ''])('incomplete prefix %s remains valid until input ends', source => {
  const parser = new ToolInputJsonPrefix();
  expect(() => parser.append(source)).not.toThrow();
  expect(() => parser.finish()).toThrow("Invalid streamed tool JSON");
});

test("interleaved tool inputs and provider-executed tools have independent state", () => {
  const validate = toolInputStreamValidator();
  for (const id of ["a", "b"]) validate({ type: "tool-input-start", id });
  validate({ type: "tool-input-start", id: "provider", providerExecuted: true });
  validate({ type: "tool-input-delta", id: "provider", delta: "provider-specific format" });
  validate({ type: "tool-input-delta", id: "a", delta: '{"a":' });
  validate({ type: "tool-input-delta", id: "b", delta: '{"b":2}' });
  validate({ type: "tool-input-end", id: "b" });
  validate({ type: "tool-input-delta", id: "a", delta: '1}' });
  expect(() => validate({ type: "tool-input-end", id: "a" })).not.toThrow();
});

test("the recorded PR43 unknown key is rejected before its unbounded string can grow", () => {
  const parser = new ToolInputJsonPrefix(["command"]);
  expect(() => parser.append('{"command":"cd /workspace && bun test tests/report-assembly.test.ts tests/thread-delivery.test.ts","}}]} shape invalid?')).toThrow("Invalid streamed tool JSON");
});

test("schema key prefixes preserve escaped legal names and nested object keys", () => {
  for (const source of ['{"com":1}', '{"command":1}', '{"co\\u006dmand":{"arbitrary":true}}', '{"\\uD83E\\uDD20":1}']) {
    const parser = new ToolInputJsonPrefix(["com", "command", "🤠"]);
    for (const character of source) parser.append(character);
    expect(() => parser.finish()).not.toThrow();
  }
  expect(() => new ToolInputJsonPrefix(["command"]).append('{"co":')).toThrow();
});
