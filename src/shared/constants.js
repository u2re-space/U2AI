

import { STANDARD_RATIOS, aspectFrame } from './aspect-ratio.js';
import { IMAGE_CAPABILITIES, IMAGE_MODEL_PROFILES } from './model-profiles.js';

/** Names that choose a common frame instead of a literal WIDTHxHEIGHT. */
export const NAMED_FRAMES = { square: 1, landscape: 16 / 10, portrait: 10 / 16 };

/** Raster and vector inputs a comparison or a matte can read. */
export const READABLE_EXT = /\.(png|jpe?g|webp|gif|tiff?|bmp|avif|svg)$/i;

/** Prompt the vector model gets when the caller did not describe the artwork. */
export const DEFAULT_VECTOR_PROMPT = 'Vectorize the attached image exactly as it is: keep the original shapes, palette, and proportions; flat shapes with smooth paths and a transparent background; do not redesign it or add new colors.';

/** Raster extensions worth offering for vectorization. */
export const VECTOR_SOURCE_EXT = /\.(png|webp)$/i;

/** A name that says "this must be a vector": marks, badges, logos, icons. */
export const VECTOR_HINT = /logo|badge|icon|emblem|seal|wordmark|logotype|stamp|марк|логотип|эмблем|знач|наклейк|герб|печать|щит/i;

/** Reasons that mean the raster is already cut out and can go straight to the vector model. */
export const CUT_OUT = new Set(['native', 'mask', 'contour', 'flat', 'key', 'already']);

/** Prompt for a grayscale alpha matte that preserves the subject and cleanly removes its background. */
export const ALPHA_MASK_PROMPT = 'Return an A-mask (matte) for the attached image that will be composited onto an RGB background to produce the final RGBA image. '
    + 'This is the alpha channel of a two-part composition: RGB + A-mask = RGBA. '
    + 'White (255) marks the subject that must stay visible — the artwork, logo, product, or person. '
    + 'Black (0) marks everything that must become transparent, including any checkerboard, grid, or flat plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, not a wide soft glow, and the interior of the subject pure white. '
    + 'The mask must trace the subject contour tightly: a one- or two-pixel gray transition exactly on the silhouette creates a clean anti-aliased edge in the final composite. '
    + 'Do not widen the transition into a soft glow — that makes the rim milky and eats into the artwork. Do not make alpha edges too blurry! '
    + 'The interior of the subject must be pure white; the transparent area must be pure black. '
    + 'Output the matte/mask only: grayscale, no colors, no text, no border, no shadow.';

/**
 * Prompt for the mask pass. A matte rather than a transparent picture: most vendors cannot emit
 * alpha and paint a checkerboard or a flat plate instead, and a matte converts cleanly into a real
 * alpha channel. The matte must be anti-aliased: a one- or two-pixel gray transition along the
 * silhouette is what keeps the cut free of stair-stepping, while a wide soft gradient would make
 * the rim milky and eat into the artwork.
 */
    + 'Return an A-mask (matte) for the attached image that will be composited onto an RGB background to produce the final RGBA image. '
    + 'This is the alpha channel of a two-part composition: RGB + A-mask = RGBA. '
    + 'White (255) marks the subject that must stay visible — the artwork, logo, product, or person. '
    + 'Black (0) marks everything that must become transparent, including any checkerboard, grid, or flat plate that only imitates transparency. '
    + 'Keep the exact framing and proportions of the source. '
    + 'Edges must be anti-aliased: a one- or two-pixel gray transition exactly on the silhouette, not a wide soft glow, and the interior of the subject pure white. '
    + 'The mask must trace the subject contour tightly: a one- or two-pixel gray transition exactly on the silhouette creates a clean anti-aliased edge in the final composite. '
    + 'Do not widen the transition into a soft glow — that makes the rim milky and eats into the artwork. Do not make alpha edges too blurry! '
    + 'The interior of the subject must be pure white; the transparent area must be pure black. '
    + 'Output the matte/mask only: grayscale, no colors, no text, no border, no shadow.';


/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same '
    + 'proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or '
    + 'pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

export const BACKGROUND_PAINT_PROMPT = 'You are creating the RGB channel for a two-part RGBA composition (RGB + A-mask = RGBA). '
    + 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. '
    + 'This flat color will serve as the RGB base that the A-mask composites over: no gradients, no texture, no shadow, no new objects.';

/**
 * Paint prompt with an explicit hex color instead of "dominant color of the subject".
 *
 * Used when the model does not reliably pick a color on its own (e.g. riverflow).
 * @param {string} hex — `#RRGGBB`
 * @returns {string}
 * @ai.hint pure
 */
export function paintPromptWithColor(hex) {
    return 'You are creating the RGB channel for a two-part RGBA composition (RGB + A-mask = RGBA). '
        + 'Fill the whole background with the solid color ' + hex + '. '
        + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
        + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. '
        + 'This flat color will serve as the RGB base that the A-mask composites over: no gradients, no texture, no shadow, no new objects.';
}

/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

/**
 * Minimum frame size in pixels below which softShare is meaningless.
 * For a 1×1 image softShare=1 (the only pixel sits in the mid-alpha band) does not mean a
 * soft edge — it just means the frame is too small for the metric.
 */
export const MIN_SOFT_PIXELS = 100;

/**
 * Share of the frame that must be fully cleared before a picture counts as a real cut-out.
 * A model that cannot emit alpha paints a plate instead, and the only transparent pixels such a
 * reply carries form a thin fringe along the silhouette — well under this share. A genuine
 * background removal clears a large part of the frame, so the threshold separates the two.
 */
export const MIN_CLEARED_SHARE = 0.03;

/**
 * Largest share of the frame allowed to sit in the soft alpha band before a cut-out counts as
 * sloppy. A real one leaves a one- or two-pixel anti-aliased ring (well under 1%); a matte the
 * model drew with a wide glow scores around 20%, and that band is the halo a transparent PNG shows.
 */
export const MAX_SOFT_SHARE = 0.05;

/** Longest side of a comparison sheet when the caller does not ask for a frame. */
export const DEFAULT_MAX_SIDE = 768;

/** Extensions that can carry a clean RGB source (no alpha, no fake plate). */
export const RGB_SOURCE_EXT = /\.(png|webp)$/i;

/** Alpha modes that run model passes (paint + matte). */
export const MODEL_MATES = new Set(['auto', 'mask']);


export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const PERSISTENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 406, 410, 411, 413, 415, 422, 451]);
/** Headers the client sets itself; a custom header must not replace them. */
export const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-client-request-id', 'openai-organization', 'openai-project']);
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Copy the extra body fields of one backend. Values keep their JSON type — a gateway flag such as
 * `useWalletBalance` has to arrive as `true`, not as the string `"true"`. What the request already
 * sets is decided by `withBackendBody`, which never overwrites a field the call itself produced.
 * @param {object|null|undefined} body
 * @returns {Record<string, unknown>}
 * @ai.hint pure
 */
export const RESERVED_BODY = new Set(['model', 'input', 'messages', 'instructions', 'stream', 'tools', 'tool_choice',
    'parallel_tool_calls', 'previous_response_id', 'store', 'background', 'include']);

/**
 * Capabilities of one image model id, merged over the defaults.
 * @param {string | null | undefined} model
 * @returns {{ customSizes: boolean, div16Padding: boolean, padToMinPixels: boolean, keepProSuffix: boolean, omitSizeOnReject: boolean, complexity: string|null, routeEditsThroughGeneration: boolean, resolutionTiers: boolean, paintsFakeTransparency: boolean, minPixels: number, maxPixels: number, maxEdge: number, maxRatio: number }}
 * @exports
 * @ai.hint pure
 */
export function imageModelProfile(model) {
    const name = String(model ?? '').trim();
    const rule = IMAGE_MODEL_PROFILES.find((p) => p.match.test(name));
    if (!rule) return { ...IMAGE_CAPABILITIES };
    const { match, ...caps } = rule;
    return { ...IMAGE_CAPABILITIES, ...caps };
}


/**
 * Prompt for the background paint pass. The background becomes the dominant color of the subject,
 * so the semi-transparent pixels an anti-aliased matte leaves behind carry the object color instead
 * of white or a checkerboard. That is what removes the halo around a cut-out logo or badge.
 */
/*export const BACKGROUND_PAINT_PROMPT = 'Fill the whole background of the attached image with the dominant color of the subject. '
    + 'Do not change the subject: keep every pixel of it identical, in the same position, with the same '
    + 'proportions and framing. '
    + 'Paint a single flat color only where the background is now — including any checkerboard, grid, or '
    + 'pattern that imitates transparency. No gradients, no texture, no shadow, no new objects.';*/

/** Raster matte formats ImageMagick can read. */
export const MASK_EXT = /\.(png|webp|jpe?g)$/i;


/**
 * A short guard for requests that carry a source picture: cut-out and restyle models tend to
 * decorate the answer with captions, frames or an invented scene when the prompt stays silent.
 * Nothing else belongs in the prompt: the frame travels in the `size`/`resolution`/`aspect_ratio`
 * fields, transparency is requested through `background`, and the two-part RGBA composition
 * (painted RGB base + A-mask) is assembled locally by image-alpha.js from its own technical
 * prompts sent to the clean source. Inlining those texts here asked the model to repaint the
 * background with the subject color and to draw a matte in the same reply as the artwork —
 * it obeyed both and stopped isolating the subject.
 */
export const SOURCE_GUARD = 'Do not add text, numbers, watermarks, or frames. Do not invent a new background or extra objects: keep the subject exactly as in the source unless the request changes it.';

/**
 * One extra line for the families whose gateway answers `background: transparent` with a drawn
 * plate: a single flat color is what the local matte can remove cleanly, while a checkerboard
 * or a gradient survives as a halo. This is not the two-pass RGBA recipe — the model returns one
 * picture, so only the RGB base is asked for here, and the matte stays a local step.
 */
export const FLAT_PLATE_NOTE = 'Background: one flat solid color, uniform across the whole area, with no checkerboard, grid, gradient, texture, or shadow.';

/** Frame presets POST /images/generations and /images/edits accept for the preset-only models. */
export const IMAGE_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024']);

/**
 * Shapes recraft vector models accept. A request may name any other shape (`2.39:1`, `a4`,
 * `cinemascope`); `nearestAspect` rounds it to the closest entry of this list, which is the only
 * one the gateway answers to.
 */
export const VECTOR_RATIOS = Object.freeze(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', 'auto']);

/** Frames of one shape per resolution tier, for the families that serve no ratio field. */
export const PORTRAIT_SIZES = {
    "512":  "384x512",
    "1k":   "768x1024",
    "1.5k": "1152x1536",
    "2k":   "1536x2048",
    "3k":   "2304x3072",
    "4k":   "3072x4096"
}

/** @see PORTRAIT_SIZES */
export const LANDSCAPE_SIZES = {
    "512":  "512x384",
    "1k":   "1024x768",
    "1.5k": "1536x1152",
    "2k":   "2048x1536",
    "3k":   "3072x2304",
    "4k":   "4096x3072"
}

/** @see PORTRAIT_SIZES */
export const SQUARE_SIZES = {
    "512":  "512x512",
    "1k":   "1024x1024",
    "1.5k": "1536x1536",
    "2k":   "2048x2048",
    "3k":   "3072x3072",
    "4k":   "4096x4096"
}

/**
 * Frame limits of one model, read from its profile. Kept as functions because the call sites ask
 * for a limit by model id; the numbers themselves live in `IMAGE_MODEL_PROFILES`.
 * @param {string|null|undefined} model
 * @returns {number}
 * @ai.hint pure
 */
export const MIN_IMAGE_PIXELS = (model = null) => imageModelProfile(model).minPixels;
export const MAX_IMAGE_PIXELS = (model = null) => imageModelProfile(model).maxPixels;
export const MAX_IMAGE_EDGE   = (model = null) => imageModelProfile(model).maxEdge;
export const MAX_IMAGE_RATIO  = (model = null) => imageModelProfile(model).maxRatio;

/** Aspect ratios accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', 'auto']);

/** Resolution tiers accepted by Riverflow (Sourceful). */
export const RIVERFLOW_RESOLUTIONS = Object.freeze(['512', '1K', '2K', '4K']);

/**
 * What one resolution tier stands for: the longest side it names and the pixel budget it implies.
 * A request that gives a shape but no pixel count (`2.39:1`, `wide`) gets its frame built from
 * these numbers, and no catalogue entry runs past the tier's own longest side.
 */
export const IMAGE_TIER_LIMITS = Object.freeze({
    '512': Object.freeze({ edge: 512, pixels: 512 * 512 }),
    '1k': Object.freeze({ edge: 1024, pixels: 1024 * 1024 }),
    '1.5k': Object.freeze({ edge: 1536, pixels: 1536 * 1536 }),
    '2k': Object.freeze({ edge: 2048, pixels: 2048 * 2048 }),
    '3k': Object.freeze({ edge: 3072, pixels: 3072 * 3072 }),
    '4k': Object.freeze({ edge: 4096, pixels: 4096 * 4096 }),
});

/**
 * Frames a family publishes for one tier. They stay first in the catalogue: a gateway that lists
 * `1024x1536` as its native 2K portrait answers it more faithfully than any computed frame.
 */
const NATIVE_TIER_SIZES = Object.freeze({
    '512': Object.freeze(['512x512']),
    '1k': Object.freeze(['1024x768', '768x1024', '1024x1024']),
    '1.5k': Object.freeze(['1536x1536', '1024x1536', '1536x1024', '1536x1152', '1152x1536']),
    '2k': Object.freeze(['1024x1536', '1536x1024', '2048x1536', '1536x2048', '2048x2048']),
    '3k': Object.freeze(['3072x3072', '3072x2048', '2048x3072', '3072x2304', '2304x3072']),
    '4k': Object.freeze(['4096x3072', '3072x4096', '4096x4096']),
});

/**
 * Image-generation purpose: tells the tool which model to prefer for a given task.
 * The key is the purpose name; the value is an ordered list of model IDs — first match wins.
 *
 * - `decompose`   — layouts, templates, screen mockups; needs clean geometry and consistent style.
 * - `isolate`     — cut out a subject from its background (alpha or matte).
 * - `upscale`     — enlarge an existing image while preserving quality (not yet actively used).
 * - `generate`    — standard text-to-image or restyle; the general-purpose default.
 *
 * A purpose absent from the map is ignored: the call keeps its configured `imageModel`.
 * When a listed model is null or empty, it is skipped during resolution.
 */
export const PURPOSE_MODEL_MAP = Object.freeze({
    decompose: Object.freeze([
        'sourceful/riverflow-v2.6-pro',   // fallback if gpt-image-2.6-* refuses
        'openai/gpt-image-2.6-sunburst',  // default
        'bytedance-seed/seedream-5-5',    // if available
    ]),
    isolate: Object.freeze([
        'bytedance-seed/seedream-5-5',    // best at subject isolation
        'openai/gpt-image-2.6-sunburst',  // min 655360 px or seedream unavailable
        'sourceful/riverflow-v2.6-pro',   // only if explicitly enabled
    ]),
    upscale: Object.freeze([
        'openai/gpt-image-2.6-sunburst',  // when target is 655360+ px or 1K+
        'bytedance-seed/seedream-5-5',    // around 512×512 or < 655360
        'sourceful/riverflow-v2.6-pro',   // fallback when opaque + seedream unavailable
    ]),
    generate: Object.freeze([
        'sourceful/riverflow-v2.6-pro',   // mainly for opaque output
        'openai/gpt-image-2.6-sunburst',  // from 1K resolution
        'bytedance-seed/seedream-5-5',    // if available
    ]),
});

/**
 * Resolve the best model for a given purpose from the config's available providers.
 * Walks the ordered list; returns the first model that matches a provider in `config.backends`
 * (or `config.imagesBackends`), or null when none match. A bare purpose key that is not in the
 * map returns null so the caller falls through to the default `imageModel`.
 * @param {object} config
 * @param {string} purpose — one of the keys in PURPOSE_MODEL_MAP, or null/empty to skip
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function resolvePurposeModel(config, purpose) {
    if (!purpose) return null;
    const models = PURPOSE_MODEL_MAP[String(purpose).trim().toLowerCase()];
    if (!models) return null;

    // Collect all known provider base URLs from every backend pool.
    const pools = [
        ...(config.backends ?? []),
        ...(config.imagesBackends ?? []),
    ];
    const activeUrls = new Set(pools.filter((p) => p.baseURL).map((p) => p.baseURL.replace(/\/+$/, '')));

    for (const modelId of models) {
        if (!modelId) continue;
        // A model is "available" if its provider URL is in the active pools, or if it is an
        // OpenAI-native model (openai/) that goes through the primary URL.
        const isOpenAi = /^openai\//i.test(modelId);
        const primary = String(config.baseURL ?? '').replace(/\/+$/, '');
        const providerUrl = isOpenAi ? primary : null;

        if (isOpenAi) {
            if (activeUrls.has(primary) || activeUrls.size === 0) return modelId;
        } else if (providerUrl && activeUrls.has(providerUrl)) {
            return modelId;
        } else if (activeUrls.size === 0) {
            // No explicit backends — accept non-OpenAI models (direct proxyapi.ru, etc.)
            return modelId;
        }
    }
    return null;
}

/**
 * One frame per standard shape inside one tier, built the same way a request is answered: the
 * shape as a fraction with terms within `RATIO_MAX_TERM`, scaled by a whole number of 16-pixel
 * increments up to the tier's pixel budget. This is what lets a tier-based model take `21:9` or
 * `5:4` at 2K instead of collapsing the request to the three frames the vendor happened to list.
 * @param {string} key a key of `IMAGE_TIER_LIMITS`
 * @returns {string[]}
 * @ai.hint pure
 */
function tierCatalogue(key) {
    const limits = IMAGE_TIER_LIMITS[key];
    const frames = [...(NATIVE_TIER_SIZES[key] ?? [])];
    for (const ratio of STANDARD_RATIOS) {
        const frame = aspectFrame(ratio, { step: 16, pixels: limits.pixels, maxEdge: limits.edge });
        if (frame) {
            const token = `${frame.width}x${frame.height}`;
            if (!frames.includes(token)) frames.push(token);
        }
    }
    return Object.freeze(frames);
}

/**
 * Frames one tier offers, native presets first and then one per shape of `STANDARD_RATIOS`.
 * A tier-based model picks from this list; a model with free frames builds its own with
 * `aspectFrame` and only consults the catalogue when a gateway refuses the frame.
 */
export const IMAGE_SIZES_BY_RESOLUTION = Object.freeze(Object.fromEntries(
    Object.keys(IMAGE_TIER_LIMITS).map((key) => [key, tierCatalogue(key)]),
));

/**
 * @file src/openai/model-profiles.js
 * @module openai/model-profiles
 * @purpose Model metadata registry: context window, max output, supported reasoning levels, and the effort ceiling.
 * @usedBy core/config, agent/loop, agent/pace, roles/*
 * @exports EFFORT_ORDER, CONTEXT_LEVELS, DEFAULT_PROFILE, MODEL_PROFILES, profileFor, effortRank, capEffort, snapEffort, modeFor, contextBytes
 * @ai.tags models, profiles, effort, context
 * @ai.hint pure
 * @changed 2026-10-26 Registry for 0.2.0: every model declares its window, output cap, effort ladder and ceiling.
 * @changed 2026-11-04 Gateway reasoning modes (`modes`, modeFor).
 */

/**
 * Reasoning levels from the cheapest to the dearest. The index is the rank used in comparisons.
 * Includes 'none', which the pace ladder leaves out, so a ceiling may name any level.
 */
export const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Word levels of a context budget, in bytes. `auto` is absent on purpose: it resolves from the model window.
 */
export const CONTEXT_LEVELS = Object.freeze({
    small: 16 * 1024,
    normal: 96 * 1024,
    large: 512 * 1024,
    max: 8 * 1024 * 1024,
});


/** Vendor prefixes, so a qualified id resolves to the same profile as the bare one. */
export const QUALIFIED_PREFIXES = Object.freeze(['openai/', 'anthropic/', 'moonshotai/']);

export const KiB = 1024;
export const MiB = KiB * KiB;

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
/**
 * Extra reasoning modes a gateway may serve next to `effort`. `off` sends no `reasoning.mode` field
 * at all, so a host that has never heard of modes sees the same request as before. Unlike effort,
 * modes are not ordered: there is no ceiling or ladder, only whether a model lists the mode.
 */
export const REASONING_MODES = ['off', 'pro'];
export const APPROVAL_LEVELS = ['ask', 'read', 'write', 'all'];
export const IMAGE_DETAILS = ['auto', 'low', 'high', 'original'];
/** Word levels of a context budget, plus `auto`, which follows the window of the model in use. */
export const CONTEXT_LEVEL_NAMES = Object.freeze([...Object.keys(CONTEXT_LEVELS), 'auto']);
