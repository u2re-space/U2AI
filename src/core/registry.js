/**
 * @file src/core/registry.js
 * @module core/registry
 * @purpose Local component registry: a SQLite index plus a directory of sources, searchable and installable without a network.
 * @depends node:path, node:crypto, node:fs, node:fs/promises, node:sqlite, generate/component
 * @usedBy commands/component, commands/install, generate/scaffold
 * @exports openRegistry, REGISTRY_IGNORE
 * @ai.tags registry, component, sqlite
 * @ai.hint io
 * @changed 2026-11-08 First version. Same shape as core/memory: node:sqlite, FTS5, no dependencies.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { normalizeComponentContract, renderComponentContract, COMPONENT_CONTRACT_PATH } from '../generate/component.js';

/** Never copied into the registry. `.ai` is kept only for the contract itself. */
export const REGISTRY_IGNORE = Object.freeze(['node_modules', '.git', '.tmp', '.DS_Store', 'package-lock.json', '.npmrc']);

const now = () => new Date().toISOString();
const tagsToText = (tags) => (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean)
    .join(',');

/**
 * FTS5 query: every word becomes a quoted prefix token joined with OR, so an
 * inflected Russian word still matches ("календаря" finds "календарь").
 * @ai.hint pure
 */
function ftsQuery(text) {
    const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const stems = words.map((word) => (word.length > 5 ? word.slice(0, Math.max(4, word.length - 2)) : word));
    const unique = [...new Set(stems)].slice(0, 24);
    return unique.map((word) => `"${word.replaceAll('"', '')}"*`).join(' OR ');
}

/**
 * Words that make a component findable: the API names carry more signal than prose.
 * @param {object} contract
 * @param {string} [extra]
 * @returns {string}
 * @ai.hint pure
 */
function keywordsOf(contract, extra = '') {
    const names = (list) => (list ?? []).map((item) => item.name).join(' ');
    return [
        contract.tag, contract.className, contract.name, contract.summary, contract.framework,
        names(contract.attrs), names(contract.props), names(contract.events),
        names(contract.slots), names(contract.parts), names(contract.states), names(contract.cssVars),
        extra,
    ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Copy one component tree into the registry, skipping installed and VCS noise.
 * `dist` is kept: a TypeScript package resolves its `exports` through the build.
 * @param {{ from: string, to: string }} input
 * @returns {Promise<string[]>} registry-relative paths that were copied
 * @ai.hint io
 */
async function copyTree({ from, to }) {
    const copied = [];
    const walk = async (src, rel) => {
        const entries = await readdir(src, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (REGISTRY_IGNORE.includes(entry.name)) continue;
            const srcPath = path.join(src, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (relPath === '.ai') continue;
                await walk(srcPath, relPath);
                continue;
            }
            if (!entry.isFile()) continue;
            const dest = path.join(to, ...relPath.split('/'));
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(srcPath, dest);
            copied.push(relPath);
        }
    };
    await mkdir(to, { recursive: true });
    await walk(from, '');
    // The contract lives under .ai, which the walk skips as a directory.
    const contractText = await readFile(path.join(from, COMPONENT_CONTRACT_PATH), 'utf8').catch(() => null);
    if (contractText != null) {
        const dest = path.join(to, ...COMPONENT_CONTRACT_PATH.split('/'));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, contractText);
        copied.push(COMPONENT_CONTRACT_PATH);
    }
    return copied;
}

/**
 * Digest of the copied files, so the same sources publish as the same record.
 * @param {string[]} files
 * @param {string} root
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function digestOf(files, root) {
    const hash = createHash('sha256');
    for (const rel of [...files].sort()) {
        hash.update(rel);
        hash.update(await readFile(path.join(root, ...rel.split('/'))).catch(() => Buffer.alloc(0)));
    }
    return hash.digest('hex').slice(0, 16);
}

/**
 * Open the registry. `file` may be `:memory:` for tests; `dir` holds the sources.
 *
 *   components — one row per tag and version: contract JSON, keywords, path, digest
 * @param {{ file: string, dir: string }} options
 * @returns {object} registry api
 * @exports
 * @ai.hint io
 */
export function openRegistry({ file, dir }) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS components (
      id INTEGER PRIMARY KEY, tag TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', framework TEXT NOT NULL DEFAULT 'vanilla',
      keywords TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
      dir TEXT NOT NULL, contract TEXT NOT NULL, sha256 TEXT NOT NULL DEFAULT '',
      installs INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tag, version)
    );
    CREATE INDEX IF NOT EXISTS components_tag ON components(tag);
  `);
    let fts = true;
    try {
        db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS components_fts USING fts5(keywords, summary, tags, content='components', content_rowid='id', tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS components_ai AFTER INSERT ON components BEGIN
          INSERT INTO components_fts(rowid, keywords, summary, tags) VALUES (new.id, new.keywords, new.summary, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS components_ad AFTER DELETE ON components BEGIN
          INSERT INTO components_fts(components_fts, rowid, keywords, summary, tags) VALUES ('delete', old.id, old.keywords, old.summary, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS components_au AFTER UPDATE ON components BEGIN
          INSERT INTO components_fts(components_fts, rowid, keywords, summary, tags) VALUES ('delete', old.id, old.keywords, old.summary, old.tags);
          INSERT INTO components_fts(rowid, keywords, summary, tags) VALUES (new.id, new.keywords, new.summary, new.tags);
        END;
      `);
    } catch { fts = false; }

    const row = (raw) => (raw ? {
        id: raw.id, tag: raw.tag, version: raw.version, name: raw.name, summary: raw.summary,
        framework: raw.framework, tags: raw.tags ? raw.tags.split(',').filter(Boolean) : [],
        dir: raw.dir, sha256: raw.sha256, installs: raw.installs,
        createdAt: raw.created_at, updatedAt: raw.updated_at,
        contract: (() => { try { return JSON.parse(raw.contract); } catch { return null; } })(),
    } : null);

    const api = {
        file, dir, fts,

        /**
         * Store a component from a project directory. A repeated publish of the
         * same tag and version replaces the previous copy.
         * @param {{ sourceRoot: string, contract?: object, tags?: string | string[] }} input
         * @returns {Promise<{ tag: string, version: string, path: string, files: string[], sha256: string, replaced: boolean }>}
         */
        async publish({ sourceRoot, contract = null, tags = '' }) {
            const rootStat = await stat(sourceRoot).then((info) => info.isDirectory()).catch(() => false);
            if (!rootStat) throw new Error(`Каталог компонента не найден: ${sourceRoot}`);
            let stored = contract;
            if (!stored) {
                const text = await readFile(path.join(sourceRoot, COMPONENT_CONTRACT_PATH), 'utf8').catch(() => null);
                if (text == null) {
                    throw new Error(`${COMPONENT_CONTRACT_PATH} не найден. Опубликовать можно только проект с контрактом компонента (ai gen component).`);
                }
                stored = JSON.parse(text);
            }
            const c = normalizeComponentContract(stored);
            const target = path.join(dir, c.tag, c.version);
            await rm(target, { recursive: true, force: true });
            const files = await copyTree({ from: sourceRoot, to: target });
            if (!files.includes('package.json')) throw new Error(`В ${sourceRoot} нет package.json — компонент нельзя установить как пакет.`);
            const sha256 = await digestOf(files, target);
            const stamp = now();
            const keywordText = keywordsOf(c, tagsToText(tags));
            const existing = db.prepare('SELECT id FROM components WHERE tag = ? AND version = ?').get(c.tag, c.version);
            db.prepare(`INSERT INTO components (tag, version, name, summary, framework, keywords, tags, dir, contract, sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tag, version) DO UPDATE SET name = excluded.name, summary = excluded.summary, framework = excluded.framework,
          keywords = excluded.keywords, tags = excluded.tags, dir = excluded.dir, contract = excluded.contract,
          sha256 = excluded.sha256, updated_at = excluded.updated_at`).run(
                c.tag, c.version, c.name, c.summary, c.framework, keywordText, tagsToText(tags),
                target, renderComponentContract(c), sha256, stamp, stamp,
            );
            return { tag: c.tag, version: c.version, path: target, files, sha256, replaced: Boolean(existing) };
        },

        /**
         * Full-text search over the API keywords, the summary, and the tags.
         * Falls back to a substring match when FTS5 is unavailable.
         * @param {string} query
         * @param {{ framework?: string | null, limit?: number }} [options]
         * @returns {object[]}
         */
        search(query, { framework = null, limit = 20 } = {}) {
            const cap = Number.isInteger(limit) && limit > 0 ? limit : 20;
            const fwSql = framework ? ' AND c.framework = $framework' : '';
            const params = { $limit: cap, ...(framework ? { $framework: framework } : {}) };
            const text = String(query ?? '').trim();
            if (!text) return api.list({ framework, limit: cap });
            if (fts) {
                const match = ftsQuery(text);
                if (match) {
                    const rows = db.prepare(`SELECT c.* FROM components c JOIN components_fts f ON f.rowid = c.id
            WHERE components_fts MATCH $match${fwSql} ORDER BY bm25(components_fts), c.installs DESC LIMIT $limit`).all({ $match: match, ...params });
                    if (rows.length) return rows.map(row);
                }
            }
            const like = `%${text.toLowerCase()}%`;
            return db.prepare(`SELECT * FROM components WHERE (lower(keywords) LIKE $like OR lower(summary) LIKE $like)${fwSql}
        ORDER BY installs DESC, updated_at DESC LIMIT $limit`).all({ $like: like, ...params }).map(row);
        },

        /**
         * Every component, newest version first.
         * @param {{ framework?: string | null, limit?: number }} [options]
         * @returns {object[]}
         */
        list({ framework = null, limit = 200 } = {}) {
            const cap = Number.isInteger(limit) && limit > 0 ? limit : 200;
            const sql = framework
                ? 'SELECT * FROM components WHERE framework = $framework ORDER BY tag, version DESC LIMIT $limit'
                : 'SELECT * FROM components ORDER BY tag, version DESC LIMIT $limit';
            return db.prepare(sql).all(framework ? { $framework: framework, $limit: cap } : { $limit: cap }).map(row);
        },

        /**
         * One component. Without a version the newest publish wins.
         * @param {string} tag
         * @param {string} [version]
         * @returns {object | null}
         */
        get(tag, version = null) {
            const wanted = String(tag ?? '').trim().toLowerCase();
            if (!wanted) return null;
            if (version) return row(db.prepare('SELECT * FROM components WHERE tag = ? AND version = ?').get(wanted, version));
            return row(db.prepare('SELECT * FROM components WHERE tag = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(wanted));
        },

        /**
         * Published versions of one tag, newest first.
         * @param {string} tag
         * @returns {string[]}
         */
        versions(tag) {
            const wanted = String(tag ?? '').trim().toLowerCase();
            return db.prepare('SELECT version FROM components WHERE tag = ? ORDER BY id DESC').all(wanted).map((item) => item.version);
        },

        /**
         * Forget a component. The last argument keeps the sources on disk.
         * @param {string} tag
         * @param {{ version?: string | null, keepFiles?: boolean }} [options]
         * @returns {{ removed: string[], kept: string }}
         */
        remove(tag, { version = null, keepFiles = false } = {}) {
            const found = api.get(tag, version);
            if (!found) return { removed: [], kept: '' };
            const rows = version
                ? db.prepare('SELECT * FROM components WHERE tag = ? AND version = ?').all(found.tag, version)
                : db.prepare('SELECT * FROM components WHERE tag = ?').all(found.tag);
            const del = db.prepare('DELETE FROM components WHERE id = ?');
            for (const item of rows) del.run(item.id);
            if (!keepFiles) {
                const root = path.join(dir, found.tag);
                const stillThere = db.prepare('SELECT id FROM components WHERE dir LIKE ?').get(`${root}%`);
                // Synchronous on purpose: the caller must see the directory gone
                // by the time remove() returns.
                if (!stillThere) { try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ } }
            }
            return { removed: rows.map((item) => `${item.tag}@${item.version}`), kept: found.dir };
        },

        /**
         * Count an install, so the reused components rank first later.
         * @param {string} tag
         * @param {string} version
         * @returns {void}
         */
        recordInstall(tag, version) {
            db.prepare('UPDATE components SET installs = installs + 1 WHERE tag = ? AND version = ?').run(String(tag ?? '').toLowerCase(), version);
        },

        /** Close the database handle. */
        close() {
            try { db.close(); } catch { /* already closed */ }
        },
    };
    return api;
}
