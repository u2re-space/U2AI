import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { writeTextFile, deleteFile, copyPath } from '../src/agent/fs-tools.js';
import { listProjectBackups, restoreProjectBackup } from '../src/agent/project-backup.js';

test('copyPath preserves binary bytes and recursively copies directory trees', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-copy-'));
    try {
        const binary = Buffer.from([0, 255, 12, 128, 10, 0, 42]);
        await mkdir(path.join(root, 'assets', 'nested'), { recursive: true });
        await writeFile(path.join(root, 'assets', 'image.bin'), binary);
        await writeFile(path.join(root, 'assets', 'nested', 'note.txt'), 'unchanged');

        const copiedFile = await copyPath({ root, source: 'assets/image.bin', destination: 'out/image.bin' });
        assert.deepEqual(copiedFile, { source: 'assets/image.bin', destination: 'out/image.bin', type: 'file' });
        assert.deepEqual(await readFile(path.join(root, 'out', 'image.bin')), binary);

        const copiedDir = await copyPath({ root, source: 'assets', destination: 'archive/assets' });
        assert.equal(copiedDir.type, 'directory');
        assert.deepEqual(await readFile(path.join(root, 'archive', 'assets', 'image.bin')), binary);
        assert.equal(await readFile(path.join(root, 'archive', 'assets', 'nested', 'note.txt'), 'utf8'), 'unchanged');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('copyPath refuses existing destinations, self-copy, escapes, symlinks, and protected files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-copy-guard-'));
    try {
        await mkdir(path.join(root, 'tree'));
        await writeFile(path.join(root, 'tree', 'file.txt'), 'text');
        await writeFile(path.join(root, 'exists.bin'), Buffer.from([1]));
        await writeFile(path.join(root, 'secret.key'), 'secret');
        await assert.rejects(copyPath({ root, source: 'exists.bin', destination: 'exists.bin' }), /уже существует/);
        await assert.rejects(copyPath({ root, source: 'tree', destination: 'tree/nested' }), /внутрь самого себя/);
        await assert.rejects(copyPath({ root, source: 'secret.key', destination: 'safe/secret.key' }), /секретами/);
        await assert.rejects(copyPath({ root, source: 'exists.bin', destination: '../escape.bin' }), /вне рабочего каталога/);
        await assert.rejects(copyPath({ root, source: 'missing.bin', destination: 'new.bin' }), /Источник не найден/);
        await assert.rejects(copyPath({ root, source: '.', destination: 'root-copy' }), /Нужен путь/);
        const symlink = path.join(root, 'tree', 'link');
        try {
            await import('node:fs/promises').then(({ symlink: makeSymlink }) => makeSymlink(path.join(root, 'tree', 'file.txt'), symlink));
            await assert.rejects(copyPath({ root, source: 'tree', destination: 'copy-tree' }), /символических ссылок/);
            assert.equal(await lstat(path.join(root, 'copy-tree')).catch(() => null), null);
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an overwrite keeps the previous bytes and restore puts them back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-backup-'));
    try {
        await writeTextFile({ root, file: 'src/app.js', content: 'one\n', backupSlot: 's01-surface' });
        const changed = await writeTextFile({ root, file: 'src/app.js', content: 'two\n', backupSlot: 's01-body' });
        assert.equal(changed.projectBackup.slot, 's01-body');
        assert.equal(changed.projectBackup.path, 'src/app.js');
        const listed = await listProjectBackups({ root, file: 'src/app.js' });
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, changed.projectBackup.id);
        await writeTextFile({ root, file: 'src/app.js', content: 'lost\n', backupSlot: 's02-body' });
        const restored = await restoreProjectBackup({ root, id: changed.projectBackup.id, file: 'src/app.js' });
        assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'one\n');
        assert.equal(restored.slot, 's01-body');
        assert.ok(restored.replaced);
        const after = await listProjectBackups({ root, file: 'src/app.js' });
        assert.equal(after.at(-1).slot, `before-${changed.projectBackup.id}`);
        await assert.rejects(() => restoreProjectBackup({ root, id: changed.projectBackup.id, file: 'other.js' }), /не other\.js/);
        await assert.rejects(() => restoreProjectBackup({ root, id: 'missing' }), /не найден/);
        const removed = await deleteFile({ root, file: 'src/app.js', backupSlot: 's03-body' });
        assert.equal(removed.projectBackup.path, 'src/app.js');
        await restoreProjectBackup({ root, id: removed.projectBackup.id });
        assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'one\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
