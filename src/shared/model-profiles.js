/** OpenAI gpt-image-2.5 family (sunburst, flare, …). */
export const GPT_IMAGE_25 = /^(?:openai\/)?gpt-image-2\.5(?:-|$)/i;
export const GPT_IMAGE_26 = /^(?:openai\/)?gpt-image-2\.6(?:-|$)/i;
/** ByteDance Seedream 5.5 family — accepts free WIDTHxHEIGHT, padded to 16px. */
export const SEEDREAM_5_5 = /seedream[-_.]5[-_.]5/i;
/** Sourceful Riverflow family — a Flux-based id such as sourceful/riverflow-v2.6-pro. */
export const RIVERFLOW = /(?:^|\/)riverflow-/i;

/** Default ProxyAPI text-to-image model when imageModel is unset. See https://proxyapi.ru/models/browse/image */
export const PROXY_IMAGE_MODEL = 'openai/gpt-image-2.6-sunburst';

/**
 * Default ProxyAPI model for edits and image-conditioned generation. Same gpt-image-2.5 family as
 * the generation default; both ids accept a source image and are interchangeable through --image-model.
 */
export const PROXY_IMAGE_EDIT_MODEL = 'openai/gpt-image-2.6-sunburst';

/** Default ProxyAPI vector (SVG) model. See https://proxyapi.ru/models/recraft/recraft-v4.1-pro-vector */
export const PROXY_VECTOR_MODEL = 'recraft/recraft-v4.1-pro-vector';

/**
 * Riverflow V2.6 Pro (Flux-based, https://proxyapi.ru/models/sourceful/riverflow-v2.6-pro). It is
 * an opt-in id rather than a default: not every gateway serves it, so `--image-model` or
 * `imageModel` in the config is what selects it.
 */
export const PROXY_RIVERFLOW_MODEL = 'sourceful/riverflow-v2.6-pro';

/**
 * What an image model is known to accept. A model absent from `IMAGE_MODEL_PROFILES` gets these
 * values, which is the plain `/images/generations` behaviour the vendor presets describe.
 *   `customSizes`             — an arbitrary WIDTHxHEIGHT goes into `size` instead of an IMAGE_SIZES preset;
 *   `div16Padding`            — /images/edits inputs must be padded to a 16-pixel multiple first;
 *   `keepProSuffix`           — the `-pro` suffix survives a small frame (the Recraft tier swap is not for it);
 *   `omitSizeOnReject`        — when the host rejects the frame, retry once with `size` left out entirely;
 *   `complexity`              — complexity tier the model understands (e.g. 'high' for riverflow);
 *   `routeEditsThroughGeneration` — /images/edits drops the size and tuning fields for this
 *                     family; send the source as `input_references` on /images/generations instead.
 *   `minPixels`/`maxPixels`   — the accepted frame area in pixels; a frame outside the range is
 *                     rescaled to the nearest same-ratio size that fits;
 *   `maxEdge`                 — longest side the model accepts;
 *   `maxRatio`                — widest aspect ratio (longest side over shortest);
 *   `padToMinPixels`          — a source smaller than `minPixels` is padded with empty space up to
 *                     the smallest frame the model accepts, and the padding is cut off the reply
 *                     again, instead of asking the model to upscale the source itself.
 */
export const IMAGE_CAPABILITIES = Object.freeze({
    customSizes: false, div16Padding: false, keepProSuffix: false, omitSizeOnReject: false,
    padToMinPixels: false,
    complexity: null, routeEditsThroughGeneration: false, resolutionTiers: false,
    /** The gateway answers `background: transparent` with a painted plate instead of an alpha channel. */
    paintsFakeTransparency: false,
    minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3,
});

/**
 * Rules in match order; the first match wins, so a narrow family comes before a broad one.
 * Riverflow keeps its `-pro` suffix at any frame — the suffix is the model, not a size tier — and
 * takes no 16-pixel padding. Its frame support differs between gateways, so a refused frame costs
 * one retry without the field rather than the whole request.
 * Riverflow also supports complexity (`complexity: 'high'`); it accepts
 * aspect ratios via `aspect_ratio` and resolution tiers via `resolution` instead of pixel presets.
 * `routeEditsThroughGeneration` — the multipart /images/edits route silently drops the size,
 * resolution, aspect_ratio, quality and reasoning fields for this family and answers with the
 * gateway default square. The source picture travels as `input_references` on /images/generations
 * instead, where every field is honored.
 * Riverflow takes a far smaller frame than gpt-image (128x128 is already legal) and a much wider
 * ratio, so its limits are spelled out here rather than guessed from the model id.
 * Seedream 5.5 (`bytedance-seed/seedream-5-5`) draws free frames on a 16-pixel grid like
 * gpt-image-2.6, but its floor is a megapixel-class canvas — 960x960 (921 600 px) is the smallest
 * frame it answers. It does not reliably upscale a small source: asked for a bigger frame than the
 * picture it was given, it can leave the object at its own size in the top-left corner and fill the
 * rest of the canvas. So the source is padded to the smallest legal frame up front and the padding
 * is cut off the reply again — the object keeps its scale, nothing is resampled.
 */
export const IMAGE_MODEL_PROFILES = Object.freeze([
    Object.freeze({ match: GPT_IMAGE_26, customSizes: true, div16Padding: true, complexity: 'high', minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3 }),
    Object.freeze({ match: SEEDREAM_5_5, customSizes: true, div16Padding: true, padToMinPixels: true, keepProSuffix: true, complexity: 'high', minPixels: 921_600, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3 }),
    Object.freeze({ match: GPT_IMAGE_25, customSizes: true, div16Padding: true }),
    Object.freeze({ match: RIVERFLOW, customSizes: true, keepProSuffix: true, omitSizeOnReject: true, complexity: 'high', routeEditsThroughGeneration: true, resolutionTiers: true, paintsFakeTransparency: true, minPixels: 16_384, maxPixels: 16_777_216, maxEdge: 4096, maxRatio: 16 }),
]);


/**
 * Profile of a model the registry does not list. No ceiling and no ladder, so nothing is restricted.
 */
export const DEFAULT_PROFILE = Object.freeze({ window: 128 * 1024, maxOutput: 16384, ceiling: null, efforts: null, modes: null });

/**
 * Known models.
 * `window`    — context window in bytes; the `auto` context level and the model choice both read it.
 * `maxOutput` — largest `max_output_tokens` the model accepts; decides how much of a task fits one call.
 * `ceiling`   — hardest stop for reasoning effort: a request above it is lowered to it. Null means no stop.
 * `efforts`   — the ladder this model is configured to tear across. Null means the whole ladder down to the ceiling.
 *               A request snaps to the nearest level of the set, preferring the one below it.
 * `modes`     — gateway reasoning modes this model receives (`reasoning.mode`). Null means the
 *               configuration is sent as asked; an empty array keeps the field away from the model.
 * Override any field for one installation in the `models.<id>` section of the configuration.
 */
export const MODEL_PROFILES = Object.freeze({
    'gpt-6.1-sol': { window: 256 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null, modes: null },
    'gpt-6.1-terra': { window: 256 * 1024, maxOutput: 32768, ceiling: 'max', efforts: null, modes: null },
    'gpt-6-luna': { window: 256 * 1024, maxOutput: 16384, ceiling: 'max', efforts: null, modes: null },
    'gpt-6-astra': { window: 200 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null, modes: null },
    'gpt-6-luna-decisions': { window: 128 * 1024, maxOutput: 256, ceiling: null, efforts: null, modes: [] },
    
    'openai/gpt-6.1-sol': { window: 256 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null, modes: null },
    'openai/gpt-6.1-terra': { window: 256 * 1024, maxOutput: 32768, ceiling: 'max', efforts: null, modes: null },
    'openai/gpt-6-luna': { window: 256 * 1024, maxOutput: 16384, ceiling: 'max', efforts: null, modes: null },
    'openai/gpt-6-astra': { window: 200 * 1024, maxOutput: 32768, ceiling: 'xhigh', efforts: null, modes: null },
    'openai/gpt-6-luna-decisions': { window: 128 * 1024, maxOutput: 256, ceiling: null, efforts: null, modes: [] },

    'moonshotai/kimi-k3.1-pro': { window: 256 * 1024, maxOutput: 32768, ceiling: 'max', efforts: null, modes: null },
});
