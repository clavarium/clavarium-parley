import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fakePage } from './fake-dom.mjs';
import { Parley, texts } from '../host/parley-host.mjs';
import { mount, view, quick, KEYS } from '../ui/parley-ui.js';
import { run, HELP, GUIDE } from '../bin/parley.mjs';
import { bridge, serve, TOOLS, ASKING } from '../server/parley-mcp.mjs';

/* SEVERAL CHOICES TO TICK: `many` on a question, `picked` on its answer. */

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-many-')); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, '.parley')); return dir; };
const posted = (dir) => readFileSync(join(dir, '.parley', 'from-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const written = (dir) => readFileSync(join(dir, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setImmediate(r));

test('the command: --pick-many, anywhere, says several may be ticked; without it, nothing changes; with fewer than two choices, refused', (t) => {
    const dir = folder(t);
    const ask = (...args) => run(['ask', ...args], { cwd: dir, env: {}, stdin: () => '' });
    assert.equal(ask('--pick-many', 'Which batches do I launch?', '--choice', 'Docket', '--choice', 'Dictation', '--choice', 'Wi-Fi').code, 0);
    assert.equal(ask('--short', 'Batches', 'Which ones?', '--choice', 'A', '--choice', 'B', '--pick-many').code, 0);
    assert.equal(ask('Blue or red?', '--choice', 'blue', '--choice', 'red').code, 0);
    const lines = posted(dir);
    assert.deepEqual(lines.map((m) => [m.text, m.choices, m.many]), [
        ['Which batches do I launch?', ['Docket', 'Dictation', 'Wi-Fi'], true],
        ['Which ones?', ['A', 'B'], true],
        ['Blue or red?', ['blue', 'red'], undefined],
    ], 'many only when asked: a line of before is a line of now');
    assert.ok(!('many' in lines[2]), 'not written at all on a single-choice question');
    const one = ask('--pick-many', 'Only one?', '--choice', 'A');
    assert.equal(one.code, 1);
    assert.match(one.err, /two choices at least/);
    assert.equal(posted(dir).length, 3, 'nothing posted by a refused one');
    assert.match(HELP, /--pick-many/);
    assert.match(HELP, /one choice for a decision; several to tick when they pick which items to do/);
    assert.match(GUIDE, /which items to do: --pick-many, they tick several\n {19}an open question: no choices/);
    assert.ok(/^[\x20-\x7e\n]+$/.test(GUIDE), 'the guide stays plain ASCII');
});

test('MCP: ask takes many, a boolean, described; its description says which form when', async (t) => {
    const dir = folder(t);
    const ask = TOOLS.find((x) => x.name === 'ask');
    assert.equal(ask.inputSchema.properties.many.type, 'boolean');
    assert.equal(ask.inputSchema.required, undefined, 'question, or questions: neither is required by the schema, one is by the tool');
    assert.ok(ask.description.includes(ASKING));
    assert.match(ask.description, /many: true/);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    serve(join(dir, '.parley'), { input, output });
    const call = (id, args) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask', arguments: args } })}\n`);
    call(1, { question: 'Which batches?', choices: ['Docket', 'Dictation'], many: true });
    call(2, { question: 'Go on?', choices: ['yes', 'no'] });
    call(3, { question: 'Which?', choices: ['only'], many: true });
    input.end();
    await new Promise((r) => setTimeout(r, 50));
    const replies = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(replies[2].result.isError, true);
    assert.deepEqual(posted(dir).map((m) => m.many), [true, undefined]);
});

test('the answer: picked, in the question\'s order, and the text says them; read lists them clearly', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('Which batches do I launch?', ['Docket', 'Dictation', 'Wi-Fi'], { many: true });
    const host = new Parley(join(dir, '.parley'));
    const q = host.read().messages.at(-1);
    assert.equal(q.many, true, 'the host hands it over');
    host.say('', q.id, [], { picked: ['Wi-Fi', 'Docket'] });
    const line = written(dir).at(-1);
    assert.deepEqual(line.picked, ['Docket', 'Wi-Fi']);
    assert.equal(line.text, 'Docket\nWi-Fi', 'an agent that reads the text alone reads them too');
    assert.equal(line.answers, q.id);
    assert.deepEqual(host.read().messages.at(-1).picked, ['Docket', 'Wi-Fi']);
    const said = agent.read();
    assert.match(said, /^\[[0-9a-f]{8}\] Answer to your question "Which batches do I launch\?": they ticked "Docket", "Wi-Fi"\n/);
    assert.doesNotMatch(said, /Open questions/, 'answered');
    assert.match(agent.read({ all: true }), /You asked them: Which batches do I launch\? \(several could be ticked: Docket, Dictation, Wi-Fi\)/);
    assert.match(agent.read({ all: true }), /They answered your question "Which batches do I launch\?": they ticked "Docket", "Wi-Fi"/);
});

test('old and new together: no many, no picked; picked refused where it means nothing; an old reader still reads', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('Blue or red?', ['blue', 'red']);
    agent.ask('Which ones?', ['A', 'B', 'C'], { many: true });
    const host = new Parley(join(dir, '.parley'));
    const [single, many] = host.read().messages;
    assert.equal(single.many, undefined);
    assert.throws(() => host.say('', single.id, [], { picked: ['blue'] }), /only for a question that lets several be ticked/);
    assert.throws(() => host.say('', many.id, [], { picked: ['Z'] }), /only its choices/);
    assert.throws(() => host.say('', many.id, [], { picked: [] }), /one of its choices at least/);
    assert.throws(() => host.say('x', undefined, [], { picked: ['A'] }), /only for a question/);
    /* An older screen answers a many question with one tap: a plain answer, read as before. */
    host.say('B', many.id);
    host.say('red', single.id);
    assert.match(agent.read(), /^\[[0-9a-f]{8}\] Answer to your question "Which ones\?": B\n\[[0-9a-f]{8}\] Answer to your question "Blue or red\?": red/);
    /* A forged many on a question of one choice, or a line of an older agent: shown as single choices. */
    appendFileSync(join(dir, '.parley', 'from-agent.jsonl'), `${JSON.stringify({ id: 'f', at: new Date().toISOString(), kind: 'ask', text: 'One?', choices: ['only'], many: true })}\n`);
    assert.equal(host.read().messages.find((m) => m.id === 'f').many, undefined);
    /* An answer written with picked, read by the text alone (an older agent): the choices, one per line. */
    host.say('', many.id, [], { picked: ['A', 'C'] });
    assert.equal(written(dir).at(-1).text, 'A\nC');
    /* Their own words added to what they ticked: both said. */
    host.say('A and C, but C first', many.id, [], { picked: ['A', 'C'] });
    assert.match(agent.read(), /they ticked "A", "C"; they added: A and C, but C first/);
});

test('the screen: choices to tick, Send waits for one; "Other answer…" under choices, Reply elsewhere', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const sent = [];
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    const data = { messages: [
        { from: 'agent', id: 'q1', at: at(0), kind: 'ask', text: 'Blue or red?', choices: ['blue', 'red'] },
        { from: 'agent', id: 'q2', at: at(1), kind: 'ask', text: 'Anything else?', choices: [] },
        { from: 'agent', id: 'q3', at: at(2), kind: 'ask', text: 'Which batches?', choices: ['Docket', 'Dictation', 'Wi-Fi'], many: true },
    ] };
    const handle = mount(root, { load: async () => data, send: async (...args) => { sent.push(args); }, words: texts('en'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const said = (id) => root.querySelectorAll('.parley-said').find((b) => b.dataset.id === id);
    const other = (id) => said(id).querySelector('.parley-reply-to');
    assert.equal(other('q1').textContent, 'Other answer…');
    assert.ok(other('q1').classList.contains('parley-other'), 'quiet, as a link');
    assert.equal(other('q2').textContent, 'Reply', 'a question without choices keeps Reply');
    assert.ok(!other('q2').classList.contains('parley-other'));
    assert.equal(other('q3').textContent, 'Other answer…');
    const kids = said('q1').children;
    assert.ok(kids.indexOf(other('q1')) > kids.indexOf(said('q1').querySelector('.parley-choices')), 'after the choices');
    /* Choices to tick: boxes, each with its state, then Send. */
    const boxes = said('q3').querySelectorAll('.parley-pick');
    const go = said('q3').querySelector('.parley-picks-send');
    assert.deepEqual(boxes.map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked'), b.textContent]), [['checkbox', 'false', 'Docket'], ['checkbox', 'false', 'Dictation'], ['checkbox', 'false', 'Wi-Fi']]);
    assert.equal(go.textContent, 'Send');
    assert.equal(go.disabled, true, 'nothing ticked: Send waits');
    boxes[2].click(); boxes[0].click();
    assert.equal(boxes[0].getAttribute('aria-checked'), 'true');
    assert.equal(go.disabled, false);
    boxes[2].click(); boxes[2].click(); boxes[1].click(); boxes[1].click();
    /* The thread drawn again (another view and back): what is ticked is kept. */
    root.querySelector('button[data-view="detailed"]').click(); await settle(); await settle();
    root.querySelector('button[data-view="simple"]').click(); await settle(); await settle();
    assert.notEqual(said('q3').querySelector('.parley-picks-send'), go, 'drawn again');
    assert.deepEqual(said('q3').querySelectorAll('.parley-pick').map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'true'], 'the ticks kept');
    assert.equal(sent.length, 0, 'ticking sends nothing');
    said('q3').querySelector('.parley-picks-send').click();
    await settle();
    assert.deepEqual(sent, [['Docket\nWi-Fi', 'q3', undefined, { picked: ['Docket', 'Wi-Fi'] }]], 'in the question\'s order');
    /* Other answer: what is typed answers that question. */
    other('q1').click();
    assert.match(root.querySelector('.parley-replying').textContent, /Blue or red\?/);
    /* A single choice still sends at once, as before. */
    said('q1').querySelector('.parley-choices').querySelector('button').click();
    await settle();
    assert.deepEqual(sent.at(-1), ['blue', 'q1']);
    assert.ok(KEYS.includes('other-answer'));
    assert.equal(texts('fr')['other-answer'], 'Autre réponse…');
});

test('the screen\'s data: many is said on the item; the quick answers above the box leave choices to tick out', () => {
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    const many = { messages: [{ from: 'agent', id: 'q', at: at(0), kind: 'ask', text: 'Which?', choices: ['A', 'B'], many: true }] };
    assert.equal(view(many, { words: texts('en') }).items[0].many, true);
    assert.deepEqual(quick(many), [], 'one tap there would send one alone');
    const one = { messages: [{ from: 'agent', id: 'q', at: at(0), kind: 'ask', text: 'Which?', choices: ['A', 'B'] }] };
    assert.equal(view(one, { words: texts('en') }).items[0].many, false);
    assert.equal(quick(one).length, 2);
});

test('the command: --help after a verb is help, an option it does not know is refused; neither is posted', (t) => {
    const dir = folder(t);
    const cmd = (...args) => run(args, { cwd: dir, env: {}, stdin: () => '' });
    for (const verb of ['ask', 'tell', 'doing', 'read', 'show', 'close', 'status']) {
        const r = cmd(verb, '--help');
        assert.equal(r.code, 0); assert.equal(r.out, `${HELP}\n`);
        assert.equal(cmd(verb, 'x', '-h').out, `${HELP}\n`);
    }
    assert.match(cmd('ask', '--many', 'Which?', '--choice', 'A', '--choice', 'B').err, /ask does not know --many/);
    assert.match(cmd('tell', '--title', 'T', 'text').err, /tell does not know --title/);
    assert.match(cmd('read', '--since', 'x').err, /read does not know --since/);
    assert.throws(() => posted(dir), 'nothing was posted');
    /* What looks like an option inside a sentence, or as the value of one, still goes. */
    assert.equal(cmd('tell', 'use --dir to point at the folder').code, 0);
    assert.equal(cmd('ask', 'Which flag?', '--choice', '--force', '--choice', '--dry-run').code, 0);
    assert.notEqual(cmd('read', '--before', 'abc').code, 64, 'a value, not an option');
    assert.deepEqual(posted(dir).map((m) => m.text), ['use --dir to point at the folder', 'Which flag?']);
});

test('the box: ↑ on its first line brings back the messages sent before, ↓ on its last line comes back down', async () => {
    const { recalled } = await import('../ui/parley-ui.js');
    const key = (k, more = {}) => ({ key: k, ...more });
    const box = (value, at = value.length) => ({ value, selectionStart: at, selectionEnd: at });
    const sent = ['first', 'second', 'third'];
    assert.deepEqual(recalled(key('ArrowUp'), box(''), -1, sent), { at: 2, text: 'third' });
    assert.deepEqual(recalled(key('ArrowUp'), box('a draft'), -1, sent), { at: 2, text: 'third' }, 'written or not');
    assert.deepEqual(recalled(key('ArrowUp'), box('third'), 2, sent), { at: 1, text: 'second' });
    assert.equal(recalled(key('ArrowUp'), box('first'), 0, sent), null, 'nothing older');
    assert.equal(recalled(key('ArrowUp'), box('line 1\nline 2'), -1, sent), null, 'on the second line it moves the caret');
    assert.deepEqual(recalled(key('ArrowUp'), box('line 1\nline 2', 3), -1, sent), { at: 2, text: 'third' });
    assert.deepEqual(recalled(key('ArrowDown'), box('second'), 1, sent), { at: 2, text: 'third' });
    assert.deepEqual(recalled(key('ArrowDown'), box('third'), 2, sent), { at: -1, text: '' }, 'back to what was written');
    assert.equal(recalled(key('ArrowDown'), box('mine'), -1, sent), null, 'not recalling: ↓ is the caret\'s');
    assert.equal(recalled(key('ArrowUp', { shiftKey: true }), box(''), -1, sent), null);
    assert.equal(recalled(key('ArrowUp'), { value: 'abc', selectionStart: 0, selectionEnd: 2 }, -1, sent), null, 'a selection is left alone');
    assert.equal(recalled(key('ArrowUp'), box(''), -1, []), null);
});
