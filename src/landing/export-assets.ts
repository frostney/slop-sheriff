import { readFile, writeFile } from "node:fs/promises";
import { findingReactions } from "../branding";

// Run with `bun src/landing/export-assets.ts` after updating the brand exports.
// Eve has no public asset directory, so ordinary JSON imports carry these bytes
// through authored-module evaluation and the production bundle.
const sourceDirectory = new URL("../../docs/assets/", import.meta.url);
const filenames = ["slop-sheriff-hero.webp", "slop-sheriff-icon.png", "slop-sheriff-social.jpg", ...Object.values(findingReactions).map(({ filename }) => filename)];
const entries = await Promise.all(filenames.map(async (filename) => [
  filename,
  (await readFile(new URL(filename, sourceDirectory))).toString("base64"),
]));
await writeFile(new URL("./assets.json", import.meta.url), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
