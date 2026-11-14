/**
 * @file src/agent/icon-sets.js
 * @module agent/icon-sets
 * @purpose The icon sets of the CDN: Phosphor and Lucide — their names and their files.
 *
 *   The sets are big: Lucide has more than a thousand icons, Phosphor has more than a
 *   thousand five hundred. A role that picks the icons by memory picks the wrong ones, and a
 *   wrong name is a broken interface. The catalogue of a set is read from the CDN and cached:
 *   the role searches the names and takes the ones that are really there.
 *
 *   The catalogue comes from the data of jsDelivr: the list of the files of the package. The
 *   version of the package is resolved from its `package.json`, so the names are the names of
 *   the set as it is today.
 *
 * @depends node:path
 * @usedBy agent/assets, agent/tools, agent/tool-specs
 * @exports ICON_SETS, ICON_SET_NAMES, iconSetConfig, iconUrl, iconCatalogue, searchIcons,
 *          clearIconCatalogue
 * @ai.tags icons, cdn
 * @ai.hint io
 * @changed 2026-11-15 The catalogue of the sets: the names are read from the CDN.
 */

import path from 'node:path';

/** The CDN of the packages. */
const CDN = 'https://cdn.jsdelivr.net/npm';

/** The data of the packages: the list of their files. */
const DATA = 'https://data.jsdelivr.com/v1/package/npm';

/** The agent of the requests of the catalogue. */
const AGENT = 'ai-webdev/0.3 (icons)';

/** How long the catalogue of a set is kept. */
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;

/** The biggest answer of the catalogue. */
const MAX_CATALOGUE_BYTES = 8 * 1024 * 1024;

/**
 * The sets the project may take the icons from.
 *
 * `cdn` is the directory of the SVG files, `prefix` is the part of the path of a file in the
 * package that the catalogue keeps, and `variants` are the weights of the set.
 * @type {Readonly<Record<string, object>>}
 * @exports
 */
export const ICON_SETS = Object.freeze({
    phosphor: Object.freeze({
        name: 'phosphor',
        package: '@phosphor-icons/core',
        version: '2.1.1',
        variants: Object.freeze(['thin', 'light', 'regular', 'bold', 'fill', 'duotone']),
        defaultVariant: 'regular',
        cdn: `${CDN}/@phosphor-icons/core@2.1.1/assets`,
        prefix: '/assets/{variant}/',
    }),
    lucide: Object.freeze({
        name: 'lucide',
        package: 'lucide-static',
        version: '1.73.0',
        variants: Object.freeze(['default']),
        defaultVariant: 'default',
        cdn: `${CDN}/lucide-static@latest/icons`,
        prefix: '/icons/',
    }),
});

/**
 * The names of the sets.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function ICON_SET_NAMES() {
    return Object.keys(ICON_SETS);
}

/**
 * The config of a set, or null when the set is unknown.
 * @param {string} name
 * @returns {object|null}
 * @exports
 * @ai.hint pure
 */
export function iconSetConfig(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return ICON_SETS[key] ?? null;
}

/**
 * The name of an icon as the set writes it: kebab-case, without the extension.
 * @param {string} icon
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function iconName(icon) {
    return String(icon ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.svg$/i, '')
        .replace(/^[/\\]+/, '')
        .replace(/[/\\]+/g, '-');
}

/**
 * The address of one icon of a set.
 * @param {object} set the config of the set
 * @param {string} icon the name of the icon
 * @param {string} [variant] the weight of the icon
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function iconUrl(set, icon, variant = '') {
    const weight = set.variants.includes(String(variant ?? '')) ? String(variant) : set.defaultVariant;
    if (set.variants.length === 1) return `${set.cdn}/${iconName(icon)}.svg`;
    return `${set.cdn}/${weight}/${iconName(icon)}.svg`;
}

/** The catalogue of the sets, with the time it was read. */
const catalogues = new Map();

/**
 * Read a JSON answer with a cap.
 * @param {string} url
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function fetchJson(url, { signal = null } = {}) {
    const res = await fetch(url, {
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_CATALOGUE_BYTES) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * The version of a package as it is now.
 * @param {object} set
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function resolveVersion(set, { signal = null } = {}) {
    try {
        const res = await fetch(`${CDN}/${set.package}@latest/package.json`, {
            signal,
            redirect: 'follow',
            headers: { 'User-Agent': AGENT },
        });
        if (res.ok) {
            const data = await res.json();
            const version = String(data?.version ?? '').trim();
            if (version) return version;
        }
    } catch {
        // The pinned version of the set is used instead.
    }
    return set.version;
}

/**
 * The names of the icons of a set.
 *
 * The names are read from the list of the files of the package and kept for a while: the
 * catalogue of a set does not change from hour to hour, and the read costs a megabyte.
 * @param {string} name the name of the set
 * @param {{ signal?: AbortSignal|null, force?: boolean }} [options]
 * @returns {Promise<string[]>}
 * @exports
 * @ai.hint io
 */
export async function iconCatalogue(name, { signal = null, force = false } = {}) {
    const set = iconSetConfig(name);
    if (!set) {
        throw new Error(`Неизвестный набор иконок: "${name}". Поддерживаются: ${ICON_SET_NAMES().join(', ')}.`);
    }
    const hit = catalogues.get(set.name);
    if (!force && hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.names;

    const version = await resolveVersion(set, { signal });
    const data = await fetchJson(`${DATA}/${set.package}@${version}/flat`, { signal });
    const prefix = set.prefix.replace('{variant}', set.defaultVariant);
    const names = [];
    for (const file of Array.isArray(data?.files) ? data.files : []) {
        const fileName = String(file?.name ?? '');
        if (!fileName.startsWith(prefix) || !fileName.endsWith('.svg')) continue;
        names.push(fileName.slice(prefix.length, -4));
    }
    const unique = [...new Set(names)].sort();
    if (!unique.length) {
        // The catalogue is not reachable: the names that were read last time are better than
        // nothing, and the download of the icons does not need the catalogue anyway.
        if (hit) return hit.names;
        throw new Error(`Каталог набора ${set.name} не прочитан.`);
    }
    catalogues.set(set.name, { at: Date.now(), names: unique });
    return unique;
}

/**
 * Forget the catalogue of the sets.
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function clearIconCatalogue() {
    catalogues.clear();
}

/**
 * How well the name of an icon fits the words of the request.
 * @param {string} icon
 * @param {string[]} words
 * @returns {number}
 * @ai.hint pure
 */
function scoreIcon(icon, words) {
    let score = 0;
    // The name that holds every word is the name of the thing: `scan-square` for "scan square".
    const joined = words.join('-');
    if (words.length > 1 && icon === joined) score += 200;
    else if (words.length > 1 && icon.includes(joined)) score += 80;
    for (const word of words) {
        if (icon === word) score += 100;
        else if (icon.startsWith(word)) score += 40;
        else if (icon.includes(word)) score += 15;
        else if (icon.replace(/-/g, '').includes(word.replace(/-/g, ''))) score += 5;
    }
    return score;
}

/**
 * The names of the icons of a set that fit the words of a request.
 *
 * The search is by name: the sets name their icons after the thing they draw, so the word of
 * the thing is the word of the name.
 * @param {string} name the name of the set
 * @param {string} query the words to look for
 * @param {{ limit?: number, signal?: AbortSignal|null }} [options]
 * @returns {Promise<string[]>}
 * @exports
 * @ai.hint io
 */
export async function searchIcons(name, query, { limit = 40, signal = null } = {}) {
    const names = await iconCatalogue(name, { signal });
    const text = String(query ?? '').trim().toLowerCase();
    const words = text.split(/[\s,]+/).map((word) => word.trim()).filter(Boolean);
    const max = Math.max(1, Number(limit) || 40);
    if (!words.length) return names.slice(0, max);
    const scored = [];
    for (const icon of names) {
        const score = scoreIcon(icon, words);
        if (score > 0) scored.push({ icon, score });
    }
    scored.sort((a, b) => (b.score - a.score) || a.icon.localeCompare(b.icon));
    return scored.slice(0, max).map((item) => item.icon);
}

/**
 * The path of the file of an icon inside the project.
 * @param {string} dir the directory of the icons
 * @param {string} icon the name of the icon
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function iconFile(dir, icon) {
    const base = String(dir ?? '').split(path.win32.sep).join('/').replace(/\/?$/, '/');
    return `${base}${iconName(icon)}.svg`;
}
