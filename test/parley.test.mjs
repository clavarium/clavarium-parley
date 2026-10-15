import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, Parley, WAKE, invitation, languageName, texts, fill, LANGUAGES } from '../host/parley-host.mjs';
import { view, KEYS } from '../ui/parley-ui.js';
import { run, HELP } from '../bin/parley.mjs';
import { findFolder } from '../server/parley-mcp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'server', 'parley-mcp.mjs');
const COMMAND = join(ROOT, 'bin', 'parley.mjs');
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const until = async (what, check, ms = 5000) => { const end = Date.now() + ms; for (;;) { if (check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

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
/* The command, as an agent runs it: in a folder of its own, a new process each time. */
const parley = (cwd, args, input) => { const r = spawnSync(process.execPath, [COMMAND, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, PARLEY_DIR: '' } }); return { code: r.status, out: r.stdout, err: r.stderr }; };

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

test('the command: the same five verbs on the same files, found from where the agent stands', async (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    mkdirSync(join(home, 'deep', 'er'), { recursive: true });
    writeFileSync(join(home, 'report.html'), '<p>draft</p>');
    const here = join(home, 'deep', 'er');
    assert.equal(findFolder({ from: here, env: {} }), dir, 'the nearest .parley from here up');
    assert.equal(parley(here, ['status', 'working', 'on', 'the', 'report']).code, 0);
    assert.match(parley(here, ['tell', 'Half written.']).out, /Posted/);
    const asked = parley(here, ['ask', 'Blue or red cover?', 'blue', 'red']);
    assert.match(asked.out, /Do not wait here.*run `parley read`/);
    assert.equal(parley(home, ['show', 'report.html', 'The draft.']).code, 0);
    assert.equal(parley(home, ['tell', '-'], 'It\'s "quoted",\nand on two lines.\n').code, 0, 'text from standard input');
    const host = new Parley(dir);
    let seen = host.read();
    assert.deepEqual(seen.messages.map((m) => [m.kind, m.text]), [['say', 'Half written.'], ['ask', 'Blue or red cover?'], ['show', 'The draft.'], ['say', 'It\'s "quoted",\nand on two lines.']]);
    assert.equal(seen.messages[2].path, join(home, 'report.html'), 'a relative path is posted whole');
    assert.deepEqual(seen.status, { state: 'working', note: 'on the report', at: seen.status.at });
    host.say('blue', seen.messages[1].id);
    host.say('Keep it short.');
    seen = host.read();
    assert.equal(seen.unread, 2); assert.deepEqual(seen.messages.filter((m) => m.from === 'person').map((m) => m.seen), [false, false]);
    assert.equal(parley(here, ['read']).out, 'Answer to your question "Blue or red cover?": blue\nMessage: Keep it short.\n');
    assert.equal(parley(here, ['read']).out, 'No new message.\n');
    seen = host.read();
    assert.equal(seen.unread, 0); assert.deepEqual(seen.messages.filter((m) => m.from === 'person').map((m) => m.seen), [true, true]);
    /* What it is refused, and said why, on standard error. */
    const refused = (args) => { const r = parley(home, args); return [r.code, r.err.split('.')[0]]; };
    assert.deepEqual(refused(['status', 'sleeping']), [1, 'Not done: the state is one of: working, waiting, done']);
    assert.deepEqual(refused(['show', 'nowhere.txt']), [1, `Not done: no such file: ${join(home, 'nowhere')}`]);
    assert.deepEqual(refused(['tell']), [1, 'Not done: the text is empty']);
    assert.equal(parley(home, ['launch']).code, 64);
    assert.equal(parley(tmpdir(), ['read']).code, 2, 'no folder, said so');
    assert.equal(parley(tmpdir(), ['read', '--dir', dir]).code, 0, 'or given');
    /* The MCP server writes the same files: one exchange, two ways in. */
    await agent(dir, [tool('tell', { text: 'from MCP' })]);
    assert.equal(host.read().messages.at(-1).text, 'from MCP');
});

test('the help says everything an agent needs, in English, and nothing is done without a verb', (t) => {
    for (const asked of [[], ['--help'], ['-h'], ['help']]) assert.equal(run(asked, { cwd: folder(t), env: {} }).out, `${HELP}\n`);
    for (const word of ['read', 'tell', 'ask', 'show', 'status', 'You have a new message', 'their language', 'share', '--dir', 'PARLEY_DIR']) assert.ok(HELP.includes(word), word);
    assert.ok(/^[\x20-\x7e\n]+$/.test(HELP), 'plain ASCII');
});

test('install puts the bridge in a folder and says how it is declared to an agent', (t) => {
    const dir = folder(t);
    assert.deepEqual(install(join(dir, 'b'), { as: '/work/.parley' }), { name: 'parley', command: ['node', '/work/.parley/server.mjs'] });
    assert.equal(readFileSync(join(dir, 'b', 'server.mjs'), 'utf8'), readFileSync(SERVER, 'utf8'));
    writeFileSync(join(dir, 'b', 'to-agent.jsonl'), '{"id":"kept"}\n');
    install(join(dir, 'b'));
    assert.equal(readFileSync(join(dir, 'b', 'to-agent.jsonl'), 'utf8'), '{"id":"kept"}\n', 'installed again, what was said is kept');
});

test('the contract: Parley announces, the application decides; nothing is typed by Parley', async (t) => {
    const dir = folder(t);
    install(dir);
    const events = [];
    const host = new Parley(dir, { on: (e) => events.push(e), reach: (path) => (path.startsWith('/work/') ? `files:${path.slice(6)}` : null) });
    const run2 = (calls) => agent(dir, calls, join(dir, 'server.mjs'));
    writeFileSync(join(dir, 'made.txt'), 'x');
    await run2([tool('tell', { text: 'before anyone listened' })]);
    const stop = host.listen({ every: 15 });
    t.after(stop);
    await run2([tool('status', { state: 'working', note: 'on the report' }), tool('ask', { question: 'Blue or red cover?', choices: ['blue', 'red'] }), tool('show', { path: join(dir, 'made.txt') }), tool('status', { state: 'working' }), tool('status', { state: 'waiting' })]);
    await until('five events', () => events.length >= 5);
    assert.deepEqual(events.map((e) => [e.type, e.message.kind, e.message.state ?? '']), [['agent-status', 'status', 'working'], ['agent-asked', 'ask', ''], ['agent-showed', 'show', ''], ['agent-status', 'status', 'working'], ['agent-status', 'status', 'waiting']],
        'each line once, two statuses in a row included, nothing from before');
    assert.equal(events[2].message.open, null, 'a file it cannot be opened from is said so');
    /* A line written in two pieces is announced once it is whole. */
    const half = JSON.stringify({ id: 'h', at: new Date().toISOString(), kind: 'say', text: 'héhé ' });
    appendFileSync(join(dir, 'from-agent.jsonl'), half.slice(0, 20));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(events.length, 5);
    appendFileSync(join(dir, 'from-agent.jsonl'), `${half.slice(20)}\n`);
    await until('the whole line', () => events.length === 6);
    assert.deepEqual([events[5].type, events[5].message.text], ['agent-said', 'héhé ']);
    /* The person writes: the application is told, with how many wait unread; nothing else happens. */
    const seen = host.read();
    const answered = host.say('blue', seen.messages.find((m) => m.kind === 'ask').id);
    assert.equal(answered.waiting, 0); assert.equal(answered.unread, 1);
    assert.deepEqual([events[6].type, events[6].message.text, events[6].message.answers !== undefined, events[6].unread], ['person-wrote', 'blue', true, 1]);
    host.say('And keep it short.');
    assert.equal(events.at(-1).unread, 2);
    assert.throws(() => host.say('   '), /Write something/);
    /* What the screen is given: the steps it said, the files it showed. */
    const all = host.read();
    assert.deepEqual(all.steps.map((s) => [s.state, s.note]), [['working', 'on the report'], ['working', ''], ['waiting', '']]);
    assert.deepEqual(all.files.map((f) => f.open), [null]);
    assert.equal(all.status.state, 'waiting');
    /* The agent reads: nothing is left unread. */
    assert.match(said((await run2([tool('read')]))[1]), /Answer to your question "Blue or red cover\?": blue\nMessage: And keep it short\./);
    assert.equal(host.unread(), 0);
    /* A hook that throws stops nothing. */
    const fragile = new Parley(dir, { on: () => { throw new Error('the phone is off'); } });
    assert.doesNotThrow(() => fragile.say('still written'));
    assert.equal(fragile.read().messages.at(-1).text, 'still written');
});

test('the texts an agent reads are English and say the person\'s language; the line that wakes it is the application\'s to type', () => {
    assert.equal(WAKE, 'You have a new message: run "parley read".');
    const text = invitation({ lang: 'fr-FR', install: 'npm install -g /tools/clavarium-parley-0.2.0.tgz', shared: '/work' });
    for (const part of ['npm install -g /tools/clavarium-parley-0.2.0.tgz', 'parley --help', 'parley tell', 'parley ask', 'parley show', 'parley status', 'under /work', 'Write to them in French.', 'You have a new message', 'parley read']) assert.ok(text.includes(part), part);
    assert.ok(/^[\x20-\x7e]+$/.test(text), 'one line, plain ASCII');
    for (const line of [text, WAKE]) assert.ok(!/[`'$\\]/.test(line), 'nothing a shell would run or wait on, should one listen instead of an agent');
    assert.equal(new Parley('/nowhere').invite('de'), invitation({ lang: 'de' }));
    assert.match(invitation({ lang: 'de' }), /Write to them in German\./);
    assert.deepEqual([languageName('en-GB'), languageName('it'), languageName('<b>'), languageName(undefined)], ['English', 'Italian', 'English', 'English']);
});

test('the words a person reads: a dictionary per language, English where a word is missing, and the operator\'s own replaces any word', () => {
    assert.deepEqual(LANGUAGES, ['en', 'fr']);
    const en = JSON.parse(readFileSync(join(ROOT, 'ui', 'texts', 'en.json'), 'utf8'));
    for (const lang of LANGUAGES) {
        const words = JSON.parse(readFileSync(join(ROOT, 'ui', 'texts', `${lang}.json`), 'utf8'));
        assert.deepEqual(Object.keys(words).sort(), Object.keys(en).sort(), `${lang}: the same words`);
        assert.ok(Object.values(words).every((w) => typeof w === 'string' && w.length > 0));
    }
    for (const key of KEYS) assert.ok(Object.hasOwn(en, key), `the screen's word "${key}" is in the dictionary`);
    assert.equal(texts('fr-CA').send, 'Envoyer'); assert.equal(texts('fr').lang, 'fr');
    assert.equal(texts('ja').send, 'Send'); assert.equal(texts('ja').lang, 'en');
    const own = texts('fr', { send: 'Clique ici pour faire taratata', '<script>': 'x', waiting: 42, done: '<b>fini</b>' });
    assert.equal(own.send, 'Clique ici pour faire taratata', 'whatever it says');
    assert.equal(own.done, '<b>fini</b>', 'kept as written: it is shown as text');
    assert.equal(own.waiting, 'Attend votre réponse', 'a word that is not a text is not taken');
    assert.equal(Object.hasOwn(own, '<script>'), false, 'only words the screen has');
    assert.equal(fill(own['alert-asks'], { name: 'helper' }), 'helper vous pose une question');
});

test('what the screen shows is decided from the messages alone: two views of one exchange', () => {
    const words = texts('en');
    const data = { unread: 1, status: { state: 'waiting', note: 'on the cover', at: '2026-01-05T06:00:00.000Z' },
        steps: [{ state: 'working', note: 'on the report', at: '2026-01-05T05:00:00.000Z' }, { state: 'waiting', note: 'on the cover', at: '2026-01-05T06:00:00.000Z' }],
        files: [{ path: '/work/report.html', note: 'The draft.', open: 'work/report.html', at: '2026-01-05T05:30:00.000Z' }, { path: '/tmp/secret.txt', note: '', open: null, at: '2026-01-05T05:40:00.000Z' }],
        messages: [
            { from: 'agent', id: 'q1', kind: 'ask', text: 'Blue or red?', choices: ['blue', 'red'] },
            { from: 'person', id: 'p1', kind: 'say', text: 'blue', answers: 'q1', seen: false },
            { from: 'agent', id: 'q2', kind: 'ask', text: 'One page or two?', choices: ['one', 'two'] },
            { from: 'agent', id: 's1', kind: 'show', text: 'The draft.', path: '/work/report.html', open: 'work/report.html' },
            { from: 'agent', id: 's2', kind: 'show', text: '', path: '/tmp/secret.txt', open: null },
            { from: 'agent', id: 't1', kind: 'say', text: '<b>not markup</b>' },
            { from: 'person', id: 'p2', kind: 'say', text: 'two', seen: false },
        ] };
    const simple = view(data, { words, view: 'simple' });
    assert.deepEqual(simple.items.map((i) => [i.id, i.open, i.choices.length, i.label]), [['q1', false, 0, ''], ['p1', false, 0, ''], ['q2', true, 2, 'It asks you'], ['s1', false, 0, ''], ['t1', false, 0, ''], ['p2', false, 0, '']],
        'simple: nothing the person cannot act on -- a file that cannot be opened is not there');
    assert.deepEqual(simple.items[3].file, { path: '/work/report.html', open: 'work/report.html', name: 'report.html', shown: 'report.html' }, 'its name, not its path');
    assert.equal(simple.items[4].text, '<b>not markup</b>', 'kept as the text it is');
    assert.deepEqual(simple.items.map((i) => i.mark), ['', '', '', '', '', 'Not read yet'], 'said only of the last word, with nothing from the agent after it');
    assert.equal(simple.status, null, 'it waits, and the open question already says so');
    assert.deepEqual(view({ ...data, messages: data.messages.slice(0, 2) }, { words }).status, { state: 'waiting', text: 'Waiting for you - on the cover', when: '' });
    assert.equal(view({ ...data, status: { state: 'working', note: '' } }, { words }).status, null);
    assert.deepEqual([simple.steps, simple.files, simple.summary], [[], [], '']);
    const detailed = view(data, { words, view: 'detailed' });
    assert.deepEqual(detailed.items.map((i) => i.id), ['q1', 'p1', 'q2', 's1', 's2', 't1', 'p2'], 'detailed: everything');
    assert.equal(detailed.items[4].text, 'secret.txt'); assert.equal(detailed.items[4].outside, 'Not in a shared folder: it cannot be opened from here.');
    assert.equal(detailed.items[3].file.shown, '/work/report.html', 'with its path');
    assert.equal(detailed.status.text, 'Waiting for you - on the cover'); assert.ok(detailed.status.when);
    assert.deepEqual(detailed.steps.map((s) => [s.text, s.now]), [['Working - on the report', false], ['Waiting for you - on the cover', true]], 'in the order they came; the last is now');
    assert.deepEqual(detailed.files.map((f) => [f.name, f.open]), [['report.html', 'work/report.html'], ['secret.txt', null]]);
    assert.equal(detailed.summary, 'Steps (2) - Files (2)');
    assert.equal(view({ messages: [] }, { words, view: 'detailed' }).status.text, 'It has not said where it is yet.');
    const french = view({ messages: [] }, { words: texts('fr', { empty: 'Rien, taratata' }) });
    assert.equal(french.empty, 'Rien, taratata');
    assert.equal(view(undefined).items.length, 0);
    assert.equal(view({ messages: [] }, { words: {} }).empty, 'empty', 'a word missing everywhere shows its key, never nothing');
});

test('the package an agent installs: one archive, the command and the MCP server in it, and it runs', { timeout: 120_000 }, (t) => {
    const out = folder(t);
    const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const [archive] = readdirSync(out).filter((f) => f.endsWith('.tgz'));
    assert.equal(archive, `clavarium-parley-${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}.tgz`);
    const prefix = join(out, 'global');
    const installed = spawnSync('npm', ['install', '-g', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, join(out, archive)], { encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    const work = join(out, 'work'); install(join(work, '.parley'));
    const r = spawnSync(join(prefix, 'bin', 'parley'), ['tell', 'installed and ready'], { cwd: work, encoding: 'utf8', env: { ...process.env, PARLEY_DIR: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(new Parley(join(work, '.parley')).read().messages[0].text, 'installed and ready');
    assert.ok(existsSync(join(prefix, 'bin', 'parley-mcp')));
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
        JSON.stringify({ id: 'e', at: '2026-01-05T06:00:04.000Z', kind: 'show', path: '/etc/passwd\u001b[2J', text: 'look' }),
    ].join('\n'));
    const { messages, status } = new Parley(dir, { reach: () => { throw new Error('a hook that fails'); } }).read();
    assert.equal(messages.length, 4);
    assert.equal(messages[0].text.startsWith('fine[31m redx'), true); assert.equal(messages[0].text.length, 4000);
    assert.equal(messages[1].kind, 'say', 'a kind it does not know is shown as something said');
    assert.equal(messages[2].choices.length, 8); assert.equal(messages[2].choices[0], 'c0');
    assert.deepEqual([messages[3].path, messages[3].open], ['/etc/passwd[2J', null], 'a reach that fails opens nothing');
    assert.equal(status.state, 'working', 'a state it does not know is not passed on');
});
