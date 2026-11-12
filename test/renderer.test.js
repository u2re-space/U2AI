import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createRenderer } from '../src/ui/renderer.js';
import { HELP, paintHelp } from '../src/cli-help.js';

/**
 * A Writable stream that remembers what was written.
 * styleText() requires a real Stream instance; hasColors()=true makes it paint ANSI codes.
 */
function capture() {
    const chunks = [];
    const stream = new Writable({
        decodeStrings: false,
        write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
    });
    stream.isTTY = true;
    stream.columns = 120;
    stream.hasColors = () => true;
    stream.text = () => chunks.join('');
    return stream;
}

/**
 * Run one or more events through a tty renderer with colors forced on, then hand back the stderr.
 * @param {object[]} events
 * @returns {string} everything the renderer wrote to stderr
 * @ai.hint io
 */
function render(events) {
    const saved = { no: process.env.NO_COLOR, force: process.env.FORCE_COLOR };
    process.env.NO_COLOR = '';
    process.env.FORCE_COLOR = '1';
    const stderr = capture();
    const renderer = createRenderer({ mode: 'tty', stdout: capture(), stderr, stdin: capture() });
    try {
        for (const event of events) renderer.handle(event);
    } finally {
        if (saved.no === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved.no;
        if (saved.force === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = saved.force;
        renderer.close();
    }
    return stderr.text();
}

// styleText resets foreground with \u001b[39m, but nested colors can emit the next code instead.
// Check the opening sequence only — enough to prove the right color was applied.
const hasFg = (text, code, word) => {
    const needle = `\u001b[${code}m${word}`;
    assert.ok(text.includes(needle), `expected ANSI fg ${code} (${word}) in: ${JSON.stringify(text)}`);
};

test('effort is printed in the color of its rung on the ladder', () => {
    hasFg(render([{ type: 'role.start', role: 'coder', model: 'gpt-6-luna', effort: 'low' }]), 34, 'low');
    hasFg(render([{ type: 'role.start', role: 'coder', model: 'gpt-6-luna', effort: 'medium' }]), 32, 'medium');
    hasFg(render([{ type: 'role.start', role: 'worker', model: 'gpt-6.1-terra', effort: 'xhigh' }]), 93, 'xhigh');
    hasFg(render([{ type: 'role.start', role: 'planner', model: 'gpt-6.1-terra', effort: 'max' }]), 91, 'max');
    hasFg(render([{ type: 'role.start', role: 'styler', model: 'gpt-6-luna', effort: 'none' }]), 37, 'none');
});

test('reasoning pro is printed red next to the effort', () => {
    const out = render([{ type: 'role.start', role: 'measurer', model: 'gpt-6.1-terra', effort: 'high', reasoningMode: 'pro' }]);
    hasFg(out, 33, 'high');
    hasFg(out, 31, 'pro');
    const other = render([{ type: 'role.start', role: 'measurer', model: 'gpt-6.1-terra', effort: 'high', reasoningMode: 'off' }]);
    assert.equal(other.includes('pro'), false, 'an off mode is not announced');
});

test('plan complexity is printed by cost, from cyan to red-orange', () => {
    const base = { type: 'plan.ready', summary: 's', steps: [], needsReview: false };
    hasFg(render([{ ...base, complexity: 'trivial' }]), 36, 'trivial');
    hasFg(render([{ ...base, complexity: 'normal' }]), 33, 'normal');
    hasFg(render([{ ...base, complexity: 'complex' }]), 91, 'complex');
});

test('the advanced decomposer stage is red and names the way back to standard', () => {
    const out = render([{ type: 'stage.start', stage: 'decompose', role: 'decomposer', model: 'seedream-5-5', effort: 'max', decomposerMode: 'advanced', reasoningMode: 'pro' }]);
    hasFg(out, 31, 'advanced');
    hasFg(out, 91, 'max');
    assert.match(out, /--decomposer-mode standard/, 'the warning offers the cheaper mode');
    const plain = render([{ type: 'stage.start', stage: 'decompose', role: 'decomposer', model: 'seedream-5-5' }]);
    assert.equal(plain.includes('advanced'), false, 'standard mode is not announced as advanced');
});

test('help paints its red words on a tty and never shows markup in a pipe', () => {
    assert.match(HELP, /<red>advanced<\/red>/, 'the template carries the markers');
    const painted = paintHelp(HELP, true);
    assert.match(painted, /\u001b\[31madvanced\u001b\[0m/);
    assert.equal(painted.includes('<red>'), false);
    const stripped = paintHelp(HELP, false);
    assert.equal(stripped.includes('<red>'), false, 'a pipe must not see the markup');
    assert.match(stripped, /--decomposer-mode standard\|advanced/);
});
