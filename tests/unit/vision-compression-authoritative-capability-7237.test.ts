/**
 * #7237 — vision-capable models lose image_url blocks under compression.
 *
 * `open-sse/handlers/chatCore.ts` fed `applyCompressionAsync`'s `supportsVision` option
 * from `isVisionModelId(effectiveModel)` — the deliberately-conservative model-id
 * fragment heuristic in `src/shared/constants/visionModels.ts` — instead of the
 * authoritative `getResolvedModelCapabilities().supportsVision` that every other
 * vision-aware code path (e.g. the vision-bridge guardrail) uses.
 *
 * `gpt-5.5` is registered with `supportsVision: true` in `src/shared/constants/modelSpecs.ts`
 * but has no gpt-5.x entry in the fragment list, so the heuristic wrongly returned `false`.
 * `open-sse/services/compression/lite.ts::replaceImageUrls()` gates on
 * `supportsVision !== false`, so that spurious `false` made it silently strip every
 * `image_url` block from the request before it ever reached the executor.
 *
 * This test asserts the CORRECT, authoritative-capability-driven behavior: gpt-5.5
 * keeps its images through the lite-compression path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isVisionModelId } from "../../src/shared/constants/visionModels.ts";
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { replaceImageUrls } from "../../open-sse/services/compression/lite.ts";
import { applyCompressionAsync } from "../../open-sse/services/compression/strategySelector.ts";

function imageBody() {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
      },
    ],
  };
}

describe("#7237 vision-capable models keep their images through compression", () => {
  it("the heuristic AND authoritative spec both agree that gpt-5.5 is vision-capable", () => {
    assert.equal(
      isVisionModelId("gpt-5.5"),
      true,
      "the fragment-list heuristic now includes a gpt-5 entry — gpt-5.5 matched by substring"
    );
    assert.equal(
      getResolvedModelCapabilities({ model: "gpt-5.5" }).supportsVision,
      true,
      "modelSpecs.ts registers gpt-5.5 with supportsVision:true — authoritative source agrees"
    );
  });

  it("replaceImageUrls preserves the image when fed the heuristic value (both paths agree on gpt-5.5)", () => {
    const heuristicSupportsVision = isVisionModelId("gpt-5.5");
    const result = replaceImageUrls(imageBody(), { supportsVision: heuristicSupportsVision });
    assert.equal(result.applied, false, "the image must be KEPT, not stripped to a placeholder");
    const content = result.body.messages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, "image_url", "the block must remain a real image_url block");
  });

  it("applyCompressionAsync end-to-end (lite mode) keeps image_url blocks for gpt-5.5", async () => {
    const model = "gpt-5.5";
    const supportsVision = isVisionModelId(model);
    const result = await applyCompressionAsync(imageBody(), "lite", { model, supportsVision });
    const content = (result.body as { messages: Array<{ content: unknown }> }).messages[0]
      .content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, "image_url", "gpt-5.5 must keep its image_url block intact");
    assert.equal(
      (content[0].image_url as Record<string, unknown>)?.url,
      "data:image/png;base64,iVBOR",
      "the original data URL must survive unchanged"
    );
  });
});
