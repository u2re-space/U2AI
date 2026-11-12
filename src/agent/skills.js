/**
 * @file src/agent/skills.js
 * @module agent/skills
 * @purpose Discover, load, and inject SKILL.md files from OpenClaw-compatible directories
 *   (.agents/skills, .koda/skills, .claude/skills, ~/.agents/skills).
 *   Provides `discoverSkills` and `buildSkillInstructions` so the role pipeline can
 *   surface available skills as a `read_skill` tool and inject usage guidance into roles.
 * @depends node:path, node:fs/promises
 * @usedBy agent/team, agent/roles
 * @ai.tags skills, skill-discovery, openclaw
 * @ai.hint io
 */

import path from 'node:path';
import { readFile, stat, readdir } from 'node:fs/promises';

/** SKILL.md frontmatter marker. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Parse YAML frontmatter from a SKILL.md body (minimal, no external deps).
 * Handles YAML block scalars (folded `>` and literal `|`) for multi-line values.
 * @param {string} body
 * @returns {{ name: string, description: string, metadata: object, body: string }}
 */
export function parseFrontmatter(body) {
    const match = body.match(FRONTMATTER_RE);
    if (!match) return { name: '', description: '', metadata: {}, body };
    const lines = match[1].split('\n');
    const meta = {};
    let name = '';
    let description = '';
    for (let i = 0; i < lines.length; i++) {
        const kv = lines[i].match(/^(\w+):[ 	]*(.*)$/);
        if (!kv) continue;
        const key = kv[1];
        let value = kv[2].trim();
        // A folded (`>`) or literal (`|`) scalar puts the text on the following, more-indented
        // lines; real SKILL.md files use this for long trigger descriptions.
        if (value === '>' || value === '|' || value === '>-' || value === '|-') {
            const fold = value[0] === '>';
            const parts = [];
            while (i + 1 < lines.length && (/^[ 	]/.test(lines[i + 1]) || lines[i + 1] === '')) {
                parts.push(lines[++i].replace(/^[ 	]+/, ''));
            }
            // A trailing blank line is the scalar's terminator, not content.
            while (parts.length && parts[parts.length - 1] === '') parts.pop();
            value = fold ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n');
        } else {
            value = value.replace(/^["']|["']$/g, '');
        }
        if (key === 'name') name = value;
        else if (key === 'description') description = value;
        else meta[key] = value;
    }
    return { name, description, metadata: meta, body: match[2] };
}

/**
 * Discover all skills in a given directory.
 * Each skill is a subdirectory containing a SKILL.md file.
 * @param {string} dir — absolute path to a skills directory (e.g. `.agents/skills/`)
 * @returns {Promise<Array<{name: string, description: string, body: string, path: string}>>}
 * @ai.hint io
 */
async function discoverInDir(dir) {
    const skills = [];
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillMd = path.join(dir, entry.name, 'SKILL.md');
            try {
                const raw = await readFile(skillMd, 'utf8');
                const parsed = parseFrontmatter(raw);
                if (parsed.name && parsed.body.trim()) {
                    skills.push({
                        name: parsed.name,
                        description: parsed.description || '',
                        body: parsed.body.trim(),
                        path: skillMd,
                    });
                }
            } catch { /* SKILL.md missing or unreadable — skip */ }
        }
    } catch { /* directory missing — skip */ }
    return skills;
}

/**
 * Standard skill directories (OpenClaw-compatible), in precedence order.
 * @param {string} root — project root
 * @returns {string[]}
 */
function skillDirectories(root) {
    return [
        path.join(root, '.agents', 'skills'),
        path.join(root, '.koda', 'skills'),
        path.join(root, '.claude', 'skills'),
        path.join(root, '.rules', 'skills'),
        path.join(process.env.HOME || process.env.USERPROFILE || '', '.agents', 'skills'),
    ];
}

/**
 * Discover all available skills from standard directories.
 * Deduplicates by name (first discovery wins).
 * @param {string} root — project root
 * @param {object} [options]
 * @param {string[]} [options.extraDirs] — additional directories to scan
 * @returns {Promise<Array<{name: string, description: string, body: string, path: string}>>}
 * @ai.hint io
 */
export async function discoverSkills(root, { extraDirs = [] } = {}) {
    const dirs = [...skillDirectories(root), ...extraDirs];
    const all = [];
    for (const dir of dirs) {
        const found = await discoverInDir(dir);
        all.push(...found);
    }
    // Deduplicate by name, keeping first occurrence (workspace-local over global).
    const seen = new Set();
    return all.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
    });
}

/**
 * Build a concise skill list text for injection into role instructions.
 * @param {Array<{name: string, description: string, body: string, path: string}>} skills
 * @returns {string}
 * @ai.hint pure
 */
export function buildSkillInstructions(skills) {
    if (!skills.length) return '';
    const lines = [
        '# Available Skills',
        '',
        'The following skills are installed and available via the `read_skill` tool.',
        'Each skill provides usage guidance for a specific capability (browser automation,',
        'modern web best practices, CLI tools, etc.). Read a skill before using its commands.',
        '',
        ...skills.map((s) => `- **\`${s.name}\`**: ${s.description}`),
        '',
        'To read a skill: call the `read_skill` tool with the skill name. The tool returns',
        'the full SKILL.md body, which includes commands, references, and workflow steps.',
    ];
    return lines.join('\n');
}

/**
 * Read the full body of a skill by name from the discovered skill directories.
 * @param {string} name — skill name (e.g. 'ego-browser')
 * @param {string} root — project root
 * @returns {Promise<{name: string, body: string, path: string}|null>}
 * @ai.hint io
 */
export async function readSkill(name, root) {
    const dirs = skillDirectories(root);
    for (const dir of dirs) {
        const skillMd = path.join(dir, name, 'SKILL.md');
        try {
            const raw = await readFile(skillMd, 'utf8');
            const parsed = parseFrontmatter(raw);
            if (parsed.name === name || !parsed.name) {
                return { name: parsed.name || name, body: parsed.body, path: skillMd };
            }
        } catch { /* not found in this dir, try next */ }
    }
    return null;
}

/**
 * Filter skills by trigger keywords in the skill body or name/description.
 * Useful for role-specific injection (e.g. only web skills for the coder role).
 * @param {Array<{name: string, description: string, body: string, path: string}>} skills
 * @param {string[]} keywords — lowercase keywords to match
 * @returns {Array<{name: string, description: string, body: string, path: string}>}
 * @ai.hint pure
 */
export function filterSkillsByKeywords(skills, keywords) {
    return skills.filter((s) => {
        const searchable = `${s.name} ${s.description} ${s.body}`.toLowerCase();
        return keywords.some((kw) => searchable.includes(kw));
    });
}
