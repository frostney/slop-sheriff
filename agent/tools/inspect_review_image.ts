import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { assignedReviewWorkOnly } from "../lib/review-capabilities";
import { assignedReviewWorkContext } from "../lib/assigned-review-work";
import { recordWorkExternalObservation } from "../../src/review/external-observations";

export const inspectReviewImageInputSchema = z.strictObject({ path: z.string().startsWith("/workspace/").refine(value => !value.split("/").some(part => part === "..") && !value.includes("\0")) });
export const reviewTool = defineTool({
  description: "Inspect a repository image or screenshot produced by a recorded browser probe. Use an absolute /workspace/ path. The application records the actual image bytes; the model receives a native image part. Image-dependent assessment reuse is conservatively invalidated on later reviews. Run browser scenarios with run_review_probe and save screenshots under /workspace/.",
  inputSchema: inspectReviewImageInputSchema,
  async execute(input, ctx) {
    const { sandbox, claims, identity } = await assignedReviewWorkContext(ctx);
    // Resolve symlinks before the privileged native file read.
    const encoded = Buffer.from(input.path).toString("base64");
    const resolved = await sandbox.run({ command: `python3 - <<'PY'\nimport os,base64\np=os.path.realpath(base64.b64decode('${encoded}').decode())\nif not p.startswith('/workspace/'): raise RuntimeError('Image path escapes workspace')\nprint(p)\nPY` });
    if (resolved.exitCode !== 0) throw new Error("Image path is outside the prepared workspace");
    const bytes = await sandbox.readBinaryFile({ path: String(resolved.stdout).trim() });
    if (bytes === null) throw new Error("Review image does not exist");
    const data = Buffer.from(bytes);
    const mediaType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString()) ? "image/gif"
      : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
    if (mediaType === null) throw new Error("Review image must be PNG, JPEG, GIF or WebP");
    const base64 = data.toString("base64");
    const observation = await recordWorkExternalObservation(sandbox, claims, identity, { kind: "image", target: input.path, content: base64 }, ctx.abortSignal);
    return { path: input.path, observationId: observation.id, digest: observation.outputDigest, mediaType, base64 };
  },
  toModelOutput(output) { return toolOutput.content([toolOutputPart.text(JSON.stringify({ path: output.path, observationId: output.observationId, digest: output.digest })), toolOutputPart.file(output.base64, { mediaType: output.mediaType })]); },
});
export default assignedReviewWorkOnly(reviewTool);
