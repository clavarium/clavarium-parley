import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Parley } from '../host/parley-host.mjs';
import { bridge } from '../server/parley-mcp.mjs';
import { view } from '../ui/parley-ui.js';
import { run } from '../bin/parley.mjs';

const folder = (t) => { const d = mkdtempSync(join(tmpdir(), 'parley-sp-')); t.after(() => rmSync(d, { recursive: true, force: true })); const dir = join(d, '.parley'); mkdirSync(dir); return { root: d, dir }; };

test('a voice box speaks in its own name; the agent answers it by its id, and the screen names it', (t) => {
    const { dir } = folder(t);
    const host = new Parley(dir);
    assert.deepEqual(host.setSpeakers([{ id: 'box-1', name: 'Kitchen', place: 'Lake house' }, { id: 'box-2', name: 'Garden' }, { id: '', name: 'nobody' }]),
        [{ id: 'box-1', name: 'Kitchen', place: 'Lake house' }, { id: 'box-2', name: 'Garden' }]);
    host.say('Is dinner ready?', undefined, [], { via: 'voice', by: { id: 'box-1', name: 'Kitchen', place: 'Lake house' } });

    const agent = bridge(dir);
    const read = agent.read();
    assert.match(read, /Message from Kitchen \(Lake house\), a voice box \(to answer it aloud, tell with to: \["box-1"\]\)/);
    assert.match(read, /Voice boxes here .*Kitchen · Lake house \(box-1\), Garden \(box-2\)/);

    assert.throws(() => agent.tell('Ready.', { to: ['box-9'] }), /no one here has the id box-9; those who do: Kitchen \(box-1\), Garden \(box-2\)\. Nothing was sent/);
    assert.match(agent.tell('Ready in ten minutes.', { to: ['box-1', 'box-2'] }), /said aloud where you sent it/);

    const model = host.read();
    const said = model.messages.find((m) => m.from === 'agent' && m.text === 'Ready in ten minutes.');
    assert.deepEqual(said.to, ['box-1', 'box-2']);
    assert.deepEqual(said.toNames, ['Kitchen · Lake house', 'Garden']);
    const asked = model.messages.find((m) => m.from === 'person');
    assert.deepEqual(asked.by, { id: 'box-1', name: 'Kitchen', place: 'Lake house' });

    /* Renamed: the screen says the name of the moment, the id stays. */
    host.setSpeakers([{ id: 'box-1', name: 'Big kitchen', place: 'Lake house' }, { id: 'box-2', name: 'Garden' }]);
    assert.deepEqual(host.read().messages.find((m) => m.text === 'Ready in ten minutes.').toNames, ['Big kitchen · Lake house', 'Garden']);

    const rows = view(host.read(), { words: {} });
    const flat = JSON.stringify(rows);
    assert.match(flat, /"by":"Kitchen · Lake house"/);
    assert.match(flat, /"toNames":\["Big kitchen · Lake house","Garden"\]/);
});

test('the command: tell --to', (t) => {
    const { root, dir } = folder(t);
    new Parley(dir).setSpeakers([{ id: 'box-1', name: 'Kitchen' }]);
    const ok = run(['tell', '--to', 'box-1', 'Dinner is ready.'], { cwd: root, env: {} });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /said aloud/);
    const bad = run(['tell', '--to', 'box-7', 'Dinner is ready.'], { cwd: root, env: {} });
    assert.notEqual(bad.code, 0);
    assert.match(bad.err + bad.out, /no one here has the id box-7/);
});
