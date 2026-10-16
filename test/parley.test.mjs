import { test } from 'node:test';
/* Times and days are checked in one time zone, whatever the machine's. */
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, Parley, WAKE, REREAD, invitation, languageName, texts, fill, LANGUAGES } from '../host/parley-host.mjs';
import { view, KEYS, quick, sends, joined, REPLIES_MAX, LABEL_MAX } from '../ui/parley-ui.js';
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

test('the agent\'s side speaks MCP and has seven verbs, no more', async (t) => {
    const dir = folder(t);
    const replies = await agent(dir, [{ method: 'tools/list' }, { method: 'ping' }, { method: 'resources/list' }, tool('launch')]);
    assert.equal(replies[0].result.serverInfo.name, 'parley'); assert.deepEqual(replies[0].result.capabilities, { tools: {} });
    assert.deepEqual(replies[1].result.tools.map((x) => x.name), ['tell', 'ask', 'show', 'read', 'close', 'doing', 'status']);
    assert.ok(replies[1].result.tools.every((x) => x.inputSchema.type === 'object' && x.description.length > 20));
    assert.deepEqual(replies[2].result, {});
    assert.equal(replies[3].error.code, -32601);
    assert.equal(replies[4].result.isError, true);
    assert.equal(replies.length, 5, 'a notification is not answered');
});

test('the command: the same six verbs on the same files, found from where the agent stands', async (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    mkdirSync(join(home, 'deep', 'er'), { recursive: true });
    writeFileSync(join(home, 'report.html'), '<p>draft</p>');
    const here = join(home, 'deep', 'er');
    assert.equal(findFolder({ from: here, env: {} }), dir, 'the nearest .parley from here up');
    assert.equal(parley(here, ['status', 'working', 'on', 'the', 'report']).code, 0);
    assert.match(parley(here, ['tell', 'Half written.']).out, /Posted/);
    assert.equal(parley(here, ['doing', 'reading', 'the  notes\n']).out, 'Noted.\n', 'what it does now: one line');
    const asked = parley(here, ['ask', 'Blue or red cover?', 'blue', 'red']);
    assert.match(asked.out, /Do not wait here.*run `parley read`/);
    assert.equal(parley(home, ['show', 'report.html', 'The draft.']).code, 0);
    assert.equal(parley(home, ['tell', '-'], 'It\'s "quoted",\nand on two lines.\n').code, 0, 'text from standard input');
    const host = new Parley(dir);
    let seen = host.read();
    assert.deepEqual(seen.messages.map((m) => [m.kind, m.text]), [['say', 'Half written.'], ['ask', 'Blue or red cover?'], ['show', 'The draft.'], ['say', 'It\'s "quoted",\nand on two lines.']]);
    assert.equal(seen.messages[2].path, join(home, 'report.html'), 'a relative path is posted whole');
    assert.deepEqual(seen.status, { state: 'working', note: 'on the report', at: seen.status.at });
    assert.deepEqual(seen.steps.map((s) => [s.kind, s.state, s.note]), [['status', 'working', 'on the report'], ['doing', 'working', 'reading the notes']], 'its steps, in order: states and what it did');
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
    assert.deepEqual(refused(['doing', '  ']), [1, 'Not done: the text is empty']);
    assert.equal(parley(home, ['launch']).code, 64);
    assert.equal(parley(tmpdir(), ['read']).code, 2, 'no folder, said so');
    assert.equal(parley(tmpdir(), ['read', '--dir', dir]).code, 0, 'or given');
    /* The MCP server writes the same files: one exchange, two ways in. */
    await agent(dir, [tool('tell', { text: 'from MCP' }), tool('doing', { text: 'x'.repeat(300) })]);
    assert.equal(host.read().messages.at(-1).text, 'from MCP');
    assert.equal(host.read().steps.at(-1).note, 'x'.repeat(200), 'what it does is one short line');
});

test('the help says everything an agent needs, in English, and nothing is done without a verb', (t) => {
    for (const asked of [[], ['--help'], ['-h'], ['help']]) assert.equal(run(asked, { cwd: folder(t), env: {} }).out, `${HELP}\n`);
    for (const word of ['read', 'tell', 'ask', 'show', 'status', 'parley doing', 'You have a new message', 'their language', 'share', '--dir', 'PARLEY_DIR']) assert.ok(HELP.includes(word), word);
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
    await run2([tool('status', { state: 'working', note: 'on the report' }), tool('ask', { question: 'Blue or red cover?', choices: ['blue', 'red'] }), tool('show', { path: join(dir, 'made.txt') }), tool('doing', { text: 'checking the cover' }), tool('status', { state: 'waiting' })]);
    await until('five events', () => events.length >= 5);
    assert.deepEqual(events.map((e) => [e.type, e.message.kind, e.message.state ?? '']), [['agent-status', 'status', 'working'], ['agent-asked', 'ask', ''], ['agent-showed', 'show', ''], ['agent-doing', 'doing', 'working'], ['agent-status', 'status', 'waiting']],
        'each line once, what it does included, nothing from before');
    assert.equal(events[3].message.text, 'checking the cover');
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
    assert.deepEqual(all.steps.map((s) => [s.kind, s.state, s.note]), [['status', 'working', 'on the report'], ['doing', 'working', 'checking the cover'], ['status', 'waiting', '']]);
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
    for (const part of ['npm install -g /tools/clavarium-parley-0.2.0.tgz', 'parley --help', 'parley tell', 'parley ask', 'parley show', 'parley doing', 'parley status', 'under /work', 'Write to them in French.', 'You have a new message', 'parley read']) assert.ok(text.includes(part), part);
    assert.ok(/^[\x20-\x7e]+$/.test(text), 'one line, plain ASCII');
    assert.equal(REREAD, 'Your chat with the person is kept: run "parley read --all" before going on.');
    assert.ok(/^[\x20-\x7e]+$/.test(REREAD));
    for (const line of [text, WAKE, REREAD]) assert.ok(!/[`'$\\]/.test(line), 'nothing a shell would run or wait on, should one listen instead of an agent');
    assert.equal(new Parley('/nowhere').invite('de'), invitation({ lang: 'de' }));
    assert.match(invitation({ lang: 'de' }), /Write to them in German\./);
    /* Installed by the application: the agent is not asked to install anything. */
    assert.match(invitation({ lang: 'de' }), /^Parley is installed: run "parley --help"\./);
    assert.ok(!/install -g|npm/.test(invitation({ lang: 'de' })));
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
    const at = (minute) => `2026-01-05T06:${String(minute).padStart(2, '0')}:00.000Z`;
    const data = { unread: 1, status: { state: 'waiting', note: 'on the cover', at: at(50) },
        steps: [{ id: 'w1', kind: 'status', state: 'working', note: 'on the report', at: at(0) }, { id: 'w2', kind: 'status', state: 'waiting', note: 'on the cover', at: at(50) }],
        files: [{ path: '/work/report.html', note: 'The draft.', open: 'work/report.html', at: at(30) }, { path: '/tmp/secret.txt', note: '', open: null, at: at(40) }],
        messages: [
            { from: 'agent', id: 'q1', kind: 'ask', text: 'Blue or red?', choices: ['blue', 'red'], at: at(1) },
            { from: 'person', id: 'p1', kind: 'say', text: 'blue', answers: 'q1', seen: false, at: at(2) },
            { from: 'agent', id: 'q2', kind: 'ask', text: 'One page or two?', choices: ['one', 'two'], at: at(3) },
            { from: 'agent', id: 's1', kind: 'show', text: 'The draft.', path: '/work/report.html', open: 'work/report.html', at: at(30) },
            { from: 'agent', id: 's2', kind: 'show', text: '', path: '/tmp/secret.txt', open: null, at: at(40) },
            { from: 'agent', id: 't1', kind: 'say', text: '<b>not markup</b>', at: at(41) },
            { from: 'person', id: 'p2', kind: 'say', text: 'two', seen: false, at: at(42) },
        ] };
    const now = Date.parse('2026-01-05T09:00:00.000Z');
    const simple = view(data, { words, view: 'simple', now, locale: 'en-GB' });
    assert.deepEqual(simple.items.map((i) => [i.id, i.open, i.choices.length, i.label]), [['q1', false, 0, ''], ['p1', false, 0, ''], ['q2', true, 2, 'It asks you'], ['s1', false, 0, ''], ['t1', false, 0, ''], ['p2', false, 0, '']],
        'simple: nothing the person cannot act on -- a file that cannot be opened is not there');
    assert.deepEqual(simple.items[3].file, { path: '/work/report.html', open: 'work/report.html', name: 'report.html', shown: 'report.html', picture: false }, 'its name, not its path');
    assert.equal(simple.items[4].text, '<b>not markup</b>', 'kept as the text it is');
    assert.deepEqual(simple.items.filter((i) => i.from === 'person').map((i) => [i.state, i.sign]), [['sent', 'sent'], ['sent', 'sent']], 'each message of the person says it is not read yet, by its sign');
    assert.deepEqual([simple.items[0].time, simple.items[0].when], ['06:01', 'Monday, 5 January 2026 at 06:01'], 'each message has its time, and its whole date on hover');
    assert.equal(simple.status, null, 'simple: no state at the top');
    assert.deepEqual(simple.rows.at(-1), { type: 'waits', key: 'w', text: 'Waiting for you: on the cover', time: '06:50', when: 'Monday, 5 January 2026 at 06:50' }, 'it waits: said once, at the end, not as a step');
    assert.equal(simple.rows.filter((r) => r.type === 'waits').length, 1);
    const answered = view({ ...data, messages: [...data.messages, { from: 'person', id: 'p3', kind: 'say', text: 'and?', seen: false, at: at(51) }] }, { words });
    assert.equal(answered.rows.some((r) => r.type === 'waits'), false, 'gone once the person wrote');
    assert.equal(view({ ...data, messages: data.messages.slice(0, 3) }, { words }).rows.some((r) => r.type === 'waits'), false, 'not when its last word is a question, which says so');
    assert.deepEqual([simple.files, simple.summary], [[], '']);
    assert.deepEqual(simple.rows.filter((r) => r.trail).map((r) => [r.id, r.trail.label, r.trail.open]), [['q1', '1 step', false]], 'simple: the steps folded into the message they led to, no line of their own');
    assert.deepEqual(simple.rows.filter((r) => r.type === 'steps'), [], 'a state of waiting is no step');
    const detailed = view(data, { words, view: 'detailed', now, locale: 'en-GB' });
    assert.deepEqual(detailed.items.map((i) => i.id), ['q1', 'p1', 'q2', 's1', 's2', 't1', 'p2'], 'detailed: everything');
    assert.equal(detailed.items[4].text, 'secret.txt'); assert.equal(detailed.items[4].outside, 'Not in a shared folder: it cannot be opened from here.');
    assert.equal(detailed.items[3].file.shown, '/work/report.html', 'with its path');
    assert.equal(detailed.status, null, 'detailed: its waiting is said at the end, not twice');
    assert.equal(detailed.rows.some((r) => r.trail), false);
    assert.deepEqual(detailed.rows.filter((r) => r.type === 'steps').map((r) => [r.open, r.steps.map((x) => [x.text, x.time])]), [[true, [['Working - on the report', '06:00']]]],
        'detailed: every step unfolded where it came, with its state and time');
    assert.deepEqual(detailed.files.map((f) => [f.name, f.open]), [['report.html', 'work/report.html'], ['secret.txt', null]]);
    assert.equal(detailed.summary, 'Files (2)');
    /* Done: said at the top of the detailed view, and not again at the end. */
    const done = view({ ...data, status: { state: 'done', note: 'all set', at: at(55) }, steps: [...data.steps, { id: 'd1', kind: 'status', state: 'done', note: 'all set', at: at(55) }] }, { words, view: 'detailed' });
    assert.equal(done.status.text, 'Done - all set');
    assert.equal(JSON.stringify(done.rows).split('all set').length - 1, 0, 'not repeated as a step');
    assert.equal(view({ messages: [] }, { words, view: 'detailed' }).status.text, 'It has not said where it is yet.');
    const french = view({ messages: [] }, { words: texts('fr', { empty: 'Rien, taratata' }) });
    assert.equal(french.empty, 'Rien, taratata');
    assert.equal(view(undefined).items.length, 0);
    assert.equal(view({ messages: [] }, { words: {} }).empty, 'empty', 'a word missing everywhere shows its key, never nothing');
});

test('while it works, the one line of what it does now; gone when its next message comes, and what came before one click away', () => {
    const words = texts('en');
    const at = (minute) => new Date(Date.parse('2026-01-05T06:00:00.000Z') + minute * 60_000).toISOString();
    const asked = { from: 'person', id: 'p1', kind: 'say', text: 'Write the story.', seen: true, at: at(0) };
    const turn = [
        { id: 'd1', kind: 'doing', state: 'working', note: 'listening to the 12 recordings', at: at(1) },
        { id: 'd2', kind: 'doing', state: 'working', note: 'writing chapter 1', at: at(5) },
        { id: 'd3', kind: 'doing', state: 'working', note: 'reading it again', at: at(9) },
    ];
    const kinds = (v) => v.rows.map((r) => r.type);
    let data = { messages: [asked], steps: turn, status: { state: 'working', note: '', at: at(9) } };
    let simple = view(data, { words, now: Date.parse(at(10)), locale: 'en-GB' });
    assert.deepEqual(kinds(simple), ['day', 'message', 'now']);
    const line = simple.rows.at(-1);
    assert.deepEqual([line.text, line.live, line.time, line.label, line.open, line.steps.map((s) => s.text)], ['reading it again', true, '06:09', '2 steps', false, ['listening to the 12 recordings', 'writing chapter 1']],
        'the newest line, moving; the two before it folded behind it');
    assert.equal(simple.status, null, 'simple: no status line while it works');
    const detailed = view(data, { words, view: 'detailed', now: Date.parse(at(10)), locale: 'en-GB' });
    assert.equal(detailed.rows.at(-1).open, true, 'detailed: what came before, unfolded');
    assert.equal(detailed.status.text, 'Working - reading it again', 'where it is: what it does now');
    /* Nothing new for a long while: it may have stopped; the line stays, still. */
    const quiet = view(data, { words, now: Date.parse(at(40)), locale: 'en-GB' }).rows.at(-1);
    assert.deepEqual([quiet.live, quiet.quiet], [false, 'nothing new since 06:09']);
    /* Its next message: the line is gone, its steps fold between the two messages. */
    data = { ...data, messages: [asked, { from: 'agent', id: 'a1', kind: 'say', text: 'Chapter 1 is written.', at: at(11) }] };
    simple = view(data, { words, now: Date.parse(at(12)), locale: 'en-GB' });
    assert.deepEqual(kinds(simple), ['day', 'message', 'message']);
    assert.deepEqual([simple.rows[2].trail.label, simple.rows[2].trail.open, simple.rows[2].trail.steps.length], ['3 steps', false, 3], 'simple: on the message they led to');
    const unfolded = view(data, { words, view: 'detailed', now: Date.parse(at(12)) });
    assert.deepEqual([kinds(unfolded)[2], unfolded.rows[2].open], ['steps', true], 'detailed: unfolded above it');
    /* A turn that ends done or waiting is not shown as moving. */
    const ended = view({ ...data, messages: [asked], steps: [...turn, { id: 'x', kind: 'status', state: 'done', note: '', at: at(10) }] }, { words, now: Date.parse(at(11)) });
    assert.deepEqual(kinds(ended), ['day', 'message', 'steps']);
    assert.equal(ended.rows[2].label, '4 steps');
    /* One step alone: a line, nothing to unfold. */
    assert.deepEqual(view({ messages: [asked], steps: turn.slice(0, 1) }, { words, now: Date.parse(at(2)) }).rows.at(-1).label, '');
});

test('times as a chat shows them: the day when it changes, the time when long passed, in the person\'s words', () => {
    const now = Date.parse('2026-03-10T15:00:00.000Z');
    const m = (id, at) => ({ from: 'agent', id, kind: 'say', text: id, at });
    const data = { messages: [m('a', '2025-12-31T09:00:00.000Z'), m('b', '2026-03-02T09:00:00.000Z'), m('c', '2026-03-09T22:00:00.000Z'), m('d', '2026-03-10T08:00:00.000Z'), m('e', '2026-03-10T08:30:00.000Z'), m('f', '2026-03-10T11:00:00.000Z')] };
    const rows = view(data, { words: texts('en'), now, locale: 'en-GB' }).rows.filter((r) => r.type !== 'message').map((r) => [r.type, r.text]);
    assert.deepEqual(rows, [['day', 'Wednesday, 31 December 2025'], ['day', 'Monday 2 March'], ['day', 'Yesterday'], ['day', 'Today'], ['gap', '11:00']],
        'a new day, the year when it is not this one; within a day, the time after a long silence only');
    const fr = view(data, { words: texts('fr'), now, locale: 'fr' }).rows.filter((r) => r.type !== 'message').map((r) => r.text);
    assert.deepEqual(fr, ['mercredi 31 décembre 2025', 'lundi 2 mars', 'Hier', "Aujourd'hui", '11:00']);
    assert.equal(view({ messages: [m('x', 'not a date')] }, { words: texts('en') }).rows.map((r) => r.type).join(), 'message', 'no time, no divider');
    assert.equal(view({ messages: [m('x', '2026-03-10T08:00:00.000Z')] }, { words: texts('en'), locale: '<b>' }).items[0].time.length > 0, true, 'a locale that is not one is the device\'s');
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
        JSON.stringify({ id: 'a', at: '2026-01-05T06:00:00.000Z', kind: 'say', text: `fine\u001b[31m red‮${'x'.repeat(20000)}` }),
        'this line is not JSON',
        JSON.stringify({ id: 'b', at: '2026-01-05T06:00:01.000Z', kind: 'launch', text: 'unknown kind' }),
        JSON.stringify({ id: 'c', at: '2026-01-05T06:00:02.000Z', kind: 'ask', text: 'q', choices: Array.from({ length: 30 }, (_, i) => `c${i}\n`) }),
        JSON.stringify(['an array, not an object']),
        JSON.stringify({ id: 'd', at: '2026-01-05T06:00:03.000Z', kind: 'status', state: 'exploding' }),
        JSON.stringify({ id: 'e', at: '2026-01-05T06:00:04.000Z', kind: 'show', path: '/etc/passwd\u001b[2J', text: 'look' }),
    ].join('\n'));
    const { messages, status } = new Parley(dir, { reach: () => { throw new Error('a hook that fails'); } }).read();
    assert.equal(messages.length, 4);
    assert.equal(messages[0].text.startsWith('fine[31m redx'), true); assert.equal(messages[0].text.length, 16000);
    assert.equal(messages[1].kind, 'say', 'a kind it does not know is shown as something said');
    assert.equal(messages[2].choices.length, 8); assert.equal(messages[2].choices[0], 'c0');
    assert.deepEqual([messages[3].path, messages[3].open], ['/etc/passwd[2J', null], 'a reach that fails opens nothing');
    assert.equal(status.state, 'working', 'a state it does not know is not passed on');
});

test('saying what it does means it works: after "done" or "waiting", a step it starts makes it "working" again', (t) => {
    const dir = folder(t);
    install(dir);
    const line = (id, minute, rest) => JSON.stringify({ id, at: `2026-01-05T06:0${minute}:00.000Z`, ...rest });
    writeFileSync(join(dir, 'from-agent.jsonl'), `${[
        line('a', 0, { kind: 'doing', text: 'first\nline\u001b[2J ' + 'y'.repeat(300) }),
        line('b', 1, { kind: 'status', state: 'done', text: 'all done' }),
    ].join('\n')}\n`);
    const host = new Parley(dir);
    assert.equal(host.read().steps[0].note, `first line[2J ${'y'.repeat(300)}`.slice(0, 200), 'one line, cleaned, bounded');
    assert.equal(host.read().status.state, 'done');
    appendFileSync(join(dir, 'from-agent.jsonl'), `${line('c', 2, { kind: 'doing', text: 'one more thing' })}\n`);
    assert.deepEqual(host.read().status, { state: 'working', note: '', at: '2026-01-05T06:02:00.000Z' });
    assert.equal(host.read().messages.length, 0, 'steps are not messages');
    const alone = folder(t);
    writeFileSync(join(alone, 'from-agent.jsonl'), `${line('d', 0, { kind: 'doing', text: 'started' })}\n`);
    assert.equal(new Parley(alone).read().status.state, 'working', 'a step said before any state');
});

test('the helpers of the box: the quick answers above it, what Enter does, what dictation adds', () => {
    const at = (minute) => `2026-01-05T06:${String(minute).padStart(2, '0')}:00.000Z`;
    const data = { messages: [
        { from: 'agent', id: 'q1', kind: 'ask', text: 'Blue or red?', choices: ['blue', 'red'], at: at(1) },
        { from: 'person', id: 'p1', kind: 'say', text: 'blue', answers: 'q1', at: at(2) },
        { from: 'agent', id: 'q2', kind: 'ask', text: 'One page or two?', choices: ['one', 'two'], at: at(3) },
        { from: 'agent', id: 'q3', kind: 'ask', text: 'Anything else?', choices: [], at: at(4) },
    ] };
    const replies = [{ label: ' Yes, go on ', text: 'Yes, go on.', send: true }, { label: 'Start with', text: 'Start with ' }, { label: '', text: 'no label' }, { label: 'x', text: 42 }, null, { label: 'y'.repeat(99), text: '<b>kept as text</b>' }];
    assert.deepEqual(quick(data, replies), [
        { kind: 'choice', label: 'one', text: 'one', send: true, answers: 'q2' },
        { kind: 'choice', label: 'two', text: 'two', send: true, answers: 'q2' },
        { kind: 'reply', label: 'Yes, go on', text: 'Yes, go on.', send: true },
        { kind: 'reply', label: 'Start with', text: 'Start with ', send: false },
        { kind: 'reply', label: 'y'.repeat(LABEL_MAX), text: '<b>kept as text</b>', send: false },
    ], 'the choices of the question it asks now, first: never of one answered; then the ready answers that are well formed; put in the box unless they say send');
    assert.deepEqual(quick({ messages: data.messages.slice(0, 2) }, []), [], 'answered: no choice left');
    assert.equal(quick(undefined, Array.from({ length: 99 }, (_, i) => ({ label: `r${i}`, text: 't' }))).length, REPLIES_MAX);
    assert.deepEqual(quick({ messages: [{ from: 'person', id: 'x', kind: 'ask', choices: ['a'] }] }), [], 'only the agent asks');
    const key = (more) => ({ key: 'Enter', ...more });
    assert.deepEqual([sends(key(), 'auto', true), sends(key(), 'auto', false)], [true, false], 'auto: Enter sends with a keyboard, is a new line on a touch screen');
    assert.deepEqual([sends(key({ shiftKey: true }), 'send', true), sends(key({ ctrlKey: true }), 'newline', false), sends(key({ metaKey: true }), 'auto', false)], [false, true, true], 'Shift+Enter a new line, Ctrl+Enter sends, always');
    assert.deepEqual([sends(key(), 'send', false), sends(key(), 'newline', true)], [true, false]);
    assert.equal(sends(key({ isComposing: true }), 'send', true), false, 'a character being composed is not sent');
    assert.equal(sends({ key: 'a' }, 'send', true), false);
    assert.deepEqual([joined('', ' hello  there '), joined('Hi', 'you'), joined('Hi ', 'you'), joined('Hi', '  ')], ['hello there', 'Hi you', 'Hi you', 'Hi']);
});

test('after a restart the agent picks up the thread: "read --all" gives the whole exchange, both sides, oldest first, and reads everything', async (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    const host = new Parley(dir);
    assert.equal(parley(home, ['read', '--all']).out, 'Nothing was written yet, on either side.\n');
    host.say('Write the family story.');
    writeFileSync(join(home, 'chapter.html'), 'x');
    assert.equal(parley(home, ['tell', 'Starting with the farm.']).code, 0);
    assert.equal(parley(home, ['doing', 'reading']).code, 0);
    assert.equal(parley(home, ['ask', 'His voice, or about him?', 'his voice', 'about him']).code, 0);
    assert.equal(parley(home, ['show', 'chapter.html', 'Chapter 1']).code, 0);
    assert.match(parley(home, ['read']).out, /^Message: Write the family story\.\nOpen questions \(one they answered another way: close it with parley close ID "the answer you understood"\):\n {2}\[[0-9a-f]{8}\] His voice, or about him\?\n$/, 'with the questions still open');
    host.say('his voice', host.read().messages.find((m) => m.kind === 'ask').id);
    const all = parley(home, ['read', '--all']).out.split('\n');
    assert.match(all[0], /^The whole exchange with the person, oldest first \(5\):$/);
    assert.deepEqual(all.slice(1, 6).map((l) => l.replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d\] /, '')), [
        'They wrote: Write the family story.',
        'You told them: Starting with the farm.',
        'You asked them: His voice, or about him? (choices: his voice, about him)',
        `You showed them a file: ${join(home, 'chapter.html')} (Chapter 1)`,
        'They answered your question "His voice, or about him?": his voice (new)',
    ], 'what it did not read yet is marked; what it was doing is not part of the exchange');
    assert.equal(all[6], 'End of the exchange: everything is read now.');
    assert.equal(host.unread(), 0);
    assert.equal(parley(home, ['read']).out, 'No new message.\n');
    assert.equal(parley(home, ['read', '--every']).code, 64);
    /* The same through MCP. */
    const replies = await agent(dir, [tool('read', { all: true })], join(dir, 'server.mjs'));
    assert.match(said(replies[1]), /^The whole exchange with the person, oldest first \(5\):/);
    assert.ok(HELP.includes('parley read --all'));
});

test('the person attaches files to a message: the agent is told where they are, the screen opens them the application\'s way', async (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    const events = [];
    const host = new Parley(dir, { on: (e) => events.push(e), reach: (path) => (path.startsWith('/work/.parley/files/') ? `work:${path.slice(6)}` : null) });
    const now = host.say('Here is the photo.', undefined, [{ path: '/work/.parley/files/a1/photo.jpg', name: 'photo.jpg', size: 2048 }, { path: '/elsewhere/x.txt', size: 3 }]);
    const mine = now.messages.at(-1);
    assert.deepEqual(mine.files, [{ path: '/work/.parley/files/a1/photo.jpg', name: 'photo.jpg', size: 2048, open: 'work:.parley/files/a1/photo.jpg' }, { path: '/elsewhere/x.txt', name: 'x.txt', size: 3, open: null }]);
    assert.equal(events.at(-1).type, 'person-wrote');
    assert.equal(events.at(-1).message.files.length, 2);
    /* Files alone are a message; a file is a whole path; ten at most. */
    host.say('', undefined, [{ path: '/work/.parley/files/b2/plan.pdf', name: 'plan.pdf', size: 1048576 * 3 }]);
    assert.throws(() => host.say('x', undefined, [{ path: 'relative.txt' }]), /whole path/);
    assert.throws(() => host.say('x', undefined, Array.from({ length: 11 }, (_, i) => ({ path: `/f${i}` }))), /10 files at most/);
    assert.throws(() => host.say('  ', undefined, []), /Write something/);
    assert.equal(parley(home, ['read']).out, 'Message: Here is the photo.\n  Attached file: /work/.parley/files/a1/photo.jpg (2 KB)\n  Attached file: /elsewhere/x.txt (3 bytes)\nMessage: \n  Attached file: /work/.parley/files/b2/plan.pdf (3.0 MB)\n');
    /* On the screen: by name in its bubble, opened the application's way; its whole path in the detailed view. */
    const data = host.read();
    const simple = view(data, { words: texts('en') });
    assert.deepEqual(simple.items[0].files, [{ path: '/work/.parley/files/a1/photo.jpg', name: 'photo.jpg', open: 'work:.parley/files/a1/photo.jpg', shown: '', size: '2 KB', picture: true }, { path: '/elsewhere/x.txt', name: 'x.txt', open: null, shown: '', size: '3 B', picture: false }]);
    assert.equal(view(data, { words: texts('en'), view: 'detailed' }).items[0].files[0].shown, '/work/.parley/files/a1/photo.jpg');
    for (const key of ['attach', 'remove-file', 'sending-files', 'attach-where']) assert.ok(KEYS.includes(key));
});

test('lines of the application: said in the thread where they happened, grey, with its buttons; they take no step and hide no "not read yet"', () => {
    const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
    const data = {
        messages: [
            { from: 'agent', id: 'a', at: at(0), kind: 'say', text: 'Working on it.' },
            { from: 'person', id: 'p', at: at(1), kind: 'say', text: 'Thanks', seen: false },
            { from: 'system', id: 'y', at: at(3), text: 'It ran out of memory once.', level: 'warn', actions: [{ id: 'memory', label: 'More memory...' }, { id: 'restart', label: 'Restart...' }, { id: 'x', label: '' }, { id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }] },
        ],
        steps: [{ id: 's', kind: 'doing', state: 'working', note: 'reading', at: at(2) }],
    };
    const v = view(data, { words: texts('en'), now: Date.parse(at(5)) });
    const line = v.rows.find((r) => r.from === 'system');
    assert.deepEqual([line.kind, line.level, line.tone, line.text, line.time], ['system', 'needs-you', 'warn', 'It ran out of memory once.', '9:03 AM'], 'a level said the old way: warn needs the person');
    assert.deepEqual(line.actions.map((a) => a.id), ['memory', 'restart', 'a', 'b'], 'labelled buttons only, four at most');
    assert.equal(line.trail, null);
    assert.equal(v.items.find((i) => i.id === 'p').state, 'sent', 'the person\'s last word is still said not read');
    assert.equal(v.rows.at(-1).type, 'now', 'what it does now stays the agent\'s turn');
    assert.equal(view({ messages: [{ from: 'system', id: 'z', at: at(0), text: 'Restarted.', level: 'nonsense' }] }).items[0].level, 'news');
});
