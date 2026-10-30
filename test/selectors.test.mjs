import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePage } from './fake-dom.mjs';
import { texts } from '../host/parley-host.mjs';
import { mount } from '../ui/parley-ui.js';
import { run } from '../bin/parley.mjs';
import { bridge } from '../server/parley-mcp.mjs';

/* SELECTORS FOR ANSWERS (#195): a question may carry an `input` -- a slider, a range, a scale,
   stars, a number, a ranking, a split, a small table, a date, text, yes/no -- checked by the
   server, drawn by the screen on one card with the other questions, answered in plain words. */

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-sel-')); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, '.parley')); return dir; };
const posted = (dir) => readFileSync(join(dir, '.parley', 'from-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setImmediate(r));

test('the server keeps a selector checked, says it in the text, and refuses one out of shape', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    assert.match(agent.ask('Importance ?', undefined, { input: { kind: 'slider', min: 0, max: 100, value: 70, labels: ['secondaire', 'essentiel'] } }), /the question with its selector/);
    const one = posted(dir).at(-1);
    assert.deepEqual(one.questions, [{ id: 'answer', question: 'Importance ?', choices: [], input: { kind: 'slider', min: 0, max: 100, step: 1, labels: ['secondaire', 'essentiel'], value: 70 } }]);
    assert.match(one.text, /Importance \? \(slider 0–100\)/);
    agent.ask('Réglages', undefined, { steps: true, questions: [{ id: 'b', question: 'Budget', input: { kind: 'range', min: 0, max: 50, unit: 'k€', value: [20, 10] } }, { id: 'o', question: 'Ordre', input: { kind: 'rank', items: ['A', 'B'] } }] });
    const two = posted(dir).at(-1);
    assert.equal(two.steps, true);
    assert.deepEqual(two.questions[0].input.value, [10, 20], 'a range kept in order');
    for (const bad of [{ kind: 'dial' }, { kind: 'slider', min: 10, max: 5 }, { kind: 'rank', items: ['only'] }, { kind: 'scale', min: 0, max: 20 }, { kind: 'stars', max: 1 }]) {
        assert.throws(() => agent.ask('Q', undefined, { input: bad }), /question 1/, JSON.stringify(bad));
    }
    assert.throws(() => agent.ask('R', undefined, { questions: [{ question: 'a', choices: ['x', 'y'], input: { kind: 'yesno' } }] }), /choices or an input, not both/);
});

test('the command takes a selector as JSON on standard input', (t) => {
    const dir = folder(t);
    const r = run(['ask', '--group', '-'], { cwd: dir, env: {}, stdin: () => JSON.stringify({ question: 'Mémoire ?', input: { kind: 'number', min: 2, max: 16, unit: 'Go', value: 4 } }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(posted(dir).at(-1).questions[0].input.kind, 'number');
});

test('the screen: questions on one card, each with its control; Send once all are answered; the answer in plain words', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const sent = [];
    const at = new Date(Date.UTC(2026, 9, 30, 9, 0)).toISOString();
    const data = { messages: [{ from: 'agent', id: 'g', at, kind: 'ask', text: 'Réglages', intro: 'Quelques réglages', choices: [], questions: [
        { id: 'imp', label: 'Importance', question: 'Importance ?', input: { kind: 'slider', min: 0, max: 100, step: 10, value: 70 } },
        { id: 'ok', question: 'On y va ?', input: { kind: 'yesno' } },
        { id: 'qui', question: 'Qui fait quoi ?', input: { kind: 'split', items: ['Moi', 'Claude'], total: 100, unit: '%' } },
        { id: 'ord', question: 'Ordre ?', input: { kind: 'rank', items: ['Guichet', 'Meet'] } },
    ] }] };
    const handle = mount(root, { load: async () => data, send: async (...args) => { sent.push(args); }, words: texts('fr'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const $ = (s) => root.querySelector(s);
    assert.ok($('.parley-series'), 'one card, all questions on it (not tabs)');
    assert.equal(root.querySelectorAll('.parley-questions-tab').length, 0);
    assert.equal(root.querySelectorAll('.parley-series-q').length, 4);
    const send = $('.parley-questions-send');
    assert.equal(send.disabled, true, 'yes/no is not answered yet');
    $('.parley-input-yesno').querySelectorAll('button')[0].click();
    assert.equal(send.disabled, false);
    /* The ranking: Meet goes up. */
    $('.parley-input-rank').querySelectorAll('li')[1].querySelectorAll('button')[0].click();
    send.click(); await settle();
    assert.equal(sent.length, 1);
    const [text, re, , extra] = sent[0];
    assert.equal(re, 'g');
    assert.equal(text, '1. Importance: 70\n2. On y va ?: Oui\n3. Qui fait quoi ?: Moi 50 % · Claude 50 %\n4. Ordre ?: Meet > Guichet');
    assert.deepEqual(extra.replies.map((r) => [r.id, r.value]), [['imp', 70], ['ok', true], ['qui', [50, 50]], ['ord', ['Meet', 'Guichet']]]);
});

test('the screen: one question with a selector is a card of one; steps: true keeps the tabs', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const at = new Date(Date.UTC(2026, 9, 30, 9, 0)).toISOString();
    let data = { messages: [{ from: 'agent', id: 'a', at, kind: 'ask', text: 'Note ?', choices: [], questions: [{ id: 'answer', question: 'Note ?', input: { kind: 'stars', max: 5 } }] }] };
    const sent = [];
    const handle = mount(root, { load: async () => data, send: async (...args) => { sent.push(args); }, words: texts('fr'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    assert.equal(root.querySelectorAll('.parley-series-q').length, 1);
    assert.equal(root.querySelectorAll('.parley-reply-to').length, 0, 'no Reply under it: the card answers');
    root.querySelector('.parley-input-stars').querySelectorAll('button')[3].click();
    root.querySelector('.parley-questions-send').click(); await settle();
    assert.equal(sent[0][0], '★★★★☆ (4/5)');
    handle.destroy();
    data = { messages: [{ from: 'agent', id: 'b', at, kind: 'ask', steps: true, text: 'x', choices: [], questions: [{ id: 'x', question: 'X ?', input: { kind: 'number', min: 1, max: 9 } }, { id: 'y', question: 'Y ?' }] }] };
    const root2 = document.createElement('div'); document.body.append(root2);
    const h2 = mount(root2, { load: async () => data, send: async () => {}, words: texts('fr'), every: 0, touch: false });
    await settle(); await settle();
    assert.ok(root2.querySelectorAll('.parley-questions-tab').length >= 2, 'steps: tabs');
    assert.ok(root2.querySelector('.parley-input-number'), 'and the selector in its step');
    h2.destroy();
});

test('the host passes a selector on to the page (and one question alone with it), and takes its answer', async (t) => {
    const { Parley } = await import('../host/parley-host.mjs');
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('Avis', undefined, { steps: true, questions: [{ id: 'note', question: 'Note ?', input: { kind: 'stars', max: 5 } }, { id: 'ord', question: 'Ordre ?', input: { kind: 'rank', items: ['A', 'B'] } }] });
    agent.ask('Mémoire ?', undefined, { input: { kind: 'number', min: 2, max: 16, unit: 'Go', value: 4 } });
    const host = new Parley(join(dir, '.parley'));
    const [two, one] = host.read().messages;
    assert.deepEqual(two.questions.map((q) => q.input), [{ kind: 'stars', max: 5 }, { kind: 'rank', items: ['A', 'B'] }]);
    assert.equal(two.steps, true);
    assert.deepEqual(one.questions[0].input, { kind: 'number', min: 2, max: 16, step: 1, unit: 'Go', value: 4 });
    host.say('', one.id, [], { replies: [{ id: 'answer', text: '8 Go' }] });
    assert.match(readFileSync(join(dir, '.parley', 'to-agent.jsonl'), 'utf8'), /8 Go/);
});
