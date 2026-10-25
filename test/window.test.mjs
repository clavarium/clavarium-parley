import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, Parley, texts, WINDOW, LEAST, CONTEXT, reread, REREAD } from '../host/parley-host.mjs';
import { mount, since, earlier, windowOf } from '../ui/parley-ui.js';
import { bridge } from '../server/parley-mcp.mjs';
import { run } from '../bin/parley.mjs';
import { fakePage } from './fake-dom.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const settle = () => new Promise((r) => setImmediate(r));
const T0 = Date.parse('2026-03-01T08:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const id = (side, i) => `${side}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;

/* A thread of `n` messages, one a minute, the agent and the person in turn, a step before each of the agent's. */
function thread(t, n, { keep = false, gap = 1, steps = true } = {}) {
    const dir = join(folder(t), '.parley');
    install(dir);
    const agent = []; const person = [];
    for (let i = 0; i < n; i += 1) {
        if (i % 2 === 0) {
            if (steps) agent.push({ id: id('d', i), at: iso(i * gap - 0.5), kind: 'doing', text: `step ${i}` });
            agent.push({ id: id('a', i), at: iso(i * gap), kind: 'say', text: `**Agent** message ${i}` });
        } else person.push({ id: id('p', i), at: iso(i * gap), text: `Person message ${i}` });
    }
    writeFileSync(join(dir, 'from-agent.jsonl'), agent.map((x) => `${JSON.stringify(x)}\n`).join(''));
    writeFileSync(join(dir, 'to-agent.jsonl'), person.map((x) => `${JSON.stringify(x)}\n`).join(''));
    const kept = keep ? join(folder(t), 'kept') : undefined;
    const host = (more = {}) => new Parley(dir, { ...(kept ? { keep: kept } : {}), now: () => new Date(T0 + n * gap * 60_000), ...more });
    const post = (line) => appendFileSync(join(dir, 'from-agent.jsonl'), `${JSON.stringify(line)}\n`);
    return { dir, host, post, kept };
}
const numbers = (r) => r.messages.map((m) => Number(/(\d+)$/.exec(m.text)?.[1]));

for (const keep of [false, true]) {
    const how = keep ? 'with a keep folder' : 'without a keep folder';

    test(`the end of the thread, then the page before it, as far back as it goes; the files on disk stay whole (${how})`, (t) => {
        const { dir, host } = thread(t, 600, { keep });
        const before = readFileSync(join(dir, 'from-agent.jsonl'), 'utf8');
        const first = host().read({ last: 200 });
        assert.equal(first.messages.length, 200);
        assert.deepEqual([numbers(first)[0], numbers(first).at(-1)], [400, 599]);
        assert.deepEqual({ ...first.window, before: typeof first.window.before }, { before: 'string', more: 400, total: 600, from: iso(400), until: null });
        assert.equal(first.steps.every((s) => s.at >= iso(400)), true, 'the steps of the window only');
        assert.equal(typeof first.cursor, 'string');
        const second = host().read({ last: 200, before: first.window.before });
        assert.deepEqual([numbers(second)[0], numbers(second).at(-1), second.window.more, second.window.until], [200, 399, 200, iso(400)]);
        assert.equal(second.steps.every((s) => s.at >= iso(200) && s.at < iso(400)), true);
        const third = host().read({ last: 200, before: second.window.before });
        assert.deepEqual([numbers(third)[0], numbers(third).at(-1), third.window.more, third.window.before], [0, 199, 0, null], 'the start: nothing before it');
        assert.equal(readFileSync(join(dir, 'from-agent.jsonl'), 'utf8'), before, 'nothing written, nothing taken');
        /* Without options, as it always was: the newest SHOWN_MAX, no window, no cursor. */
        const old = host().read();
        assert.equal(old.messages.length, 200);
        assert.equal('window' in old || 'cursor' in old, false);
        assert.deepEqual(old.messages.map((m) => m.id), first.messages.map((m) => m.id));
        assert.equal(WINDOW, 200);
        assert.equal(host().read({ last: 50 }).messages.length, 50);
    });

    test(`what changed since a cursor, and only that: new messages, those read, reacted to, closed; new steps (${how})`, (t) => {
        const { dir, host, post } = thread(t, 300, { keep });
        bridge(dir).read();
        const first = host().read({ last: 100 });
        const nothing = host().read({ last: 100, since: first.cursor });
        assert.deepEqual([nothing.since, nothing.messages, nothing.steps, nothing.cursor], [true, [], [], first.cursor]);
        assert.ok(JSON.stringify(nothing).length < 300, 'a look with nothing new is small');
        /* The agent says something, and a step. */
        post({ id: 'n1', at: iso(400), kind: 'doing', text: 'writing' });
        post({ id: 'n2', at: iso(401), kind: 'ask', text: 'Blue or green?', choices: ['blue', 'green'] });
        const one = host().read({ last: 100, since: first.cursor });
        assert.deepEqual(one.messages.map((m) => m.id), ['n2']);
        assert.deepEqual(one.steps.map((s) => s.id), ['n1']);
        assert.equal(one.waiting, 1);
        assert.ok(Array.isArray(one.files), 'the files, when the agent posted');
        /* The person answers; the agent reads: what was not read is given again, read. */
        host().say('blue', 'n2');
        const two = host().read({ last: 100, since: one.cursor });
        assert.deepEqual(two.messages.map((m) => [m.text, m.seen]), [['blue', false]]);
        assert.equal(two.unread, 1);
        assert.equal('files' in two, false, 'nothing posted by the agent: its files are not sent again');
        bridge(dir).read();
        const three = host().read({ last: 100, since: two.cursor });
        assert.deepEqual(three.messages.map((m) => [m.text, m.seen]), [['blue', true]]);
        assert.equal(three.unread, 0);
        /* A reaction to an old message of the agent, out of the window: that message, again, with it. */
        host().react(id('a', 10), 'agree');
        const four = host().read({ last: 100, since: three.cursor });
        assert.deepEqual(four.messages.map((m) => [m.id, m.reaction?.id]), [[id('a', 10), 'agree']]);
        /* A question closed: given again, closed. */
        post({ id: 'n3', at: iso(402), kind: 'ask', text: 'Today?' });
        const five = host().read({ last: 100, since: four.cursor });
        post({ id: 'n4', at: iso(403), kind: 'close', answers: 'n3', text: 'yes, today' });
        const six = host().read({ last: 100, since: five.cursor });
        assert.deepEqual(six.messages.map((m) => [m.id, m.closed?.text]), [['n3', 'yes, today']]);
        assert.equal(six.waiting, 0);
        /* A cursor that is not one: the window again. */
        const lost = host().read({ last: 100, since: 'nonsense' });
        assert.equal(lost.since, undefined);
        assert.equal(lost.messages.length, 100);
    });

    test(`a question still open is given with the newest window however old, and counted; the status and the unread are the whole thread's (${how})`, (t) => {
        const { dir, host } = thread(t, 400, { keep, steps: false });
        const lines = readFileSync(join(dir, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean);
        lines.splice(3, 0, JSON.stringify({ id: 'old-q', at: iso(2.5), kind: 'ask', text: 'Which database?', choices: ['A', 'B'] }), JSON.stringify({ id: 'old-s', at: iso(2.6), kind: 'status', state: 'waiting', text: 'your choice' }));
        writeFileSync(join(dir, 'from-agent.jsonl'), lines.map((l) => `${l}\n`).join(''));
        const r = host().read({ last: 50 });
        assert.equal(r.messages.length, 51);
        assert.equal(r.messages[0].id, 'old-q', 'first: it is the oldest');
        assert.equal(r.window.more, 351, 'the window itself is not counted with it');
        assert.equal(r.waiting, 1);
        assert.equal(r.unread, 200, 'the agent read nothing yet: all of the person\'s');
        assert.equal(r.status.state, 'waiting');
        /* Answered, it is no longer brought. */
        host().say('A', 'old-q');
        assert.equal(host().read({ last: 50 }).messages.some((m) => m.id === 'old-q'), false);
    });
}

test('a window of days: those of the last days, a few at least, and the days before it, page after page', (t) => {
    /* One message an hour: 24 a day. */
    const { host } = thread(t, 24 * 10, { gap: 60 });
    const r = host().read({ days: 2 });
    assert.equal(r.messages.length, 48);
    assert.equal(r.messages[0].at >= iso((240 - 48) * 60), true);
    const back = host().read({ days: 2, before: r.window.before });
    assert.equal(back.messages.length, 48);
    assert.equal(back.window.until, r.window.from);
    /* A quiet week: still the newest few. */
    const quiet = thread(t, 40, { gap: 60 * 24 * 3 });
    assert.equal(quiet.host().read({ days: 1 }).messages.length, LEAST);
});

test('up to a message found: from it (a few before it) to what is shown, at once', (t) => {
    const { host } = thread(t, 600);
    const first = host().read({ last: 200 });
    const page = host().read({ before: first.window.before, from: id('p', 101) });
    assert.deepEqual([numbers(page)[0], numbers(page).at(-1)], [101 - CONTEXT, 399]);
    assert.equal(page.window.more, 101 - CONTEXT);
});

test('the whole thread searched, however little is shown: newest first, its words around, Markdown aside', (t) => {
    const { host } = thread(t, 600);
    const found = host().search('agent message 12');
    assert.deepEqual(found.matches.map((m) => m.id), [id('a', 128), id('a', 126), id('a', 124), id('a', 122), id('a', 120), id('a', 12)]);
    assert.equal(found.count, 6);
    assert.equal(found.matches.at(-1).text, 'Agent message 12');
    assert.equal(host().search('PERSON MESSAGE 1').count, 56);
    assert.equal(host().search('Person', { limit: 5 }).matches.length, 5);
    assert.deepEqual(host().search('   '), { matches: [], count: 0 });
});

test('without a keep folder, a bridge file rewritten shorter gives the window again', (t) => {
    const { dir, host } = thread(t, 100);
    const first = host().read({ last: 20 });
    const lines = readFileSync(join(dir, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean);
    writeFileSync(join(dir, 'from-agent.jsonl'), lines.slice(0, 10).map((l) => `${l}\n`).join(''));
    const again = host().read({ last: 20, since: first.cursor });
    assert.equal(again.since, undefined);
    assert.ok(again.window);
});

test('with a keep folder, the copy is the thread: a line the agent rewrote is not new, and is said once', (t) => {
    const { dir, host } = thread(t, 100, { keep: true });
    const first = host().read({ last: 20 });
    const file = join(dir, 'from-agent.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('**Agent** message 98', 'forged'));
    const after = host().read({ last: 20, since: first.cursor });
    assert.equal(after.since, true);
    assert.deepEqual(after.messages, [], 'nothing new: what was kept is still what is shown');
    assert.deepEqual(after.altered.map((a) => a.kind), ['changed']);
    assert.equal(host().read({ last: 20 }).messages.some((m) => m.text === 'forged'), false);
});

test('the agent reads the end after a restart, and further back page after page: never cut, never summarised', (t) => {
    const work = folder(t);
    const dir = join(work, '.parley');
    install(dir);
    const host = new Parley(dir);
    for (let i = 0; i < 12; i += 1) host.say(`note ${i}`);
    const cmd = (...args) => run(args, { env: { PARLEY_DIR: '' }, cwd: work });
    const end = cmd('read', '--last', '5');
    assert.equal(end.code, 0, end.err);
    const lines = end.out.split('\n');
    assert.equal(lines[0], 'The end of the exchange with the person, oldest first (the newest 5 of 12):');
    assert.deepEqual(lines.slice(1, 6).map((l) => l.replace(/^\[[^\]]+\] /, '')), [7, 8, 9, 10, 11].map((i) => `They wrote: note ${i} (new)`));
    const more = /^Older: 7 more before these\. To read them: parley read --before ([0-9a-f]{8})$/.exec(lines[6]);
    assert.ok(more, lines[6]);
    const back = cmd('read', '--before', more[1], '--last', '5').out.split('\n');
    assert.equal(back[0], 'An earlier part of the exchange with the person, oldest first (5, 5 newer after them):');
    assert.deepEqual(back.slice(1, 6).map((l) => l.replace(/^\[[^\]]+\] /, '')), [2, 3, 4, 5, 6].map((i) => `They wrote: note ${i}`), 'read already: no longer new');
    const start = cmd('read', '--before', /--before ([0-9a-f]{8})/.exec(back[6])[1]).out.split('\n');
    assert.deepEqual(start.slice(1, 3).map((l) => l.replace(/^\[[^\]]+\] /, '')), ['They wrote: note 0', 'They wrote: note 1']);
    assert.equal(start[3], 'Nothing older: this is the start of the exchange.');
    assert.equal(cmd('read', '--days', '3').code, 0);
    assert.equal(cmd('read', '--last', 'many').code, 64);
    assert.equal(cmd('read', '--last', '3', '--days', '2').code, 64);
    assert.equal(cmd('read', '--before', 'ffffffff').code, 1);
    /* Through MCP: how to go further back is said its way. */
    assert.match(bridge(dir, { how: 'call read', back: (x) => `call read with before: "${x}"` }).read({ last: 3 }), /To read them: call read with before: "[0-9a-f]{8}"/);
    assert.equal(REREAD, reread({ last: 100 }));
    assert.match(reread({ days: 2 }), /run "parley read --days 2" before going on; it says how to read further back\./);
    assert.doesNotMatch(reread({ days: 2 }), /['`]/, 'nothing a shell would run');
});

test('what changed is put into what is shown; a page before it is put before it, its cursor kept', () => {
    const base = { messages: [{ from: 'agent', id: 'b', at: '2', text: 'two' }, { from: 'person', id: 'c', at: '3', text: 'three', seen: false }], steps: [{ id: 's1', at: '2' }], window: { before: 'b', more: 1, from: '2' }, cursor: '1.1.0', unread: 1 };
    const next = since(base, { since: true, messages: [{ from: 'person', id: 'c', at: '3', text: 'three', seen: true }, { from: 'agent', id: 'd', at: '4', text: 'four' }, { from: 'agent', id: 'z', at: '0', text: 'older than what is shown' }], steps: [{ id: 's2', at: '4' }], cursor: '2.1.1', unread: 0 });
    assert.deepEqual(next.messages.map((m) => [m.id, m.seen]), [['b', undefined], ['c', true], ['d', undefined]]);
    assert.deepEqual(next.steps.map((s) => s.id), ['s1', 's2']);
    assert.deepEqual([next.cursor, next.unread, next.window.more], ['2.1.1', 0, 1]);
    assert.equal(since(base, { messages: [] }).messages.length, 0, 'no `since`: taken whole, as before');
    const both = earlier(next, { messages: [{ from: 'agent', id: 'a', at: '1', text: 'one' }], steps: [{ id: 's0', at: '1' }], window: { before: null, more: 0, from: '1' }, cursor: '9.9.9' });
    assert.deepEqual(both.messages.map((m) => m.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual([both.cursor, both.window.more, both.window.before, both.window.from], ['2.1.1', 0, null, '1']);
    assert.deepEqual([windowOf({ days: 3 }), windowOf({ messages: 500 }), windowOf()], [{ days: 3 }, { last: 500 }, { last: 200 }]);
});

test('the screen asks for its window, then only what changed; "Earlier messages" brings the page before; an application without a cursor is read whole, as before', async (t) => {
    const { host, post } = thread(t, 450);
    const leave = fakePage();
    const mounted = [];
    t.after(() => { for (const h of mounted) h.destroy(); leave(); });
    const asked = [];
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async (o) => { asked.push(o); return host().read(o); }, send: async () => {}, words: texts('fr'), every: 0, touch: false, window: { messages: 100 } });
    mounted.push(handle);
    await settle();
    assert.deepEqual(asked, [{ last: 100 }]);
    const said = () => root.querySelectorAll('.parley-said').length;
    assert.equal(said(), 100);
    const more = root.querySelector('.parley-earlier');
    assert.equal(more.textContent, 'Messages plus anciens');
    post({ id: 'new', at: iso(1000), kind: 'say', text: 'Fresh.' });
    await handle.refresh();
    assert.equal(asked.at(-1).since !== undefined, true, 'a look asks for what changed');
    assert.equal(said(), 101);
    more.click();
    await settle(); await settle();
    assert.equal(asked.at(-1).before !== undefined, true);
    assert.equal(said(), 201);
    /* The cursor kept: the next look is still only what changed. */
    await handle.refresh();
    assert.equal(said(), 201);
    /* Back to the start: no button. */
    for (let i = 0; i < 4 && root.querySelector('.parley-earlier'); i += 1) { root.querySelector('.parley-earlier').click(); await settle(); await settle(); }
    assert.equal(said(), 451);
    assert.equal(root.querySelector('.parley-earlier'), null);
    /* An application that gives all, with no cursor: read whole at every look, no button. */
    const old = document.createElement('div');
    document.body.append(old);
    const calls = [];
    const plain = mount(old, { load: async (o) => { calls.push(o); return host().read(); }, send: async () => {}, words: texts('en'), every: 0, touch: false });
    mounted.push(plain);
    await settle();
    await plain.refresh();
    assert.deepEqual(calls, [{ last: 200 }, { last: 200 }]);
    assert.equal(old.querySelector('.parley-earlier'), null);
});

test('the search finds what is further back than what is shown, and opens it at its place', async (t) => {
    const { host } = thread(t, 450);
    const leave = fakePage();
    const mounted = [];
    t.after(() => { for (const h of mounted) h.destroy(); leave(); });
    const asked = [];
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async (o) => { asked.push(o); return host().read(o); }, search: async (q) => host().search(q), send: async () => {}, words: texts('en'), every: 0, touch: false, window: { messages: 50 } });
    mounted.push(handle);
    await settle();
    handle.search();
    const box = root.querySelector('.parley-search-box');
    box.value = 'Person message 121';
    box.dispatchEvent({ type: 'input', bubbles: true });
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 5; i += 1) await settle();
    assert.equal(asked.at(-1).from, id('p', 121), 'the part up to it asked for');
    assert.ok(root.querySelectorAll('.parley-said').some((b) => b.dataset.id === id('p', 121)), 'there, in the thread');
    assert.equal(root.querySelector('.parley-search-count').textContent, '1 of 1');
});

test('reveal shows one message: its id or its first 8 characters; further back, the pages before it are brought until it is there', async (t) => {
    const { host } = thread(t, 450);
    const leave = fakePage();
    const mounted = [];
    t.after(() => { for (const h of mounted) h.destroy(); leave(); });
    const asked = [];
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async (o) => { asked.push(o); return host().read(o); }, send: async () => {}, words: texts('en'), every: 0, touch: false, window: { messages: 50 } });
    mounted.push(handle);
    /* Called before the first look came: it waits for it. */
    const shownNow = handle.reveal(id('a', 440));
    assert.equal(await shownNow, true);
    assert.equal(asked.length, 1, 'shown already: nothing more asked');
    const mark = (key) => root.querySelectorAll('.parley-said').find((b) => b.dataset.id === key);
    assert.equal(mark(id('a', 440)).dataset.found, 'true', 'marked a moment');
    /* Further back: page after page, until it is there. */
    assert.equal(await handle.reveal(id('p', 121).slice(0, 8)), true);
    assert.equal(asked.slice(1).every((o) => typeof o.before === 'string' && o.from === undefined), true, 'the pages before, one after the other');
    assert.equal(asked.length, 1 + Math.ceil((450 - 50 - 121) / 50), 'no further than needed');
    assert.equal(mark(id('p', 121)).dataset.found, 'true');
    /* Unknown, or too short to point to one: not shown, and said so. */
    assert.equal(await handle.reveal('zzzzzzzz'), false);
    assert.equal(root.querySelector('.parley-earlier'), null, 'looked for as far back as it goes');
    assert.equal(await handle.reveal(id('a', 2).slice(0, 7)), false);
    assert.equal(await handle.reveal(null), false);
    assert.equal(await handle.reveal(id('a', 2)), true, 'the whole id');
});
