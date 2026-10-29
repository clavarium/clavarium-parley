import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fakePage, fakeEvent } from './fake-dom.mjs';
import { Parley, texts } from '../host/parley-host.mjs';
import { mount, view, quick, KEYS, PRESS_MS } from '../ui/parley-ui.js';
import { run, HELP, GUIDE } from '../bin/parley.mjs';
import { bridge, serve, TOOLS, GROUPING, GROUP_MAX } from '../server/parley-mcp.mjs';

/* QUESTIONS ASKED TOGETHER: one ask line with `questions`, one answer with `replies`. */

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-group-')); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, '.parley')); return dir; };
const posted = (dir) => readFileSync(join(dir, '.parley', 'from-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const written = (dir) => readFileSync(join(dir, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setImmediate(r));
const THREE = [
    { id: 'when', label: 'When', question: 'Deploy now?', choices: ['Now', 'Tomorrow'] },
    { id: 'which', label: 'Batches', question: 'Which batches next?', choices: ['A', 'B', 'C'], many: true },
    { id: 'note', label: 'Note', question: 'Anything I must know first?' },
];

test('the command: --group - takes the questions as JSON on standard input; one ask line, its text saying them all', (t) => {
    const dir = folder(t);
    const ask = (args, stdin) => run(['ask', ...args], { cwd: dir, env: {}, stdin: () => stdin });
    const ok = ask(['--short', 'Three decisions', '--group', '-'], JSON.stringify({ question: 'Before I go on:', questions: THREE }));
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /3 questions as one card/);
    assert.equal(ask(['--group', '-'], JSON.stringify(THREE.slice(0, 2))).code, 0, 'a bare array too');
    const [line, bare] = posted(dir);
    assert.equal(line.kind, 'ask');
    assert.equal(line.short, 'Three decisions');
    assert.equal(line.intro, 'Before I go on:');
    assert.deepEqual(line.choices, [], 'no choices of its own: an older screen shows no buttons that would answer only one');
    assert.deepEqual(line.questions, [
        { id: 'when', label: 'When', question: 'Deploy now?', choices: ['Now', 'Tomorrow'] },
        { id: 'which', label: 'Batches', question: 'Which batches next?', choices: ['A', 'B', 'C'], many: true },
        { id: 'note', label: 'Note', question: 'Anything I must know first?', choices: [] },
    ]);
    assert.equal(line.text, 'Before I go on:\n\n1. Deploy now? (Now / Tomorrow)\n2. Which batches next? (several: A / B / C)\n3. Anything I must know first?', 'an older screen, or reader, reads them all');
    assert.equal(bare.intro, undefined);
    /* Refused, nothing posted. */
    const refused = [
        [['--group', '-'], 'not json', 64],
        [['--group', 'x'], '[]', 64],
        [['--group', '-', '--pick-many'], JSON.stringify(THREE), 64],
        [['--group', '-'], JSON.stringify(THREE.slice(0, 1)), 1],
        [['--group', '-'], JSON.stringify(Array.from({ length: GROUP_MAX + 1 }, (_, i) => ({ question: `q${i}` }))), 1],
        [['--group', '-'], JSON.stringify([{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }]), 1],
        [['--group', '-'], JSON.stringify([{ id: 'a b', question: 'x' }, { question: 'y' }]), 1],
        [['--group', '-'], JSON.stringify([{ question: 'x', choices: ['one'], many: true }, { question: 'y' }]), 1],
        [['--group', '-'], JSON.stringify([{ question: '' }, { question: 'y' }]), 1],
    ];
    for (const [args, stdin, code] of refused) assert.equal(ask(args, stdin).code, code, `${args.join(' ')} ${stdin}`);
    assert.equal(posted(dir).length, 2);
    /* Ids by default: q1, q2... */
    assert.equal(ask(['--group', '-'], JSON.stringify([{ question: 'x' }, { question: 'y' }])).code, 0);
    assert.deepEqual(posted(dir).at(-1).questions.map((q) => q.id), ['q1', 'q2']);
    assert.match(HELP, /--group -/);
    assert.match(GUIDE, /several decisions at once: --group, one card\n {19}\(5 questions at most, never more\)/);
    assert.ok(/^[\x20-\x7e\n]+$/.test(GUIDE), 'the guide stays plain ASCII');
});

test('MCP: ask takes questions, five at most, each described; the guidance says when to group', async (t) => {
    const dir = folder(t);
    const ask = TOOLS.find((x) => x.name === 'ask');
    const qs = ask.inputSchema.properties.questions;
    assert.equal(qs.type, 'array');
    assert.equal(qs.maxItems, GROUP_MAX);
    assert.deepEqual(Object.keys(qs.items.properties), ['id', 'label', 'question', 'choices', 'many']);
    assert.deepEqual(qs.items.required, ['question']);
    assert.ok(ask.description.includes(GROUPING));
    assert.match(GROUPING, /5 questions at most, never more/);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => { out += d; });
    serve(join(dir, '.parley'), { input, output });
    const call = (id, args) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask', arguments: args } })}\n`);
    call(1, { short: 'Three decisions', questions: THREE });
    call(2, { questions: [THREE[0]] });
    call(3, {});
    input.end();
    await new Promise((r) => setTimeout(r, 50));
    const replies = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(replies[0].result.isError, undefined);
    assert.match(replies[0].result.content[0].text, /call read/);
    assert.equal(replies[1].result.isError, true);
    assert.equal(replies[2].result.isError, true, 'neither question nor questions');
    assert.equal(posted(dir).length, 1);
    assert.equal(posted(dir)[0].questions.length, 3);
});

test('the answer: one line, replies by id in the order asked, a text that says them; read gives each by its id', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('Before I go on:', undefined, { short: 'Three decisions', questions: THREE });
    const host = new Parley(join(dir, '.parley'));
    const q = host.read().messages.at(-1);
    assert.deepEqual(q.questions.map((x) => x.id), ['when', 'which', 'note']);
    assert.equal(q.intro, 'Before I go on:');
    assert.equal(host.read().waiting, 1, 'one question waiting, not three');
    host.say('', q.id, [], { replies: [{ id: 'note', text: ' No deploy on Friday. ' }, { id: 'which', picked: ['C', 'A'] }, { id: 'when', picked: ['Tomorrow'] }] });
    const line = written(dir).at(-1);
    assert.equal(line.answers, q.id);
    assert.equal(line.question, 'Before I go on:', 'the agent is reminded of it by its introduction, not by the whole list');
    assert.deepEqual(line.replies, [{ id: 'when', label: 'When', picked: ['Tomorrow'] }, { id: 'which', label: 'Batches', picked: ['A', 'C'] }, { id: 'note', label: 'Note', text: 'No deploy on Friday.' }]);
    assert.equal(line.text, '1. When: Tomorrow\n2. Batches: A, C\n3. Note: No deploy on Friday.', 'an older agent reads the text');
    assert.equal(host.read().waiting, 0);
    assert.deepEqual(host.read().messages.at(-1).replies, line.replies);
    assert.equal(agent.read().split('\n').slice(0, 4).join('\n'), `[${line.id.slice(0, 8)}] Answer to your question "Before I go on:": \n  1. [when] When: "Tomorrow"\n  2. [which] Batches: they ticked "A", "C"\n  3. [note] Note, in their own words: No deploy on Friday.`);
    assert.match(agent.read({ all: true }), /You asked them 3 questions at once: Before I go on:/);
});

test('the host refuses what the questions do not have; an answer typed in the box still answers them all', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('', undefined, { questions: THREE });
    agent.ask('Blue or red?', ['blue', 'red']);
    const host = new Parley(join(dir, '.parley'));
    const [q, single] = host.read().messages;
    const all = (over) => [{ id: 'when', picked: ['Now'] }, { id: 'which', picked: ['A'] }, { id: 'note', text: 'none' }].map((r) => over[r.id] ?? r);
    const refuse = (replies, why) => assert.throws(() => host.say('', q.id, [], { replies }), why);
    refuse(all({ when: { id: 'when', picked: ['Later'] } }), /when: only its choices/);
    refuse(all({ when: { id: 'when', picked: ['Now', 'Tomorrow'] } }), /when: one choice only/);
    refuse(all({ which: { id: 'which', picked: [] } }), /which: only its choices, one at least/);
    refuse(all({ note: { id: 'note', text: '  ' } }), /note: no answer/);
    refuse(all({ note: { id: 'note', text: 'x', picked: ['y'] } }), /note: a choice or their own words, not both/);
    refuse([...all({}), { id: 'other', text: 'x' }], /No question has the id other/);
    refuse([...all({}), { id: 'note', text: 'again' }], /Two answers to note/);
    refuse(all({}).slice(0, 2), /Answer every question/);
    refuse('nope', /only for questions asked together/);
    assert.throws(() => host.say('', single.id, [], { replies: all({}) }), /only for questions asked together/);
    assert.equal(existsSync(join(dir, '.parley', 'to-agent.jsonl')), false, 'nothing written by a refused one');
    /* Their own words for a question with choices. */
    host.say('', q.id, [], { replies: all({ when: { id: 'when', text: 'After lunch' } }) });
    assert.deepEqual(written(dir).at(-1).replies[0], { id: 'when', label: 'When', text: 'After lunch' });
    /* Typed in the box (an older screen): a plain answer, read as before. */
    agent.ask('', undefined, { questions: THREE.slice(0, 2) });
    const q2 = host.read().messages.filter((m) => m.kind === 'ask').at(-1);
    host.say('Tomorrow, and A only', q2.id);
    assert.match(agent.read(), /Answer to your question "2 questions": Tomorrow, and A only/);
});

test('old lines and forged ones: a questions field the host cannot trust is dropped, the text stays', (t) => {
    const dir = folder(t);
    const at = new Date().toISOString();
    appendFileSync(join(dir, '.parley', 'from-agent.jsonl'), [
        { id: 'a', at, kind: 'ask', text: 'one only', questions: [{ id: 'x', question: 'q' }] },
        { id: 'b', at, kind: 'ask', text: 'bad ids', questions: [{ id: 'x y', question: 'q' }, { id: 'x', question: 'r' }, { id: 'x', question: 's' }] },
        { id: 'c', at, kind: 'ask', text: 'fine', questions: [...Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: `Q${i}`, choices: ['a'], many: true }))] },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const [a, b, c] = new Parley(join(dir, '.parley')).read().messages;
    assert.equal(a.questions, undefined);
    assert.equal(b.questions, undefined, 'one left once the bad and the repeated are gone: none');
    assert.equal(c.questions.length, GROUP_MAX);
    assert.equal(c.questions[0].many, undefined, 'many needs two choices');
    assert.equal(a.text, 'one only');
});

test('the screen: one card, a step each, a summary with Modify, one Send; what is started survives the thread drawn again', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const sent = [];
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    let data = { messages: [{ from: 'agent', id: 'g', at: at(0), kind: 'ask', text: '1. Deploy now? ...', intro: 'Before I go on:', choices: [], questions: THREE.map((q) => ({ choices: [], ...q })) }] };
    const handle = mount(root, { load: async () => data, send: async (...args) => { sent.push(args); }, words: texts('en'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => root.querySelectorAll(s);
    const bubble = $('.parley-said');
    assert.equal($('.parley-label').textContent, 'It asks you · 3 questions');
    assert.equal(bubble.querySelector('.parley-text').textContent, 'Before I go on:', 'its introduction, not the list meant for older screens');
    assert.equal(bubble.children.filter((c) => c.classList.contains('parley-reply-to')).length, 0, 'no Reply under the card: Other answer is in each step');
    assert.deepEqual($$('.parley-questions-tab').map((b) => b.textContent), ['1When', '2Batches', '3Note', 'Summary']);
    assert.equal($('.parley-questions-step').textContent, 'Question 1/3');
    assert.match($('.parley-replying').textContent, /Before I go on:/, 'the box answers it by its introduction');
    /* Step 1: one choice moves on. */
    $('.parley-questions').querySelector('.parley-choices').querySelectorAll('button')[1].click();
    assert.equal($('.parley-questions-step').textContent, 'Question 2/3');
    assert.equal($$('.parley-questions-tab')[0].dataset.done, 'true');
    /* Step 2: several to tick. */
    const picks = () => $$('.parley-pick');
    assert.equal($('.parley-questions-hint').textContent, 'Several possible');
    picks()[2].click(); picks()[0].click();
    assert.deepEqual(picks().map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'true']);
    /* The thread drawn again (something new): nothing started is lost. */
    const before = $('.parley-questions');
    data = { ...data, status: { state: 'waiting', note: 'your call', at: at(1) } };
    root.querySelector('button[data-view="detailed"]')?.click(); await settle(); await settle();
    root.querySelector('button[data-view="simple"]')?.click(); await settle(); await settle();
    assert.notEqual($('.parley-questions'), before, 'the card was drawn again');
    assert.equal($('.parley-questions-step').textContent, 'Question 2/3', 'the step kept');
    assert.deepEqual(picks().map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'true'], 'the ticks kept');
    $('.parley-questions-next').click();
    /* Step 3: free; the summary says what is missing, Send waits. */
    assert.equal($('.parley-questions-free').placeholder, 'Your answer');
    $('.parley-questions-next').click();
    assert.equal($('.parley-questions-question').textContent, 'Check before sending');
    assert.deepEqual($$('.parley-questions-answer').map((d) => [d.textContent, d.dataset.missing]), [['Tomorrow', undefined], ['A, C', undefined], ['No answer yet', 'true']]);
    assert.equal($('.parley-questions-send').textContent, 'Send the 3 answers');
    assert.equal($('.parley-questions-send').disabled, true);
    $$('.parley-questions-modify')[2].click();
    const free = $('.parley-questions-free');
    free.value = 'No deploy on Friday.'; free.dispatchEvent(fakeEvent('input'));
    /* Other answer on step 1: their own words instead of the choice. */
    $$('.parley-questions-tab')[0].click();
    $('.parley-questions').querySelector('.parley-other').click();
    const own = $('.parley-questions-free');
    own.value = 'After lunch'; own.dispatchEvent(fakeEvent('input'));
    $$('.parley-questions-tab')[3].click();
    assert.deepEqual($$('.parley-questions-answer').map((d) => d.textContent), ['After lunch', 'A, C', 'No deploy on Friday.']);
    assert.equal(sent.length, 0, 'nothing sent before Send');
    $('.parley-questions-send').click();
    await settle();
    assert.deepEqual(sent, [['1. When: After lunch\n2. Batches: A, C\n3. Note: No deploy on Friday.', 'g', undefined,
        { replies: [{ id: 'when', text: 'After lunch' }, { id: 'which', picked: ['A', 'C'] }, { id: 'note', text: 'No deploy on Friday.' }] }]]);
    for (const key of ['group-count', 'group-step', 'group-next', 'group-back', 'group-review', 'group-check', 'group-modify', 'group-send', 'group-several', 'group-own', 'group-missing']) {
        assert.ok(KEYS.includes(key), key);
        assert.ok(texts('fr')[key] && texts('fr')[key] !== texts('en')[key] || ['group-count', 'group-step'].includes(key), `fr ${key}`);
    }
});

test('the screen: an answer in one\'s own words is written in one box, kept with its focus and its cursor when typed in and when the thread is drawn again (a touch screen\'s keyboard stays open)', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    let data = { messages: [{ from: 'agent', id: 'g', at: at(0), kind: 'ask', text: '1. Note ...', intro: 'Two things', choices: [], questions: [THREE[2], THREE[0]] }] };
    const handle = mount(root, { load: async () => data, send: async () => {}, words: texts('en'), every: 0, touch: true });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const $ = (s) => root.querySelector(s);
    const free = $('.parley-questions-free');
    free.focus();
    let range = null;
    free.selectionStart = 0; free.selectionEnd = 0;
    free.setSelectionRange = (from, to) => { range = [from, to]; };
    /* The first letter: the tab says it is answered, and the box is the same, still focused. */
    free.value = 'N'; free.dispatchEvent(fakeEvent('input'));
    assert.equal($('.parley-questions-tab').dataset.done, 'true');
    assert.equal($('.parley-questions-free'), free, 'not made again');
    assert.equal(document.activeElement, free, 'the focus stays');
    /* All of it erased: the tab says so, the box is still the one. */
    free.value = ''; free.dispatchEvent(fakeEvent('input'));
    assert.equal($('.parley-questions-tab').dataset.done, 'false');
    assert.equal($('.parley-questions-tab').textContent, '1Note');
    assert.equal(document.activeElement, free);
    /* Something new in the thread while a word in the middle is corrected: the same box, the focus and the cursor back. */
    free.value = 'No deploy on Friday.'; free.dispatchEvent(fakeEvent('input'));
    free.selectionStart = 3; free.selectionEnd = 9;
    data = { ...data, messages: [...data.messages, { from: 'agent', id: 'n', at: at(1), kind: 'say', text: 'Still here.' }] };
    await handle.refresh(); await settle();
    assert.ok(root.querySelectorAll('.parley-said').length >= 2, 'the thread was drawn again');
    assert.equal($('.parley-questions-free'), free, 'the same box, moved');
    assert.equal(free.value, 'No deploy on Friday.');
    assert.equal(document.activeElement, free, 'given the focus back');
    assert.deepEqual(range, [3, 9], 'the cursor where it was');
});

test('the screen: a field being written in is the browser\'s -- a right click or a long press in it (a word underlined by the spellchecker, to correct it) opens no reactions, takes no focus, marks nothing; the panel is not written again over the box at every change of size', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    const data = { messages: [{ from: 'agent', id: 'g', at: at(0), kind: 'ask', text: '1. Note ...', intro: 'Two things', choices: [], questions: [THREE[2], THREE[0]] }] };
    const handle = mount(root, { load: async () => data, send: async () => {}, react: async () => {}, words: texts('en'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const $ = (s) => root.querySelector(s);
    const picker = $('.parley-react');
    for (const field of [$('.parley-questions-free'), $('.parley-box')]) {
        field.focus();
        const menu = fakeEvent('contextmenu', { target: field });
        field.dispatchEvent(menu);
        assert.equal(menu.defaultPrevented, false, `${field.className}: the browser's own menu`);
        assert.equal(picker.hidden, true, `${field.className}: no reactions`);
        assert.equal(document.activeElement, field, `${field.className}: the focus stays, so does the keyboard`);
        field.dispatchEvent(fakeEvent('pointerdown', { target: field, pointerType: 'touch' }));
        await new Promise((r) => setTimeout(r, PRESS_MS + 50));
        assert.equal(root.querySelectorAll('.parley-said[data-reveal]').length, 0, `${field.className}: a press in it marks nothing`);
        assert.equal(document.activeElement, field);
    }
    /* Out of the field, on the message itself: a mouse's right click still opens its reactions. */
    const bubble = $('.parley-said[data-id="g"]');
    const menu = fakeEvent('contextmenu', { target: bubble, pointerType: 'mouse' });
    bubble.dispatchEvent(menu);
    assert.equal(menu.defaultPrevented, true);
    assert.equal(picker.hidden, false);
    /* The panel: its place written once, not again while it stays. */
    let writes = 0;
    const set = root.setAttribute.bind(root);
    root.setAttribute = (name, value) => { if (name === 'data-panel') writes += 1; set(name, value); };
    handle.side = { title: 'Batches', items: [{ id: '1', title: 'One' }] };
    handle.side = { title: 'Batches', items: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }] };
    assert.equal(root.dataset.panel, 'beside');
    assert.equal(writes, 1, 'written when it changed only');
});

test('the screen\'s data: answered, the card is gone and its text is read; no quick answers for it', () => {
    const at = (n) => new Date(Date.UTC(2026, 9, 24, 9, n)).toISOString();
    const asked = { from: 'agent', id: 'g', at: at(0), kind: 'ask', text: '1. a\n2. b', intro: 'Two things', choices: [], questions: [{ id: 'a', question: 'a', choices: ['x', 'y'] }, { id: 'b', question: 'b', choices: [] }] };
    const open = view({ messages: [asked] }, { words: texts('en') }).items[0];
    assert.equal(open.questions.length, 2);
    assert.equal(open.text, 'Two things');
    assert.deepEqual(quick({ messages: [asked] }), []);
    const done = view({ messages: [asked, { from: 'person', id: 'p', at: at(1), kind: 'say', text: '1. a: x\n2. b: z', answers: 'g', question: 'Two things' }] }, { words: texts('en') }).items[0];
    assert.deepEqual(done.questions, []);
    assert.equal(done.text, '1. a\n2. b');
});

test('a short version too long is told to the agent, so it does not miss the screen cutting it (#51)', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    const longShort = 'This is a very long short version that reads like a whole paragraph and clearly will not fit a title of one or two lines at all';
    assert.match(agent.tell('The full message.', { short: longShort }), /Your short version is long/, 'tell: told when the short is too long');
    assert.equal(agent.tell('The full message.', { short: 'A short title' }).includes('Your short version is long'), false, 'a real short title: nothing said');
    assert.match(agent.ask('Go on?', ['yes', 'no'], { short: longShort }), /Your short version is long/, 'ask: told too');
    assert.match(agent.ask('Before I go:', undefined, { short: longShort, questions: [{ question: 'A?' }, { question: 'B?' }] }), /Your short version is long/, 'grouped ask: told too');
});

test('a message or short longer than the tool keeps is refused, never cut and sent in pieces (#51)', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    assert.throws(() => agent.tell('x'.repeat(16001)), /Nothing was sent/, 'a too-long message is refused, not truncated');
    assert.throws(() => agent.tell('A message.', { short: 'y'.repeat(1001) }), /Nothing was sent/, 'a too-long short is refused');
    assert.throws(() => agent.ask('q'.repeat(16001), ['a', 'b']), /Nothing was sent/, 'a too-long question is refused');
    assert.doesNotThrow(() => agent.tell('A normal message.'), 'a message within the limit still goes');
});
