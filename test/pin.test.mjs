import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { install, Parley, PINS_MAX } from '../host/parley-host.mjs';
import { run, HELP } from '../bin/parley.mjs';
import { bridge, serve, TOOLS } from '../server/parley-mcp.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const rows = (dir, name) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const posted = (dir) => rows(dir, 'from-agent.jsonl');
/* Each side writes its own time: a few milliseconds between two steps keep their order. */
const later = () => new Promise((r) => setTimeout(r, 3));
const until = async (what, check, ms = 3000) => { const end = Date.now() + ms; for (;;) { if (check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => setTimeout(r, 10)); } };

test('the person pins a message of either side, and unpins it: kept at the top, no message in the thread, told to the agent and to the application', async (t) => {
    const dir = join(folder(t), '.parley'); install(dir);
    const agent = bridge(dir);
    agent.tell('We keep the logs 30 days: that is the rule from now on.');
    const mine = posted(dir)[0].id;
    const told = [];
    const parley = new Parley(dir, { on: (e) => told.push(e) });
    await later();
    parley.say('The staging server is at https://staging.example.com');
    const theirs = parley.read().messages.find((m) => m.from === 'person').id;
    agent.read();
    await later();
    let read = parley.pin(mine);
    assert.equal(told.at(-1).type, 'person-pinned');
    assert.equal(told.at(-1).on, true);
    assert.equal(told.at(-1).unread, 1, 'the agent has not read it yet');
    assert.deepEqual(Object.keys(told.at(-1).message).sort(), ['at', 'id', 'pin', 'quote', 'text', 'toAt']);
    assert.equal(told.at(-1).message.pin, mine); assert.equal(told.at(-1).message.text, '');
    assert.equal(read.pins.length, 1);
    const [p] = read.pins;
    assert.deepEqual({ id: p.id, by: p.by, from: p.from, text: p.text }, { id: mine, by: 'person', from: 'agent', text: 'We keep the logs 30 days: that is the rule from now on.' });
    assert.ok(p.at >= p.toAt, 'when it was pinned, after the message');
    assert.equal(read.messages.length, 2, 'a pin is no message');
    assert.match(agent.read(), /They pinned your message of \d{4}-\d\d-\d\d \d\d:\d\d "We keep the logs 30 days/);
    await later();
    read = parley.pin(theirs, true);
    assert.deepEqual(read.pins.map((x) => [x.from, x.by]), [['agent', 'person'], ['person', 'person']], 'oldest first; their own message too');
    assert.match(agent.read(), /They pinned their message .*"The staging server is at https:\/\/staging\.example\.com"/);
    const lines = rows(dir, 'to-agent.jsonl').length;
    parley.pin(theirs);
    assert.equal(rows(dir, 'to-agent.jsonl').length, lines, 'pinned again while it stands: nothing written');
    await later();
    read = parley.pin(mine, false);
    assert.equal(told.at(-1).on, false); assert.equal(told.at(-1).message.removed, true);
    assert.deepEqual(read.pins.map((x) => x.id), [theirs], 'unpinned: it left');
    assert.match(agent.read(), /They unpinned your message/);
    parley.pin(mine, false);
    assert.equal(rows(dir, 'to-agent.jsonl').length, lines + 1, 'unpinned when not pinned: nothing written');
    assert.throws(() => parley.pin('nope'), /No such message/);
    assert.deepEqual(parley.read({ last: 50 }).pins.map((x) => x.id), [theirs], 'every part of the thread gives the pins');
    assert.equal(parley.read({ last: 50 }).messages.length, 2);
});

test('the agent pins and unpins: by the id read shows, an unknown one refused; the application hears agent-pinned; no message in the thread', async (t) => {
    const dir = join(folder(t), '.parley'); install(dir);
    const agent = bridge(dir);
    const told = [];
    const parley = new Parley(dir, { on: (e) => told.push(e) });
    const stop = parley.listen({ every: 10 });
    t.after(stop);
    parley.say('Never deploy on a Friday.');
    const rule = parley.read().messages[0].id;
    await later();
    assert.match(agent.pin(rule.slice(0, 8)), /^Pinned: it stays at the top of their chat/);
    await until('agent-pinned', () => told.some((e) => e.type === 'agent-pinned'));
    const e = told.find((x) => x.type === 'agent-pinned');
    assert.equal(e.message.pin, rule); assert.equal(e.message.removed, undefined);
    let read = parley.read();
    assert.deepEqual(read.pins.map((x) => [x.id, x.by, x.from, x.text]), [[rule, 'agent', 'person', 'Never deploy on a Friday.']]);
    assert.equal(read.messages.length, 1, 'a pin of the agent is no message either');
    assert.match(agent.pin(rule), /pinned already/);
    assert.throws(() => agent.pin('00000000-dead'), /no message has the id 00000000-dead/);
    assert.throws(() => agent.pin('abc'), /8 characters at least/);
    await later();
    assert.match(agent.pin(rule, { off: true }), /^Unpinned/);
    await until('agent-pinned, removed', () => told.some((x) => x.type === 'agent-pinned' && x.message.removed === true));
    assert.deepEqual(parley.read().pins, []);
    assert.match(agent.pin(rule, { off: true }), /not pinned/);
});

test(`${PINS_MAX} pins at most: a new one makes the oldest leave; a message that is not there any more is skipped`, async (t) => {
    const dir = join(folder(t), '.parley'); install(dir);
    const agent = bridge(dir);
    for (let i = 1; i <= 7; i += 1) agent.tell(`Rule ${i}`);
    const ids = posted(dir).map((m) => m.id);
    const parley = new Parley(dir);
    for (const id of ids.slice(0, 5)) { await later(); parley.pin(id); }
    assert.deepEqual(parley.read().pins.map((x) => x.text), ['Rule 1', 'Rule 2', 'Rule 3', 'Rule 4', 'Rule 5']);
    await later();
    assert.match(agent.pin(ids[5]), /5 at most: the oldest pin left \("Rule 1"\)/);
    assert.deepEqual(parley.read().pins.map((x) => x.text), ['Rule 2', 'Rule 3', 'Rule 4', 'Rule 5', 'Rule 6']);
    await later();
    parley.pin(ids[6]);
    assert.deepEqual(parley.read().pins.map((x) => [x.text, x.by]), [['Rule 3', 'person'], ['Rule 4', 'person'], ['Rule 5', 'person'], ['Rule 6', 'agent'], ['Rule 7', 'person']]);
    /* Unpinning one does not bring back one that left. */
    await later();
    parley.pin(ids[3], false);
    assert.deepEqual(parley.read().pins.map((x) => x.text), ['Rule 3', 'Rule 5', 'Rule 6', 'Rule 7']);
    /* A pin of a message that is not there (a bridge file rewritten): skipped, on both sides. */
    appendFileSync(join(dir, 'to-agent.jsonl'), `${JSON.stringify({ id: 'x1', at: new Date(Date.now() + 1000).toISOString(), text: '', pin: 'gone-message-id', quote: 'gone', toAt: '2026-01-01T00:00:00.000Z' })}\n`);
    assert.deepEqual(parley.read().pins.map((x) => x.text), ['Rule 3', 'Rule 5', 'Rule 6', 'Rule 7']);
    assert.match(agent.read({ last: 50 }), /^Pinned \(4\):\n/);
    assert.equal(parley.read().messages.length, 7, 'no pin line in the thread');
});

test('read with last or days gives the pins first; a plain read does not; the command and the MCP tool', async (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    const agent = bridge(dir);
    agent.tell('Decision: we ship on Tuesdays.');
    const decision = posted(dir)[0].id;
    const parley = new Parley(dir);
    await later();
    parley.say('Use the docs at https://docs.example.com');
    const link = parley.read().messages.find((m) => m.from === 'person').id;
    await later();
    parley.pin(link);
    await later();
    const r = run(['pin', decision.slice(0, 8)], { cwd: home, env: {} });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /^Pinned/);
    assert.equal(run(['pin'], { cwd: home, env: {} }).code, 64);
    assert.equal(run(['pin', 'zzzzzzzz'], { cwd: home, env: {} }).code, 1, 'an unknown id is refused');
    assert.match(HELP, /parley pin ID \[--off\]/);
    const fresh = agent.read();
    assert.doesNotMatch(fresh, /Pinned \(/, 'new messages only: no pinned block');
    assert.match(fresh, /They pinned their message/);
    for (const how of [{ last: 10 }, { days: 2 }]) {
        const back = agent.read(how);
        assert.match(back, /^Pinned \(2\):\n {2}\[\d{4}-\d\d-\d\d \d\d:\d\d [0-9a-f]{8}\] theirs, pinned by them: Use the docs at https:\/\/docs\.example\.com\n {2}\[[^\]]+\] yours, pinned by you: Decision: we ship on Tuesdays\.\n\nThe /, JSON.stringify(how));
    }
    assert.doesNotMatch(agent.read({ last: 10, before: link.slice(0, 8) }), /Pinned \(/, 'an earlier page: no pinned block again');
    const cli = run(['read', '--last', '20'], { cwd: home, env: {} });
    assert.match(cli.out, /^Pinned \(2\):/);
    assert.equal(run(['pin', decision.slice(0, 8), '--off'], { cwd: home, env: {} }).code, 0);
    assert.deepEqual(parley.read().pins.map((x) => x.id), [link]);
    /* The MCP tool: the same verb, an unknown id said as not done. */
    const tool = TOOLS.find((x) => x.name === 'pin');
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.match(tool.description, /^Pin a message of the exchange \(yours or theirs\)/);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    serve(dir, { input, output });
    const call = (id, args) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pin', arguments: args } })}\n`);
    call(1, { id: decision });
    call(2, { id: 'ffffffff-0000' });
    call(3, { id: link, off: true });
    input.end();
    await until('three replies', () => out.trim().split('\n').length === 3);
    const replies = out.trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
    assert.match(replies[0].result.content[0].text, /^Pinned/);
    assert.equal(replies[1].result.isError, true); assert.match(replies[1].result.content[0].text, /no message has the id/);
    assert.match(replies[2].result.content[0].text, /^Unpinned/);
    assert.deepEqual(parley.read().pins.map((x) => [x.id, x.by]), [[decision, 'agent']]);
});
