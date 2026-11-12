/**
 * @file test/skills.test.js
 * @purpose Verify skill discovery, frontmatter parsing (including YAML block scalars),
 *   and buildSkillInstructions.
 * @ai.hint pure
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { discoverSkills, buildSkillInstructions, parseFrontmatter } from '../src/agent/skills.js';

describe('parseFrontmatter', () => {
    it('parses simple single-line frontmatter', () => {
        const raw = `---
name: my-skill
description: A short description
---

# My Skill

Instructions here.`;
        const result = parseFrontmatter(raw);
        assert.equal(result.name, 'my-skill');
        assert.equal(result.description, 'A short description');
        assert.ok(result.body.includes('Instructions here'));
    });

    it('parses YAML folded scalar (>)', () => {
        const raw = `---
name: chrome-extensions
description: >
  Build and publish Chrome Extensions using Manifest V3 best practices.
  Use this skill when the user asks to create, modify, or debug Chrome extensions.
---

# Chrome Extensions

Follow the guide.`;
        const result = parseFrontmatter(raw);
        assert.equal(result.name, 'chrome-extensions');
        assert.equal(result.description, 'Build and publish Chrome Extensions using Manifest V3 best practices. Use this skill when the user asks to create, modify, or debug Chrome extensions.');
    });

    it('parses YAML literal scalar (|)', () => {
        const raw = `---
name: modern-web-guidance
description: |
  Search tool for modern web development best practices. MANDATORY: Execute FIRST for all tasks.
  Trigger immediately for: modals, tables, dark mode, forms.
  DO NOT trigger for: backend, infra.
---

# Modern Web Guidance

Search and retrieve guidelines...`;
        const result = parseFrontmatter(raw);
        assert.equal(result.name, 'modern-web-guidance');
        assert.ok(result.description.includes('MANDATORY: Execute FIRST'));
        assert.ok(result.description.includes('DO NOT trigger for'));
    });

    it('handles missing frontmatter gracefully', () => {
        const result = parseFrontmatter('Just plain text');
        assert.equal(result.name, '');
        assert.equal(result.description, '');
    });

    it('handles frontmatter without description', () => {
        const raw = '---\nname: test\n---\n\nBody';
        const result = parseFrontmatter(raw);
        assert.equal(result.name, 'test');
        assert.equal(result.description, '');
    });
});

describe('buildSkillInstructions', () => {
    it('returns empty string for no skills', () => {
        assert.equal(buildSkillInstructions([]), '');
    });

    it('includes skill list and read_skill instruction', () => {
        const skills = [
            { name: 'ego-browser', description: 'Browser automation skill', body: '# Ego', path: '/test/SKILL.md' },
            { name: 'modern-web-guidance', description: 'Web best practices', body: '# MWG', path: '/test/SKILL.md' },
        ];
        const text = buildSkillInstructions(skills);
        assert.ok(text.includes('# Available Skills'));
        assert.ok(text.includes('`ego-browser`'));
        assert.ok(text.includes('`modern-web-guidance`'));
        assert.ok(text.includes('read_skill'));
    });
});

describe('discoverSkills', () => {
    it('discovers all installed skills in .agents/skills', async () => {
        const skills = await discoverSkills(process.cwd());
        const names = skills.map((s) => s.name);
        assert.ok(names.includes('ego-browser'), 'should find ego-browser');
        assert.ok(names.includes('modern-web-guidance'), 'should find modern-web-guidance');
        assert.ok(names.includes('chrome-extensions'), 'should find chrome-extensions');
        // Deduplication: same name from multiple dirs keeps first (workspace over global).
        assert.equal(names.filter((n) => n === 'ego-browser').length, 1);
    });
});
