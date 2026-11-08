/**
 * @file src/commands/component.js
 * @module commands/component
 * @purpose `ai component` — publish, list, search, show, and remove local components in the personal registry.
 * @depends node:path, commands/shared, core/registry, generate/component
 * @usedBy cli
 * @exports componentCommand
 * @ai.tags cli, component, registry
 * @ai.hint io
 * @changed 2026-11-08 First version.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { UsageError } from './shared.js';
import { openRegistry } from '../core/registry.js';
import { COMPONENT_CONTRACT_PATH, componentTagName } from '../generate/component.js';

/**
 * Split `tag@1.2.3` into its parts. A bare `@scope/name` keeps the whole string as the tag.
 * @param {string} spec
 * @returns {{ tag: string, version: string | null }}
 * @ai.hint pure
 */
export function splitSpec(spec) {
    const text = String(spec ?? '').trim();
    if (!text) return { tag: '', version: null };
    const at = text.lastIndexOf('@');
    if (at > 0) return { tag: text.slice(0, at).toLowerCase(), version: text.slice(at + 1) };
    return { tag: text.toLowerCase(), version: null };
}

/**
 * Open the registry from the resolved config.
 * @param {object} config
 * @returns {object}
 * @ai.hint io
 */
function registryOf(config) {
    if (config.components?.enabled === false) {
        throw new UsageError('Реестр компонентов выключен: components.enabled в конфигурации.');
    }
    return openRegistry({ file: config.components.dbFile, dir: config.components.dir });
}

function cardLine(component) {
    const tags = component.tags.length ? ` [${component.tags.join(', ')}]` : '';
    return `${component.tag}@${component.version}\t${component.framework}\t${component.summary || '—'}${tags}`;
}

/**
 * `ai component [publish|list|search|show|rm|path]`
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code.
 * @exports
 * @ai.hint io
 */
export async function componentCommand(ctx) {
    const { config, renderer, positionals, values } = ctx;
    const sub = positionals[0] ?? 'list';

    if (sub === 'path') {
        renderer.write(`Каталог: ${config.components.dir}\nИндекс:  ${config.components.dbFile}\n`);
        return 0;
    }

    if (sub === 'publish') {
        const sourceRoot = path.resolve(ctx.cwd, positionals[1] ?? '.');
        const registry = registryOf(config);
        try {
            let contract = null;
            // The version comes from the contract; --tag may also carry it as tag@1.2.0.
            const wanted = splitSpec(values.tag ?? '');
            if (wanted.tag || wanted.version) {
                const text = await readFile(path.join(sourceRoot, COMPONENT_CONTRACT_PATH), 'utf8')
                    .catch(() => { throw new UsageError(`${COMPONENT_CONTRACT_PATH} не найден в ${sourceRoot}.`); });
                contract = JSON.parse(text);
                if (wanted.tag) contract.tag = componentTagName(wanted.tag);
                if (wanted.version) contract.version = wanted.version;
            }
            const result = await registry.publish({ sourceRoot, contract, tags: values.tags ?? '' });
            renderer.line('ok', `${result.replaced ? 'Обновлён' : 'Опубликован'} компонент ${result.tag}@${result.version}`);
            renderer.write(`Файлов: ${result.files.length}  Содержимое: ${result.sha256}\n`);
            renderer.write(`${result.path}\n`);
            renderer.write(`Установка в проект: ai install ${result.tag}\n`);
            renderer.json({ type: 'component.publish', tag: result.tag, version: result.version, dir: result.path, files: result.files.length });
            return 0;
        } finally {
            registry.close();
        }
    }

    if (sub === 'list') {
        const registry = registryOf(config);
        try {
            const items = registry.list({ framework: values.frontendFramework ?? null });
            if (!items.length) {
                renderer.write('Реестр пуст. Опубликуйте компонент из проекта с контрактом:\n  ai gen component "…"   затем   ai component publish\n');
                return 0;
            }
            for (const item of items) renderer.write(cardLine(item) + '\n');
            renderer.write(`Всего: ${items.length}\n`);
            renderer.json({ type: 'component.list', items: items.map(({ contract, ...rest }) => rest) });
            return 0;
        } finally {
            registry.close();
        }
    }

    if (sub === 'search') {
        const query = positionals.slice(1).join(' ').trim();
        if (!query) throw new UsageError('Укажите запрос: ai component search <текст>');
        const registry = registryOf(config);
        try {
            const items = registry.search(query, { framework: values.frontendFramework ?? null });
            if (!items.length) {
                renderer.line('info', `Ничего не найдено: ${query}`);
                renderer.write('Опубликуйте похожий компонент: ai gen component "…"\n');
                return 1;
            }
            for (const item of items) renderer.write(cardLine(item) + '\n');
            renderer.json({ type: 'component.search', query, hits: items.map(({ contract, ...rest }) => rest) });
            return 0;
        } finally {
            registry.close();
        }
    }

    if (sub === 'show') {
        const { tag, version } = splitSpec(positionals[1]);
        if (!tag) throw new UsageError('Укажите тег: ai component show <tag>[@версия]');
        const registry = registryOf(config);
        try {
            const found = registry.get(tag, version);
            if (!found) {
                renderer.line('fail', `Компонент не найден: ${tag}${version ? `@${version}` : ''}`);
                return 1;
            }
            const readme = await readFile(path.join(found.dir, 'README.md'), 'utf8').catch(() => null);
            if (readme) renderer.write(readme.endsWith('\n') ? readme : `${readme}\n`);
            else renderer.write(JSON.stringify(found.contract, null, 2) + '\n');
            renderer.write(`\n--- ${found.tag}@${found.version}  ${found.dir}  установок: ${found.installs}\n`);
            return 0;
        } finally {
            registry.close();
        }
    }

    if (sub === 'rm' || sub === 'remove') {
        const { tag, version } = splitSpec(positionals[1]);
        if (!tag) throw new UsageError('Укажите тег: ai component rm <tag>[@версия]');
        const registry = registryOf(config);
        try {
            const result = registry.remove(tag, { version, keepFiles: Boolean(values['keep-files']) });
            if (!result.removed.length) {
                renderer.line('fail', `Компонент не найден: ${tag}${version ? `@${version}` : ''}`);
                return 1;
            }
            renderer.line('ok', `Удалён из реестра: ${result.removed.join(', ')}`);
            if (values['keep-files']) renderer.write(`Исходники оставлены: ${result.kept}\n`);
            return 0;
        } finally {
            registry.close();
        }
    }

    throw new UsageError('Доступно: ai component list | publish [путь] | search <текст> | show <tag> | rm <tag> | path');
}
