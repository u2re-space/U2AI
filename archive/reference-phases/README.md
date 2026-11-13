# Reference Phases — archived

> **The phases live in their own package now.** They were ported to `@u2ai/decomposer`
> (`submodules/u2ai-decomposer/`), where they are the six stages of the pipeline:
> `extend` → `decompose` → `rectify` → `reconstruct` → `overlap` → `resolve`.
> The port is covered by tests and is green, so this folder is now the archive of what the phases
> meant — the reference for the behaviour — and not the code that runs.
> The monolith reaches the new package through `ai decompose`, which delegates to `ai-decompose`
> (`src/commands/decompose.js`).

Three phases were removed from the `decompose` stage because they failed to work reliably
and consumed API budget without returning usable sub-references:

- **Phase 0.5 `extender`** — outpainting the frame of a cropped reference via `images.edit`.
  Diffusion never returns source bytes untouched, so the seam check was the only honest gate.
  It worked on some mocks and rejected on others; the code itself is sound, but the
  `gpt-image` editor has no stable contract for "grow this frame".

- **Phase 1 `rectifier`** — the AI role names corners, the harness runs `correct_perspective`.
  The role frequently returned "keep" for skewed photos (refusing to name corners) and the
  harness would then keep the original skewed reference. Collage splitting worked, but the
  overall ROI was negative.

- **Phase 1.5 `restorer`** — names defects in cropped sub-references and sends only the defect
  box to the editor. The harness stitches the answer back with `rasterPatch`, which had a
  latent off-by-y bug that killed every repair below row 0. The code was fixed, but the
  phase never proved useful end-to-end.

## What is here

```
archive/reference-phases/
├── extend.js            — harness for the extender phase
├── rectify.js           — harness for the rectifier phase
├── restore.js           — harness for the restorer phase
├── restore-plan.js      — repair-plan helpers (editor prompt, fragment plan)
├── extender.js          — extender role instructions
├── rectifier.js         — rectifier role instructions
├── restorer.js          — restorer role instructions
├── reference-phases.test.js  — end-to-end harness tests (seam verdict, band fill, collage split)
├── schemas.js           — copied schemas (EXTEND, RECTIFY, RESTORE, RESTORE_VERIFY)
└── README.md            — this file
```

## How to revive

The phases do not need to be revived inside the monolith: they run in `@u2ai/decomposer`
(`submodules/u2ai-decomposer/src/stages/`), and `ai decompose` delegates to that CLI. To bring them
back into the monolith itself, the old way is still in the history:

1. Copy the four schemas back into `src/agent/schemas.js` (after `SUB_REFERENCE_KINDS`, before
   `IMAGE_PROCESSOR_SCHEMA`).
2. Restore the role files under `src/roles/` and add the imports + entries in
   `src/roles/index.js`.
3. Restore the three role entries and `agent.extend` / `agent.rectify` / `agent.restore` keys in
   `src/core/config-defaults.js`.
4. Restore the validator lines in `src/core/config.js` (the ones that check `off | auto | always`).
5. Restore the flag definitions in `src/cli.js` and the mapping in `src/commands/flags.js`.
6. Restore the help blocks in `src/cli-help.js` and the event renderers in
   `src/ui/renderer-events.js`.
7. Restore the three phase blocks in `src/agent/team.js` (the code is preserved in git history;
   `git show HEAD~6:src/agent/team.js` shows the state before the archive).
8. Re-enable `correct_perspective` in the decomposer's tool set (step 25 in the original plan
   removed it to give it to rectifier).

The port to the new package kept the behaviour and dropped the switches: the stages of
`@u2ai/decomposer` always run in the same order, and each one is switched off as a whole through
`stages.<id>.enabled`. The `off | auto | always` modes of steps 4 and 5 above are therefore not
restored.

## What changed in the live pipeline

- The `decomposer` role got `correct_perspective` back, so it can still level skewed photos and
  cut collages. It is told to project once per reference — never chain projections.
- `SUB_REFERENCE_KINDS` still contains `repaired` (backwards-compatible with old `decomposition.json`).
- `rasterPatch()` and `rasterCrop()` remain in `src/shared/image-raster.js` (tested, used by
  the archived restorer).
- `correct_perspective` tool, `perspectiveRectify`, `refineQuadByEdges`, `measureResidualSkew`
  remain in the deterministic tool layer (used by the decomposer).
