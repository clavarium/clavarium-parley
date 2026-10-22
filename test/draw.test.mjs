import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, Parley, texts, NOTE_MAX } from '../host/parley-host.mjs';
import { view, KEYS, drawnName, drawnSize, penWidth, PEN_COLOURS, DRAWN_MAX_PX } from '../ui/parley-ui.js';

const COMMAND = fileURLToPath(new URL('../bin/parley.mjs', import.meta.url));
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const parley = (cwd, args) => { const r = spawnSync(process.execPath, [COMMAND, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PARLEY_DIR: '' } }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test('a picture drawn on is sent under a name that says so, no larger than it must be, its lines as thick on any size', () => {
    assert.equal(drawnName('photo.jpg', 'image/jpeg'), 'photo-annotated.jpg');
    assert.equal(drawnName('Screenshot 2026.10.22.png', 'image/png'), 'Screenshot 2026.10.22-annotated.png');
    assert.equal(drawnName('', 'image/png'), 'picture-annotated.png');
    assert.deepEqual(drawnSize(1200, 800), { w: 1200, h: 800 }, 'its own size');
    assert.deepEqual(drawnSize(4000, 3000), { w: DRAWN_MAX_PX, h: 1536 }, 'a large photo: smaller, its shape kept');
    assert.deepEqual(drawnSize(0, 0), { w: 1, h: 1 });
    assert.equal(penWidth(150, 100), 3, 'never thinner than this');
    assert.equal(penWidth(2048, 1536), 14);
    assert.ok(PEN_COLOURS.length >= 4 && PEN_COLOURS.every((c) => /^#[0-9a-f]{6}$/.test(c)));
    for (const key of ['draw-open', 'draw-marked', 'draw-colour', 'draw-undo', 'draw-clear', 'draw-cancel', 'draw-done', 'draw-note', 'draw-hint']) {
        assert.ok(KEYS.includes(key), key);
        for (const lang of ['en', 'fr']) assert.ok(texts(lang)[key], `${lang}: ${key}`);
    }
});

test('a note about one file the person attached: kept with it, read by the agent under it, shown under it', (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    const host = new Parley(dir, { reach: (path) => `work:${path.slice(6)}` });
    host.say('Look.', undefined, [
        { path: '/work/.parley/files/a1/shot-annotated.png', name: 'shot-annotated.png', size: 2048, note: '  This button\ndoes nothing  ' },
        { path: '/work/.parley/files/a2/log.txt', name: 'log.txt', size: 10 },
        { path: '/work/.parley/files/a3/long.png', name: 'long.png', size: 10, note: 'x'.repeat(NOTE_MAX + 50) },
    ]);
    const files = host.read().messages.at(-1).files;
    assert.equal(files[0].note, 'This button does nothing', 'one line');
    assert.equal('note' in files[1], false, 'none: nothing');
    assert.equal(files[2].note.length, NOTE_MAX);
    assert.match(parley(home, ['read']).out, /Attached file: \/work\/\.parley\/files\/a1\/shot-annotated\.png \(2 KB\)\n {4}Their note on this file: This button does nothing\n {2}Attached file: \/work\/\.parley\/files\/a2\/log\.txt/);
    const items = view(host.read(), { words: texts('en') }).items;
    assert.equal(items[0].files[0].note, 'This button does nothing');
    assert.equal('note' in items[0].files[1], false);
});
