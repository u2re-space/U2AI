/**
 * @file src/commands/install.js
 * @module commands/install
 * @purpose `ai install` — copy a registry component into a project and register it in package.json as a local `file:` package.
 * @depends node:path, node:fs/promises, commands/shared, core/registry, commands/component
 * @usedBy cli
 * @exports installCommand, saveDependency
 * @ai.tags cli, component, registry
 * @ai.hint io
 * @changed 2026-11-08 First version. No HTTP registry: npm resolves a `file:` dependency offline.
 */
import path from 'node:path';
import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { UsageError } from './shared.js';
import { openRegistry } from '../core/registry.js';
import { splitSpec } from './component.js';

/**
 * Add or replace one dependency key, keeping the rest of the manifest and its
 * two-space style. Scripts and existing versions are never touched.
 * @param {{ manifest: object, name: string, specifier: string, dev?: boolean }} input
 * @returns {object} the same manifest object
 * @exports
 * @ai.hint pure
 */
export function saveDependency({ manifest, name, specifier, dev = false }) {
    const section = dev ? 'devDependencies' : 'dependencies';
    const other = dev ? 'dependencies' : 'devDependencies';
    manifest[section] = { ...(manifest[section] ?? {}), [name]: specifier };
    // A package cannot sit in both sections at once.
    if (manifest[other] && name in manifest[other]) {
        const { [name]: _removed, ...rest } = manifest[other];
        manifest[other] = rest;
        if (!Object.keys(manifest[other]).length) delete manifest[other];
    }
    return manifest;
}

/**
 * Relative specifier npm understands from the project root.
 * @param {string} vendorDir project-relative destination directory
 * @param {string} tag
 * @returns {string}
 * @ai.hint pure
 */
function fileSpecifier(vendorDir, tag) {
    const rel = path.posix.join(vendorDir.split(path.sep).join('/'), tag);
    return `file:./${rel.replace(/^\.\//, '')}`;
}

/**
 * `ai install <tag>[@версия] …`
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code.
 * @exports
 * @ai.hint io
 */
export async function installCommand(ctx) {
    const { config, renderer, positionals, values } = ctx;
    if (config.components?.enabled === false) throw new UsageError('Реестр компонентов выключен: components.enabled в конфигурации.');
    const specs = positionals.map(splitSpec).filter((spec) => spec.tag);
    if (!specs.length) throw new UsageError('Укажите компонент: ai install <tag>[@версия] […]. Список: ai component list');

    const manifestPath = path.join(ctx.cwd, 'package.json');
    let manifest = null;
    const manifestText = await readFile(manifestPath, 'utf8').catch(() => null);
    if (manifestText == null) {
        throw new UsageError(`В ${ctx.cwd} нет package.json. Установите компонент в проект или создайте его: npm init -y`);
    }
    try {
        manifest = JSON.parse(manifestText);
    } catch (error) {
        throw new UsageError(`Некорректный JSON в ${manifestPath}: ${error.message}`);
    }

    const vendorDir = config.components.vendorDir || 'vendor/components';
    const registry = openRegistry({ file: config.components.dbFile, dir: config.components.dir });
    const installed = [];
    const failed = [];
    try {
        for (const spec of specs) {
            const found = registry.get(spec.tag, spec.version);
            if (!found) {
                failed.push(spec.tag);
                renderer.line('fail', `В реестре нет компонента ${spec.tag}${spec.version ? `@${spec.version}` : ''}. Список: ai component list`);
                continue;
            }
            const dest = path.resolve(ctx.cwd, vendorDir, found.tag);
            const exists = await stat(dest).then(() => true).catch(() => false);
            if (exists && !values.force && !values.link) {
                renderer.line('warn', `${dest} уже существует — пропущено. Переустановить: ai install ${found.tag} --force`);
                installed.push({ tag: found.tag, version: found.version, dest, skipped: true });
                continue;
            }
            await rm(dest, { recursive: true, force: true });
            await mkdir(path.dirname(dest), { recursive: true });
            let linked = false;
            if (values.link) {
                try {
                    await symlink(found.dir, dest, 'junction');
                    linked = true;
                } catch (error) {
                    renderer.line('warn', `Символьная ссылка не удалась (${error.code ?? error.message}), копируем исходники.`);
                }
            }
            if (!linked) await cp(found.dir, dest, { recursive: true });
            saveDependency({
                manifest,
                name: found.name,
                specifier: fileSpecifier(vendorDir, found.tag),
                dev: Boolean(values.dev),
            });
            registry.recordInstall(found.tag, found.version);
            installed.push({ tag: found.tag, version: found.version, dest, linked, skipped: false, contract: found.contract });
            renderer.line('ok', `${found.name}@${found.version} → ${path.relative(ctx.cwd, dest) || dest}${linked ? ' (ссылка)' : ''}`);
            const typed = found.contract?.scriptLanguage === 'typescript';
            if (typed) {
                const built = await stat(path.join(dest, 'dist', `${found.tag}.js`)).then(() => true).catch(() => false);
                if (!built) renderer.line('warn', `${found.tag} на TypeScript: соберите компонент (npm run build в ${dest}), иначе exports указывает на отсутствующий dist/${found.tag}.js`);
            }
        }
    } finally {
        registry.close();
    }

    if (values.save === false) {
        renderer.line('info', 'package.json не изменён (--no-save).');
    } else if (installed.some((item) => !item.skipped)) {
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        renderer.line('info', 'package.json обновлён. Установите ссылки npm install.');
    }
    for (const item of installed.filter((entry) => entry.contract)) {
        renderer.write(`  import '${item.contract.name}';  →  <${item.contract.tag}></${item.contract.tag}>\n`);
    }
    renderer.json({ type: 'component.install', installed: installed.map(({ contract, ...rest }) => rest), failed });
    return failed.length && !installed.length ? 1 : 0;
}
