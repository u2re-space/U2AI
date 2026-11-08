import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { openRegistry, REGISTRY_IGNORE } from '../src/core/registry.js';
import { installCommand, saveDependency } from '../src/commands/install.js';
import { splitSpec } from '../src/commands/component.js';

async function tempDir(prefix) {
    return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(file) {
    return stat(file).then(() => true, () => false);
}

/**
 * A generated component project: contract, package.json, sources, and noise
 * that must never reach the registry.
 */
async function makeProject(tag, { typed = false, withContract = true } = {}) {
    const root = await tempDir('ai-component-');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.ai'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: `@ai/${tag}`, private: true, type: 'module' }, null, 2)}\n`);
    await writeFile(path.join(root, 'index.js'), `customElements.define('${tag}', class extends HTMLElement {});\n`);
    await writeFile(path.join(root, 'src', `${tag}.js`), 'export const x = 1;\n');
    await writeFile(path.join(root, 'dist', `${tag}.js`), 'export default 1;\n');
    await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'nope\n');
    await writeFile(path.join(root, 'package-lock.json'), '{}\n');
    if (withContract) {
        await writeFile(path.join(root, '.ai', 'component.json'), JSON.stringify({
            tag, version: '0.1.0', summary: 'Трёхрежимный календарь на день, неделю и месяц',
            framework: typed ? 'lit' : 'vanilla',
            scriptLanguage: typed ? 'typescript' : 'javascript',
            attrs: ['mode'], parts: ['header'], states: ['busy'],
        }));
    }
    return root;
}

function registryFor(dir) {
    return openRegistry({ file: path.join(dir, 'components.db'), dir: path.join(dir, 'components') });
}

test('publish stores the sources and drops the noise', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-calendar');
    const registry = registryFor(home);
    try {
        const result = await registry.publish({ sourceRoot: project, tags: 'календарь,расписание' });
        assert.equal(result.tag, 'ui-calendar');
        assert.equal(result.version, '0.1.0');
        assert.equal(result.replaced, false);
        assert.ok(result.sha256.length >= 8);
        assert.ok(result.files.includes('index.js'));
        assert.ok(result.files.includes('.ai/component.json'), 'the contract travels with the sources');
        assert.ok(result.files.includes('dist/ui-calendar.js'), 'a build output is kept for a typed package');
        assert.ok(!result.files.some((file) => file.startsWith('node_modules')), 'node_modules never enters the registry');
        assert.ok(!result.files.includes('package-lock.json'));
        assert.ok(REGISTRY_IGNORE.includes('node_modules'));
        assert.ok(await exists(path.join(home, 'components', 'ui-calendar', '0.1.0', 'index.js')));
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
    }
});

test('publish refuses a directory that is not a component', async () => {
    const home = await tempDir('ai-registry-');
    const bare = await tempDir('ai-bare-');
    const registry = registryFor(home);
    try {
        await assert.rejects(() => registry.publish({ sourceRoot: bare }), /не найден/);
        const project = await makeProject('ai-x', { withContract: false });
        await assert.rejects(() => registry.publish({ sourceRoot: project }), /ai gen component/);
        await rm(project, { recursive: true, force: true });
        assert.equal(registry.list().length, 0);
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(bare, { recursive: true, force: true });
    }
});

test('a missing package.json is refused, because nothing could import it', async () => {
    const home = await tempDir('ai-registry-');
    const root = await tempDir('ai-nopkg-');
    await mkdir(path.join(root, '.ai'), { recursive: true });
    await writeFile(path.join(root, '.ai', 'component.json'), JSON.stringify({ tag: 'ui-lonely' }));
    const registry = registryFor(home);
    try {
        await assert.rejects(() => registry.publish({ sourceRoot: root }), /package\.json/);
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test('publishing the same version twice replaces it instead of duplicating', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-cal');
    const registry = registryFor(home);
    try {
        const first = await registry.publish({ sourceRoot: project });
        await writeFile(path.join(project, 'index.js'), 'customElements.define("ui-cal", class extends HTMLElement {});\n// v2\n');
        const second = await registry.publish({ sourceRoot: project });
        assert.equal(second.replaced, true);
        assert.notEqual(first.sha256, second.sha256);
        assert.equal(registry.list().length, 1);
        assert.equal(registry.get('ui-cal').sha256, second.sha256);
        // A new version lives beside the old one.
        const third = await registry.publish({ sourceRoot: project, contract: { tag: 'ui-cal', version: '0.2.0' } });
        assert.equal(third.version, '0.2.0');
        assert.deepEqual(registry.versions('ui-cal'), ['0.2.0', '0.1.0']);
        assert.equal(registry.get('ui-cal').version, '0.2.0', 'the newest publish wins');
        assert.equal(registry.get('ui-cal', '0.1.0').version, '0.1.0');
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
    }
});

test('search finds a component by tag, by API name, and by an inflected Russian word', async () => {
    const home = await tempDir('ai-registry-');
    const calendar = await makeProject('ui-calendar');
    const picker = await makeProject('ui-date-picker', { typed: true });
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: calendar });
        await registry.publish({ sourceRoot: picker, tags: 'форма,инпут' });
        assert.ok(registry.search('calendar').some((item) => item.tag === 'ui-calendar'));
        assert.ok(registry.search('календарь').some((item) => item.tag === 'ui-calendar'), 'summary words match');
        assert.ok(registry.search('календаря').some((item) => item.tag === 'ui-calendar'), 'a stem still matches');
        assert.ok(registry.search('picker').some((item) => item.tag === 'ui-date-picker'));
        assert.ok(registry.search('форма').some((item) => item.tag === 'ui-date-picker'), 'tags match');
        assert.ok(registry.search('mode').some((item) => item.tag === 'ui-calendar'), 'an attribute name matches');
        assert.ok(registry.search('busy').some((item) => item.tag === 'ui-calendar'), 'a state name matches');
        assert.equal(registry.search('nothing-like-this').length, 0);
        assert.equal(registry.list({ framework: 'lit' }).length, 1, 'the framework narrows the list');
        assert.equal(registry.search('', { limit: 1 }).length, 1, 'an empty query lists');
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(calendar, { recursive: true, force: true });
        await rm(picker, { recursive: true, force: true });
    }
});

test('remove forgets the index and the sources, and can keep the sources', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-gone');
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: project });
        await registry.publish({ sourceRoot: project, contract: { tag: 'ui-gone', version: '0.2.0' } });
        const one = registry.remove('ui-gone', { version: '0.1.0' });
        assert.deepEqual(one.removed, ['ui-gone@0.1.0']);
        assert.equal(registry.get('ui-gone').version, '0.2.0');
        assert.ok(await exists(path.join(home, 'components', 'ui-gone', '0.2.0', 'index.js')));
        const all = registry.remove('ui-gone');
        assert.deepEqual(all.removed, ['ui-gone@0.2.0']);
        assert.equal(registry.get('ui-gone'), null);
        assert.ok(!(await exists(path.join(home, 'components', 'ui-gone'))), 'the last version takes the directory with it');
        assert.deepEqual(registry.remove('ui-gone'), { removed: [], kept: '' });
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
    }
}

);

test('a kept directory still leaves the component unfindable, and installs are counted', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-counted');
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: project });
        registry.recordInstall('ui-counted', '0.1.0');
        registry.recordInstall('UI-COUNTED', '0.1.0');
        assert.equal(registry.get('ui-counted').installs, 2, 'the tag is matched case-insensitively');
        const kept = registry.remove('ui-counted', { keepFiles: true });
        assert.ok(await exists(path.join(kept.kept, 'index.js')), 'keep-files leaves the sources');
    } finally {
        registry.close();
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
    }
});

test('splitSpec reads a tag and an optional version', () => {
    assert.deepEqual(splitSpec('ui-calendar'), { tag: 'ui-calendar', version: null });
    assert.deepEqual(splitSpec('UI-Calendar@1.2.3'), { tag: 'ui-calendar', version: '1.2.3' });
    assert.deepEqual(splitSpec(''), { tag: '', version: null });
});

test('saveDependency registers one package and never leaves it in both sections', () => {
    const manifest = { name: 'host', dependencies: { lit: '^3' }, devDependencies: { vite: '*' } };
    saveDependency({ manifest, name: '@ai/ui-calendar', specifier: 'file:./vendor/components/ui-calendar' });
    assert.equal(manifest.dependencies['@ai/ui-calendar'], 'file:./vendor/components/ui-calendar');
    assert.equal(manifest.dependencies.lit, '^3', 'an existing dependency is untouched');
    saveDependency({ manifest, name: '@ai/ui-calendar', specifier: 'file:./vendor/components/ui-calendar', dev: true });
    assert.equal(manifest.devDependencies['@ai/ui-calendar'], 'file:./vendor/components/ui-calendar');
    assert.equal('@ai/ui-calendar' in manifest.dependencies, false, 'a package cannot sit in both sections');
    saveDependency({ manifest, name: 'vite', specifier: 'file:./vendor/components/vite', dev: true });
    assert.equal(manifest.devDependencies.vite, 'file:./vendor/components/vite', 'an existing key is replaced in place');
});

/** Minimal renderer for a command test. */
function fakeRenderer() {
    const lines = [];
    return {
        lines,
        write(text) { lines.push(String(text).trimEnd()); },
        line(kind, text) { lines.push(`${kind}: ${String(text).trimEnd()}`); },
        json(payload) { lines.push(`json: ${payload.type}`); },
        text() { return lines.join('\n'); },
    };
}

test('ai install copies a registry component into the project and registers it', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-calendar', { typed: true });
    const host = await tempDir('ai-host-');
    await writeFile(path.join(host, 'package.json'), `${JSON.stringify({ name: 'host', private: true, type: 'module', scripts: { build: 'vite build' } }, null, 2)}\n`);
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: project });
        registry.close();
        const renderer = fakeRenderer();
        const code = await installCommand({
            cwd: host,
            renderer,
            positionals: ['ui-calendar'],
            values: { save: true },
            config: { components: { enabled: true, dir: path.join(home, 'components'), dbFile: path.join(home, 'components.db'), vendorDir: 'vendor/components' } },
        });
        assert.equal(code, 0);
        const manifest = JSON.parse(await readFile(path.join(host, 'package.json'), 'utf8'));
        assert.equal(manifest.dependencies['@ai/ai-calendar'], undefined);
        assert.equal(manifest.dependencies['@ai/ui-calendar'], 'file:./vendor/components/ui-calendar');
        assert.equal(manifest.scripts.build, 'vite build', 'scripts are kept');
        assert.ok(await exists(path.join(host, 'vendor', 'components', 'ui-calendar', 'index.js')));
        assert.ok(await exists(path.join(host, 'vendor', 'components', 'ui-calendar', '.ai', 'component.json')));
        assert.ok(!(await exists(path.join(host, 'vendor', 'components', 'ui-calendar', 'node_modules'))));
        assert.match(renderer.text(), /import '@ai\/ui-calendar'/, 'the printout shows the import line');
        // The install is what the registry counts for later ranking.
        const reopened = registryFor(home);
        try { assert.equal(reopened.get('ui-calendar').installs, 1); } finally { reopened.close(); }
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
        await rm(host, { recursive: true, force: true });
    }
});

test('ai install warns when a typed component has no build output and honours --no-save', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-plain', { typed: true });
    await rm(path.join(project, 'dist'), { recursive: true, force: true });
    const host = await tempDir('ai-host-');
    await writeFile(path.join(host, 'package.json'), `${JSON.stringify({ name: 'host', private: true, type: 'module' }, null, 2)}\n`);
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: project });
        registry.close();
        const renderer = fakeRenderer();
        const before = await readFile(path.join(host, 'package.json'), 'utf8');
        const code = await installCommand({
            cwd: host,
            renderer,
            positionals: ['ui-plain'],
            values: { save: false },
            config: { components: { enabled: true, dir: path.join(home, 'components'), dbFile: path.join(home, 'components.db'), vendorDir: 'vendor/components' } },
        });
        assert.equal(code, 0);
        assert.match(renderer.text(), /соберите компонент/, 'a missing dist is called out');
        assert.equal(await readFile(path.join(host, 'package.json'), 'utf8'), before, '--no-save leaves package.json alone');
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
        await rm(host, { recursive: true, force: true });
    }
});

test('ai install reports an unknown tag and refuses to overwrite without --force', async () => {
    const home = await tempDir('ai-registry-');
    const project = await makeProject('ui-twice');
    const host = await tempDir('ai-host-');
    await writeFile(path.join(host, 'package.json'), `${JSON.stringify({ name: 'host', private: true, type: 'module' }, null, 2)}\n`);
    const registry = registryFor(home);
    try {
        await registry.publish({ sourceRoot: project });
        registry.close();
        const base = {
            cwd: host,
            config: { components: { enabled: true, dir: path.join(home, 'components'), dbFile: path.join(home, 'components.db'), vendorDir: 'vendor/components' } },
        };
        const missing = fakeRenderer();
        assert.equal(await installCommand({ ...base, renderer: missing, positionals: ['ui-absent'], values: { save: true } }), 1);
        assert.match(missing.text(), /В реестре нет компонента ui-absent/);

        const first = fakeRenderer();
        assert.equal(await installCommand({ ...base, renderer: first, positionals: ['ui-twice'], values: { save: true } }), 0);
        await writeFile(path.join(host, 'vendor', 'components', 'ui-twice', 'index.js'), '// local edit\n');
        const again = fakeRenderer();
        assert.equal(await installCommand({ ...base, renderer: again, positionals: ['ui-twice'], values: { save: true } }), 0);
        assert.match(again.text(), /уже существует — пропущено/);
        assert.equal(await readFile(path.join(host, 'vendor', 'components', 'ui-twice', 'index.js'), 'utf8'), '// local edit\n', 'a local edit survives');

        const forced = fakeRenderer();
        assert.equal(await installCommand({ ...base, renderer: forced, positionals: ['ui-twice'], values: { save: true, force: true } }), 0);
        assert.match(await readFile(path.join(host, 'vendor', 'components', 'ui-twice', 'index.js'), 'utf8'), /customElements\.define/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(project, { recursive: true, force: true });
        await rm(host, { recursive: true, force: true });
    }
});

test('ai install needs a project to install into', async () => {
    const home = await tempDir('ai-registry-');
    const bare = await tempDir('ai-bare-host-');
    const renderer = fakeRenderer();
    await assert.rejects(
        () => installCommand({
            cwd: bare, renderer, positionals: ['ui-anything'], values: { save: true },
            config: { components: { enabled: true, dir: path.join(home, 'components'), dbFile: path.join(home, 'components.db'), vendorDir: 'vendor/components' } },
        }),
        /package\.json/,
    );
    await assert.rejects(
        () => installCommand({
            cwd: bare, renderer, positionals: [], values: { save: true },
            config: { components: { enabled: true, dir: path.join(home, 'components'), dbFile: path.join(home, 'components.db'), vendorDir: 'vendor/components' } },
        }),
        /ai install <tag>/,
    );
    await rm(home, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
});
