/** Assertions for the documented strict subset, not a simulated provider. */
export function assertStrictToolSchema(schema: unknown, name: string): void {
  const fail = (path: string, reason: string): never => { throw new Error(`${name} ${path}: ${reason}`); };
  function visit(node: unknown, path: string): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) fail(path, "Expected a schema object");
    const value = node as Record<string, unknown>;
    // https://developers.openai.com/api/docs/guides/structured-outputs
    for (const keyword of ["oneOf", "allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"]) {
      if (keyword in value) fail(path, `Unsupported strict keyword ${keyword}`);
    }
    if (value.type === "object") {
      if (value.additionalProperties !== false) fail(path, "Object must be closed");
      const properties = value.properties as Record<string, unknown> | undefined;
      if (JSON.stringify([...(value.required as string[] ?? [])].sort()) !== JSON.stringify(Object.keys(properties ?? {}).sort())) {
        fail(path, "Every property must be required");
      }
    }
    for (const key of ["properties", "$defs", "definitions"] as const) {
      for (const [child, entry] of Object.entries(value[key] as Record<string, unknown> ?? {})) visit(entry, `${path}.${key}.${child}`);
    }
    if (value.items !== undefined) visit(value.items, `${path}.items`);
    if (Array.isArray(value.anyOf)) value.anyOf.forEach((entry, index) => visit(entry, `${path}.anyOf.${index}`));
  }
  visit(schema, "$");
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" || "anyOf" in root) fail("$", "Root must be an object without anyOf");
}
