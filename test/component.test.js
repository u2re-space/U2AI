import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COMPONENT_CONTRACT_PATH, RESERVED_TAGS, componentTagName, componentClassName, componentPackageName,
    normalizeComponentContract, parseComponentContract, renderComponentContract, customElementsManifest,
    renderComponentReadme, draftComponentContract, contractBriefLines,
} from '../src/generate/component.js';

test('componentTagName makes a valid custom element name', () => {
    assert.equal(componentTagName('calendar'), 'ai-calendar', 'a bare name gains the prefix');
    assert.equal(componentTagName('ui-calendar'), 'ui-calendar', 'a hyphenated name is kept');
    assert.equal(componentTagName('My Date Picker'), 'my-date-picker', 'spaces become hyphens');
    assert.equal(componentTagName('@acme/ui-cal'), 'ui-cal', 'a scope is dropped from the tag');
    assert.equal(componentTagName(''), 'ai-component', 'an empty name still yields a tag');
    for (const reserved of ['slot', 'template', 'script']) {
        assert.ok(RESERVED_TAGS.includes(reserved));
        assert.notEqual(componentTagName(reserved), reserved, `${reserved} must not be claimed`);
    }
});

test('componentClassName turns a tag into a class', () => {
    assert.equal(componentClassName('ui-calendar'), 'UiCalendar');
    assert.equal(componentClassName('ai-date-picker'), 'AiDatePicker');
    assert.equal(componentClassName(''), 'AiComponent');
});

test('componentPackageName keeps a local scope so npm never confuses it with a public package', () => {
    assert.equal(componentPackageName({ tag: 'ui-calendar' }), '@ai/ui-calendar');
    assert.equal(componentPackageName({ name: '@Acme/UI_Cal' }), '@acme/ui-cal', 'an explicit scope is kept');
    assert.equal(componentPackageName({ name: 'calendar', tag: 'ui-calendar' }), '@ai/calendar');
});

test('normalizeComponentContract accepts the short and the object form', () => {
    const contract = normalizeComponentContract({
        tag: 'ui-calendar',
        summary: 'Three-mode calendar',
        attrs: ['mode', { name: 'busy', type: 'boolean', reflect: true }, { name: 'range', values: 'day|week|month' }],
        events: [{ name: 'date-select', detail: '{ date: string }', bubbles: true }],
        parts: 'header',
        cssVars: [{ name: '--ui-calendar-accent', default: '#3b82f6' }],
        states: [{ state: 'busy', description: 'loading' }],
    });
    assert.equal(contract.tag, 'ui-calendar');
    assert.equal(contract.className, 'UiCalendar');
    assert.equal(contract.name, '@ai/ui-calendar');
    assert.equal(contract.version, '0.1.0', 'a missing version gets a default');
    assert.equal(contract.attrs.length, 3);
    assert.equal(contract.attrs[0].name, 'mode', 'a bare string becomes a named entry');
    assert.equal(contract.attrs[1].reflect, true);
    assert.deepEqual(contract.attrs[2].values, ['day', 'week', 'month'], 'a pipe list becomes an array');
    assert.equal(contract.events[0].name, 'date-select');
    assert.deepEqual(contract.parts.map((p) => p.name), ['header']);
    assert.deepEqual(contract.states.map((s) => s.name), ['busy'], 'a state may be spelled with the state key');
    assert.equal(contract.cssVars[0].default, '#3b82f6');
});

test('normalizeComponentContract survives junk from a model answer', () => {
    const contract = normalizeComponentContract({ tag: 'ui-x', attrs: [null, 7, { nope: 1 }], parts: {}, deps: ['lit', 5, ''] });
    assert.deepEqual(contract.attrs.map((a) => a.name).filter(Boolean), ['7'], 'a number survives as a name, junk is dropped');
    assert.deepEqual(contract.deps, ['lit'], 'only string dependencies are kept');
});

test('a typed framework defaults to TypeScript sources', () => {
    assert.equal(normalizeComponentContract({ tag: 'a-b', framework: 'lit' }).scriptLanguage, 'typescript');
    assert.equal(normalizeComponentContract({ tag: 'a-b', framework: 'fest' }).scriptLanguage, 'typescript');
    assert.equal(normalizeComponentContract({ tag: 'a-b' }).scriptLanguage, 'javascript');
});

test('the contract round-trips through its file form', () => {
    const contract = normalizeComponentContract({ tag: 'ui-cal', attrs: ['mode'] });
    const text = renderComponentContract(contract);
    assert.match(text, /"tag": "ui-cal"/);
    assert.ok(text.endsWith('\n'));
    const back = parseComponentContract(text);
    assert.equal(back.tag, 'ui-cal');
    assert.deepEqual(back.attrs.map((a) => a.name), ['mode']);
    assert.throws(() => parseComponentContract('{oops'), /некорректный JSON/);
    assert.throws(() => parseComponentContract('[]'), /ожидался объект/);
});

test('the custom-elements manifest names the tag and the API for editors', () => {
    const manifest = customElementsManifest({
        tag: 'ui-calendar', entry: 'index.js',
        attrs: [{ name: 'mode', type: 'string', default: 'month', reflect: true }],
        props: [{ name: 'events', type: 'Event[]' }],
        events: [{ name: 'date-select', detail: '{ date: string }' }],
        slots: [{ name: 'toolbar' }],
        parts: [{ name: 'header' }],
        cssVars: [{ name: '--ui-calendar-accent', default: 'blue' }],
    });
    assert.equal(manifest.schemaVersion, '1.0.0');
    const module = manifest.modules[0];
    assert.equal(module.path, 'index.js');
    const declaration = module.declarations[0];
    assert.equal(declaration.tagName, 'ui-calendar');
    assert.equal(declaration.customElement, true);
    assert.equal(declaration.attributes[0].name, 'mode');
    assert.equal(declaration.attributes[0].reflect, true);
    assert.deepEqual(declaration.members[0].type, { text: 'Event[]' });
    assert.deepEqual(declaration.events[0].type, { text: '{ date: string }' });
    assert.equal(declaration.cssParts[0].name, 'header');
    assert.equal(declaration.cssProperties[0].name, '--ui-calendar-accent');
    assert.equal(module.exports[0].name, 'ui-calendar');
});

test('the README documents the styling surface a host needs', () => {
    const readme = renderComponentReadme({
        tag: 'ui-calendar',
        summary: 'Three-mode calendar with schedules.',
        attrs: [{ name: 'mode', type: 'string', values: ['day', 'week', 'month'] }],
        parts: [{ name: 'header', description: 'the bar above the grid' }],
        cssVars: [{ name: '--ui-calendar-accent', default: '#3b82f6' }],
        states: [{ name: 'busy' }],
    });
    assert.match(readme, /^# `ui-calendar`/m);
    assert.match(readme, /ai install ui-calendar/);
    assert.match(readme, /"file:\.\/vendor\/components\/ui-calendar"/);
    assert.match(readme, /<ui-calendar><\/ui-calendar>/);
    assert.match(readme, /\| `mode` /);
    assert.match(readme, /::part\(header\)/);
    assert.match(readme, /--ui-calendar-accent/);
    assert.match(readme, /state\(busy\)/);
    assert.match(readme, /_None\._/, 'an empty section says so instead of vanishing');
});

test('draftComponentContract fixes the names before the first step', () => {
    const draft = draftComponentContract({ name: 'calendar', prompt: 'Three modes: day, week and month with plans', framework: 'lit' });
    assert.equal(draft.tag, 'ai-calendar');
    assert.equal(draft.name, '@ai/ai-calendar');
    assert.equal(draft.framework, 'lit');
    assert.equal(draft.scriptLanguage, 'typescript', 'a typed framework is drafted typed');
    assert.match(draft.summary, /Three modes/);
    const explicit = draftComponentContract({ tag: 'ui-calendar@2.0.0' });
    assert.equal(explicit.tag, 'ui-calendar');
});

test('contractBriefLines tells the model what to implement', () => {
    const lines = contractBriefLines({ tag: 'ui-calendar', attrs: ['mode'], parts: ['header'], states: ['busy'] });
    assert.ok(lines.some((line) => line.includes('tag "ui-calendar"')));
    assert.ok(lines.some((line) => line.includes('Attributes to implement: mode')));
    assert.ok(lines.some((line) => line.includes('CSS parts to expose: header')));
    assert.ok(lines.some((line) => line.includes('Custom states through ElementInternals: busy')));
    assert.ok(lines.some((line) => line.includes('.ai/component.json is the source of truth')));
    assert.equal(COMPONENT_CONTRACT_PATH, '.ai/component.json');
});
