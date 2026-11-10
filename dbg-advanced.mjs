import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { advancedMeasurePhase1 } from './src/agent/advanced.js';
import { loadImageAttachment } from './src/core/attachments.js';
const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const dir = await mkdtemp(path.join(os.tmpdir(), 'dbg-'));
await writeFile(path.join(dir, 'ref.png'), Buffer.from(TINY, 'base64'));
const url = `data:image/png;base64,${TINY}`;
const client = { async call(r) { return r === 'images/generations' ? { data: [{ task_id: 't' }] } : { data: { status: 'completed', result: { images: [{ url: [url, url], sizes: ['1000x800','400x100'], layers: [{ z_index: 0, name: 'base' }, { z_index: 1, name: 'headline', bounding_box: { absolute: [40,20,440,120] }, text_recognition: { text: 'Big headline', lines: [] } }] }] } } }; } };
const res = await advancedMeasurePhase1({ root: dir, workId: 'w', client, referencePath: 'ref.png', config: {}, notify: (e) => console.log('EV', JSON.stringify(e)) });
console.log('cropPaths', res.cropPaths);
console.log('layers', res.layers.map((l) => ({ name: l.name, localPath: l.localPath, bytes: l.bytes?.length })));
for (const rel of res.cropPaths) {
  try { const a = await loadImageAttachment(rel, { cwd: dir, maxBytes: 20 * 1024 * 1024 }); console.log('OK', rel, a.part.image_url.slice(0, 30)); }
  catch (e) { console.log('ERR', rel, e.message); }
}
await rm(dir, { recursive: true, force: true });
