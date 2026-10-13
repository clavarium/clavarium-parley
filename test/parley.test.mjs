import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, Parley, watch, byCommand, INVITE, ARRIVED } from '../host/parley-host.mjs';
import { view, PROFILES } from '../ui/parley-ui.js';

const SERVER = fileURLToPath(new URL('../server/parley-mcp.mjs', import.meta.url));
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

/* Speaks MCP to the agent's side as an agent would: one JSON message per line. */
async function agent(dir, calls, script = SERVER) {
    const child = spawn(process.execPath, [script, '--dir', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    calls.forEach((c, i) => send({ jsonrpc: '2.0', id: i + 1, ...c }));
    child.stdin.end();
    await new Promise((done) => child.on('close', done));
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const tool = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args } });
const said = (reply) => reply.result.content[0].text;

test('the agent\'s side speaks MCP and has five verbs, no more', async (t) => {
    const dir = folder(t);
    const replies = await agent(dir, [{ method: 'tools/list' }, { method: 'ping' }, { method: 'resources/list' }, tool('launch')]);
    assert.equal(replies[0].result.serverInfo.name, 'parley'); assert.deepEqual(replies[0].result.capabilities, { tools: {} });
    assert.deepEqual(replies[1].result.tools.map((x) => x.name), ['tell', 'ask', 'show', 'read', 'status']);
    assert.ok(replies[1].result.tools.every((x) => x.inputSchema.type === 'object' && x.description.length > 20));
    assert.deepEqual(replies[2].result, {});
    assert.equal(replies[3].error.code, -32601);
    assert.equal(replies[4].result.isError, true);
    assert.equal(replies.length, 5, 'a notification is not answered');
});

test('install puts the bridge in a folder and says how it is declared to an agent', (t) => {
    const dir = folder(t);
    assert.deepEqual(install(join(dir, 'b'), { as: '/work/.parley' }), { name: 'parley', command: ['node', '/work/.parley/server.mjs'] });
    assert.equal(readFileSync(join(dir, 'b', 'server.mjs'), 'utf8'), readFileSync(SERVER, 'utf8'));
    writeFileSync(join(dir, 'b', 'to-agent.jsonl'), '{"id":"kept"}\n');
    install(join(dir, 'b'));
    assert.equal(readFileSync(join(dir, 'b', 'to-agent.jsonl'), 'utf8'), '{"id":"kept"}\n', 'installed again, what was said is kept');
});

test('a whole exchange: the agent asks without waiting, the person answers, the agent is told one line and reads once', async (t) => {
    const dir = folder(t);
    install(dir);
    const lines = [];
    const parley = new Parley(dir, { nudge: async (line) => { lines.push(line); return true; } });
    const run = (calls) => agent(dir, calls, join(dir, 'server.mjs'));
    assert.equal(await parley.invite(), true);
    const first = await run([tool('status', { state: 'working', note: 'on the report' }), tool('tell', { text: 'Half written.' }), tool('ask', { question: 'Blue or red cover?', choices: ['blue', 'red'] }), tool('show', { path: '/work/report.html', note: 'The draft.' }), tool('status', { state: 'waiting' }), tool('read')]);
    assert.match(said(first[3]), /Do not wait here/);
    assert.equal(said(first[6]), 'No new message.');
    let seen = parley.read();
    assert.deepEqual(seen.messages.map((m) => [m.from, m.kind, m.text]), [['agent', 'say', 'Half written.'], ['agent', 'ask', 'Blue or red cover?'], ['agent', 'show', 'The draft.']]);
    assert.deepEqual(seen.messages[1].choices, ['blue', 'red']); assert.equal(seen.messages[2].path, '/work/report.html');
    assert.equal(seen.waiting, 1); assert.equal(seen.status.state, 'waiting');
    const answered = await parley.say('blue', seen.messages[1].id);
    assert.equal(answered.told, true); assert.equal(answered.waiting, 0);
    await parley.say('And keep it under two pages.\nThanks.');
    assert.deepEqual(lines, [INVITE, ARRIVED, ARRIVED], 'what the person wrote is never on the line: only that it arrived');
    const second = await run([tool('read'), tool('read')]);
    assert.equal(said(second[1]), 'Answer to your question "Blue or red cover?": blue\nMessage: And keep it under two pages.\nThanks.');
    assert.equal(said(second[2]), 'No new message.', 'read once');
    await assert.rejects(parley.say('   '), /Write something/);
    assert.equal((await new Parley(dir, { nudge: async () => { throw new Error('no terminal'); } }).say('still written')).told, false, 'a line that cannot be delivered does not lose the message');
    assert.match(said((await run([tool('read')]))[1]), /still written/);
    assert.equal((await run([tool('status', { state: 'sleeping' })]))[1].result.isError, true);
});

test('what the agent posts is text chosen by a program: bounded, cleaned, never trusted', (t) => {
    const dir = folder(t);
    install(dir);
    writeFileSync(join(dir, 'from-agent.jsonl'), [
        JSON.stringify({ id: 'a', at: '2026-01-05T06:00:00.000Z', kind: 'say', text: `fine\u001b[31m red‮${'x'.repeat(9000)}` }),
        'this line is not JSON',
        JSON.stringify({ id: 'b', at: '2026-01-05T06:00:01.000Z', kind: 'launch', text: 'unknown kind' }),
        JSON.stringify({ id: 'c', at: '2026-01-05T06:00:02.000Z', kind: 'ask', text: 'q', choices: Array.from({ length: 30 }, (_, i) => `c${i}\n`) }),
        JSON.stringify(['an array, not an object']),
        JSON.stringify({ id: 'd', at: '2026-01-05T06:00:03.000Z', kind: 'status', state: 'exploding' }),
    ].join('\n'));
    const { messages, status } = new Parley(dir).read();
    assert.equal(messages.length, 3);
    assert.equal(messages[0].text.startsWith('fine[31m redx'), true); assert.equal(messages[0].text.length, 4000);
    assert.equal(messages[1].kind, 'say', 'a kind it does not know is shown as something said');
    assert.equal(messages[2].choices.length, 8); assert.equal(messages[2].choices[0], 'c0');
    assert.equal(status.state, 'working', 'a state it does not know is not passed on');
});

test('the two hooks: a line towards the agent by any program, and a call for each thing the agent posts', async (t) => {
    const dir = folder(t);
    install(dir);
    const out = join(dir, 'typed.txt');
    const parley = new Parley(dir, { nudge: byCommand(['sh', '-c', `printf '%s' "$0" > ${out}`]) });
    assert.equal((await parley.say('hello')).told, true);
    assert.equal(readFileSync(out, 'utf8'), ARRIVED);
    assert.equal(await new Parley(dir, { nudge: byCommand(['false']) }).invite(), false);
    await agent(dir, [tool('tell', { text: 'before anyone watched' })], join(dir, 'server.mjs'));
    const heard = [];
    const stop = watch(dir, (m) => heard.push([m.kind, m.text ?? '', m.state ?? '']), { every: 40 });
    t.after(stop);
    await agent(dir, [tool('ask', { question: 'Shall I go on?' }), tool('status', { state: 'waiting' })], join(dir, 'server.mjs'));
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(heard, [['ask', 'Shall I go on?', ''], ['status', '', 'waiting']], 'only what came after, each once');
    stop();
    assert.equal(existsSync(join(dir, 'from-agent.jsonl')), true);
});

test('what the screen shows is decided from the messages alone; a profile changes the words, not the exchange', () => {
    const data = { waiting: 1, status: { state: 'waiting', note: 'on the cover' }, messages: [
        { from: 'agent', id: 'q1', kind: 'ask', text: 'Blue or red?', choices: ['blue', 'red'] },
        { from: 'person', id: 'p1', kind: 'say', text: 'blue', answers: 'q1' },
        { from: 'agent', id: 'q2', kind: 'ask', text: 'One page or two?', choices: ['one', 'two'] },
        { from: 'agent', id: 's1', kind: 'show', text: 'The draft.', path: '/work/report.html' },
        { from: 'agent', id: 't1', kind: 'say', text: '<b>not markup</b>' },
    ] };
    const coding = view(data, PROFILES.coding);
    assert.deepEqual(coding.items.map((i) => [i.from, i.kind, i.open, i.choices.length]), [['agent', 'ask', false, 0], ['person', 'say', false, 0], ['agent', 'ask', true, 2], ['agent', 'show', false, 0], ['agent', 'say', false, 0]]);
    assert.equal(coding.items[3].text, 'The draft. /work/report.html'); assert.equal(coding.items[3].file, '/work/report.html');
    assert.equal(coding.items[4].text, '<b>not markup</b>', 'kept as the text it is');
    assert.equal(coding.status.text, 'waiting - on the cover'); assert.deepEqual(coding.quick, ['Yes, go on', 'Run the tests', 'Summarise']);
    const simple = view(data, PROFILES.simple);
    assert.equal(simple.status, null, 'the simple profile does not show a status'); assert.deepEqual(simple.quick, []);
    assert.deepEqual(simple.items.map((i) => i.text), coding.items.map((i) => i.text), 'the same exchange');
    assert.equal(view({ messages: [] }, PROFILES.simple).empty, 'Nothing yet. Write below.');
    assert.equal(view(undefined).items.length, 0);
    assert.ok(Object.isFrozen(PROFILES) && Object.isFrozen(PROFILES.simple));
});
