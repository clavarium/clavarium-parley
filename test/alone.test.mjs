/* PARLEY ALONE: no application around it but the few lines a test writes. The
   agent's command, the host's side, and the screen on a page, as any
   application would use them; lines of "the application" with neutral levels. */
import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakePage } from './fake-dom.mjs';
import { install, Parley, texts } from '../host/parley-host.mjs';
import { mount, view, pastedName, IDLE_MS } from '../ui/parley-ui.js';

const COMMAND = fileURLToPath(new URL('../bin/parley.mjs', import.meta.url));
const parley = (cwd, args) => { const r = spawnSync(process.execPath, [COMMAND, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PARLEY_DIR: '' } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const settle = () => new Promise((r) => setTimeout(r, 5));

test('alone: short versions, questions closed by the agent, each message of the person read then handled, paths it cites', (t) => {
    const home = mkdtempSync(join(tmpdir(), 'parley-alone-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, '.parley'); install(dir);
    writeFileSync(join(home, 'report.md'), '# report');
    const host = new Parley(dir, { reach: (path) => (path.startsWith(`${home}/`) ? `mine:${path.slice(home.length + 1)}` : null) });
    assert.equal(parley(home, ['tell', '--short', 'Disk full: 3 things', `Long text; see ${home}/report.md and /etc/passwd.`]).code, 0);
    assert.equal(parley(home, ['ask', 'Blue or red?', 'blue', 'red', '--short', 'Colour']).code, 0);
    let data = host.read();
    assert.deepEqual(data.messages.map((m) => [m.kind, m.short]), [['say', 'Disk full: 3 things'], ['ask', 'Colour']]);
    assert.deepEqual(data.messages[0].refs, [{ path: `${home}/report.md`, open: 'mine:report.md' }], 'a cited path the person can open; not one they cannot');
    assert.deepEqual(data.files.map((f) => [f.path, f.cited]), [[`${home}/report.md`, true]], 'and among the files');
    assert.equal(data.waiting, 1);
    /* The person writes something else; the agent reads, sees the question open, closes it. */
    host.say('Red, and hurry.');
    const read = parley(home, ['read']).out;
    const id = /\[([0-9a-f]{8})\] Blue or red\?/.exec(read)?.[1];
    assert.ok(id, read);
    assert.equal(parley(home, ['close', 'abc', 'x']).code, 1, 'an id too short is refused');
    assert.equal(parley(home, ['close', id, 'red']).code, 0);
    assert.doesNotMatch(parley(home, ['read']).out, /Open questions/, 'closed: no longer open');
    data = host.read();
    assert.equal(data.waiting, 0);
    assert.deepEqual(data.messages.find((m) => m.kind === 'ask').closed.text, 'red');
    const person = data.messages.find((m) => m.from === 'person');
    assert.equal(person.seen, true); assert.ok(person.seenAt, 'when it was read');
    const words = texts('en');
    let v = view(data, { words });
    assert.equal(v.items.find((i) => i.kind === 'ask').closed, 'Answer given later: red');
    assert.equal(v.items.find((i) => i.kind === 'ask').open, false);
    assert.equal(v.items.find((i) => i.from === 'person').state, 'read', 'read, not answered yet');
    parley(home, ['doing', 'painting it red']);
    v = view(host.read(), { words });
    assert.equal(v.items.find((i) => i.from === 'person').state, 'working', 'worked on');
    parley(home, ['tell', 'Done: red.']);
    v = view(host.read(), { words });
    assert.equal(v.items.find((i) => i.from === 'person').state, 'done', 'handled: it answered after reading');
    assert.equal(v.items.find((i) => i.from === 'person').sign, '', 'simple: nothing said of what is handled');
    assert.equal(view(host.read(), { words, view: 'detailed' }).items.find((i) => i.from === 'person').sign, 'done', 'detailed: said of all');
    /* The person answers the closed question with its buttons all the same: their answer is the one. */
    host.say('blue', data.messages.find((m) => m.kind === 'ask').id);
    v = view(host.read(), { words });
    assert.equal(v.items.find((i) => i.kind === 'ask').closed, '');
    assert.match(v.items.at(-1).reply, /^In reply to: Blue or red\?/);
});

test('alone: what it does now stays while the person writes; busy, said; "Remind it" only when it seems idle; waiting said once', () => {
    const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
    const words = texts('en');
    const data = { messages: [{ from: 'agent', id: 'a', at: at(0), kind: 'say', text: 'On it.' }, { from: 'person', id: 'p', at: at(3), kind: 'say', text: 'Also this', seen: false }],
        steps: [{ id: 's1', kind: 'doing', state: 'working', note: 'running the tests', at: at(2) }], status: { state: 'working', at: at(1), note: '' } };
    let v = view(data, { words, now: Date.parse(at(4)) });
    assert.equal(v.rows.at(-1).type, 'now', 'a message of the person does not take it away');
    assert.equal(v.rows.at(-1).text, 'Busy: running the tests - your messages wait for it');
    assert.equal(v.items.at(-1).remind, false, 'it works: no "Remind it"');
    v = view({ ...data, steps: [{ ...data.steps[0], at: at(4) }] }, { words, now: Date.parse(at(3)) + IDLE_MS + 1000 });
    assert.equal(v.items.at(-1).remind, false, 'it did something less than two minutes before');
    v = view({ ...data, steps: [] }, { words, now: Date.parse(at(3)) + IDLE_MS + 1000 });
    assert.equal(v.items.at(-1).remind, true, 'unread, and it seems idle');
    /* Its next message takes the line away. */
    v = view({ ...data, messages: [...data.messages, { from: 'agent', id: 'b', at: at(5), kind: 'say', text: 'Tests pass.' }] }, { words, now: Date.parse(at(6)) });
    assert.equal(v.rows.some((r) => r.type === 'now'), false);
    assert.match(pastedName({ name: 'image.png', type: 'image/png' }, new Date(2030, 0, 2, 3, 4, 5)), /^screenshot-2030-01-02-030405\.png$/);
    assert.equal(pastedName({ name: 'plan.pdf', type: 'application/pdf' }), 'plan.pdf');
});

test('alone, on a page: lines of the application by their neutral level; a run of news is one line; the one question waiting is answered by what is typed', async (t) => {
    const leave = fakePage();
    const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
    const root = document.createElement('div');
    document.body.append(root);
    const sent = [];
    const messages = [
        { from: 'agent', id: 'q', at: at(0), kind: 'ask', text: 'Which day?', choices: [] },
        { from: 'system', id: 'n1', at: at(1), text: 'Published: a', level: 'news', topic: 'Published', brief: 'a' },
        { from: 'system', id: 'n2', at: at(2), text: 'Published: b', level: 'news', topic: 'Published', brief: 'b' },
        { from: 'system', id: 't1', at: at(3), text: 'Checked the time', level: 'trace' },
        { from: 'system', id: 'u1', at: at(4), text: 'Something needs you', level: 'needs-you', tone: 'bad', actions: [{ id: 'fix', label: 'Fix' }] },
    ];
    const acted = [];
    let as = 'simple';
    const handle = mount(root, { load: async () => ({ messages }), send: async (text, answers) => { sent.push([text, answers]); }, words: texts('en'), every: 0, touch: false, act: (id) => acted.push(id), onView: (x) => { as = x; } });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const lines = () => root.querySelectorAll('.parley-system').filter((l) => !l.closest('.parley-group-lines') || !l.closest('.parley-group-lines').hidden);
    assert.equal(root.querySelector('.parley-group-line').textContent.startsWith('Published (2): a, b'), true, 'news of one topic: one compact line');
    assert.deepEqual(lines().map((l) => l.dataset.level), ['needs-you'], 'simple: the trace is not there, the news folded into one line');
    root.querySelector('.parley-act').click();
    assert.deepEqual(acted, ['fix']);
    /* The one question waiting: what is typed answers it, unless the tag is taken away. */
    assert.match(root.querySelector('.parley-replying').textContent, /In reply to: Which day\?/);
    const box = root.querySelector('.parley-box');
    box.value = 'Tuesday';
    root.querySelector('.parley-form').requestSubmit();
    await settle();
    assert.deepEqual(sent, [['Tuesday', 'q']]);
    /* The detailed view: every line, the trace too. */
    root.querySelectorAll('button[data-view]').find((b) => b.dataset.view === 'detailed').click();
    await settle(); await settle();
    assert.equal(as, 'detailed');
    assert.deepEqual(root.querySelectorAll('.parley-system').map((l) => l.dataset.level), ['news', 'news', 'trace', 'needs-you']);
});

test('alone: a short version longer than a title is kept whole, for the screen to cut', (t) => {
    const home = mkdtempSync(join(tmpdir(), 'parley-short-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    install(join(home, '.parley'));
    const short = `${'word '.repeat(80)}end`.trim();
    assert.equal(parley(home, ['tell', '--short', short, 'Long text.']).code, 0);
    assert.equal(new Parley(join(home, '.parley')).read().messages.at(-1).short, short);
});
