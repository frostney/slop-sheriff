type Position = "value" | "done" | "key-or-end" | "key" | "colon" | "object-value" | "object-next" | "array-value-or-end" | "array-value" | "array-next";

/** Reject only impossible JSON prefixes, never valid work based on size or time. */
export class ToolInputJsonPrefix {
  private positions: Position[] = ["value"];
  private token: "string" | "number" | "literal" | null = null;
  private key = false;
  private escaped = false;
  private unicode = 0;
  private unicodeDigits = "";
  private keyText = "";
  private number: "sign" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "exponent-sign" | "exponent-digits" = "integer";
  private literal = "";

  constructor(private readonly rootKeys?: readonly string[]) {}

  private keyCharacter(character: string) {
    if (!this.key || this.positions.length !== 2 || !this.rootKeys) return;
    this.keyText += character;
    if (!this.rootKeys.some(key => key.startsWith(this.keyText))) this.invalid();
  }

  private invalid(): never { throw new Error("Invalid streamed tool JSON; generation stopped before tool execution"); }
  private get position(): Position { return this.positions.at(-1)!; }
  private set position(value: Position) { this.positions[this.positions.length - 1] = value; }
  private valueFinished() {
    this.position = this.position === "value" ? "done" : this.position === "object-value" ? "object-next" : "array-next";
  }
  private finishNumber() {
    if (!["zero", "integer", "fraction", "exponent-digits"].includes(this.number)) this.invalid();
    this.token = null;
    this.valueFinished();
  }

  append(text: string): void {
    for (const character of text) this.character(character);
  }

  private character(character: string): void {
    if (this.token === "string") {
      if (this.unicode) {
        if (!/[\da-f]/i.test(character)) this.invalid();
        this.unicodeDigits += character;
        this.unicode--;
        if (!this.unicode) this.keyCharacter(String.fromCharCode(parseInt(this.unicodeDigits, 16)));
      } else if (this.escaped) {
        this.escaped = false;
        if (character === "u") { this.unicode = 4; this.unicodeDigits = ""; }
        else if (!'"\\/bfnrt'.includes(character)) this.invalid();
        else this.keyCharacter(JSON.parse(`"\\${character}"`) as string);
      } else if (character === "\\") this.escaped = true;
      else if (character === '"') {
        this.token = null;
        if (this.key) {
          if (this.positions.length === 2 && this.rootKeys && !this.rootKeys.includes(this.keyText)) this.invalid();
          this.position = "colon";
        }
        else this.valueFinished();
      } else if (character.charCodeAt(0) < 32) this.invalid();
      else this.keyCharacter(character);
      return;
    }
    if (this.token === "literal") {
      if (character !== this.literal[0]) this.invalid();
      this.literal = this.literal.slice(1);
      if (!this.literal) { this.token = null; this.valueFinished(); }
      return;
    }
    if (this.token === "number") {
      if (/[\deE+.-]/.test(character)) {
        const state = this.number;
        if (state === "sign" && /\d/.test(character)) this.number = character === "0" ? "zero" : "integer";
        else if (state === "integer" && /\d/.test(character)) { /* another integer digit */ }
        else if ((state === "zero" || state === "integer") && character === ".") this.number = "dot";
        else if ((state === "dot" || state === "fraction") && /\d/.test(character)) this.number = "fraction";
        else if (["zero", "integer", "fraction"].includes(state) && /[eE]/.test(character)) this.number = "exponent";
        else if (state === "exponent" && /[+-]/.test(character)) this.number = "exponent-sign";
        else if (["exponent", "exponent-sign", "exponent-digits"].includes(state) && /\d/.test(character)) this.number = "exponent-digits";
        else this.invalid();
        return;
      }
      this.finishNumber();
    }
    if (/[ \t\r\n]/.test(character)) return;
    const position = this.position;
    if (character === "}" && (position === "key-or-end" || position === "object-next") || character === "]" && (position === "array-value-or-end" || position === "array-next")) {
      this.positions.pop();
      this.valueFinished();
      return;
    }
    if (position === "colon") {
      if (character !== ":") this.invalid();
      this.position = "object-value";
      return;
    }
    if (position === "object-next" || position === "array-next") {
      if (character !== ",") this.invalid();
      this.position = position === "object-next" ? "key" : "array-value";
      return;
    }
    if (position === "key" || position === "key-or-end") {
      if (character !== '"') this.invalid();
      this.token = "string";
      this.key = true;
      this.keyText = "";
      return;
    }
    if (position === "done") this.invalid();
    if (character === "{") this.positions.push("key-or-end");
    else if (character === "[") this.positions.push("array-value-or-end");
    else if (character === '"') { this.token = "string"; this.key = false; }
    else if (/[\d-]/.test(character)) { this.token = "number"; this.number = character === "-" ? "sign" : character === "0" ? "zero" : "integer"; }
    else if (character === "t" || character === "f" || character === "n") {
      this.token = "literal";
      this.literal = character === "t" ? "rue" : character === "f" ? "alse" : "ull";
    } else this.invalid();
  }

  finish(): void {
    if (this.token === "number") this.finishNumber();
    if (this.token || this.positions.length !== 1 || this.position !== "done") this.invalid();
  }
}

export function toolInputStreamValidator(tools?: ReadonlyArray<Record<string, unknown>>) {
  const schemas = new Map(tools?.map(tool => [tool.name, tool.inputSchema]));
  const inputs = new Map<string, ToolInputJsonPrefix>();
  return (value: unknown) => {
    if (typeof value !== "object" || value === null || !("type" in value) || !("id" in value) || typeof value.id !== "string") return;
    if (value.type === "tool-input-start" && !("providerExecuted" in value && value.providerExecuted)) {
      const schema = schemas.get("toolName" in value ? value.toolName : undefined);
      const keys = typeof schema === "object" && schema !== null && "additionalProperties" in schema && schema.additionalProperties === false
        && !("patternProperties" in schema) && "properties" in schema && typeof schema.properties === "object" && schema.properties !== null
        ? Object.keys(schema.properties) : undefined;
      inputs.set(value.id, new ToolInputJsonPrefix(keys));
    }
    if (value.type === "tool-input-delta" && "delta" in value && typeof value.delta === "string") inputs.get(value.id)?.append(value.delta);
    if (value.type === "tool-input-end") { inputs.get(value.id)?.finish(); inputs.delete(value.id); }
  };
}
