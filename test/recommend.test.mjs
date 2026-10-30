import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePage } from './fake-dom.mjs';
import { texts, Parley } from '../host/parley-host.mjs';
import { mount } from '../ui/parley-ui.js';
import { run } from '../bin/parley.mjs';
import { bridge, TOOLS } from '../server/parley-mcp.mjs';

/* WHAT THE AGENT RECOMMENDS, AND THE REPLY IT SUGGESTS (#198): only when it does; marked, never decided for them. */

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-rec-')); t.after(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, '.parley')); return dir; };
const posted = (dir) => readFileSync(join(dir, '.parley', 'from-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setImmediate(r));

test('the agent: a choice recommended among its choices, a selector starting where it recommends, a reply suggested; checked', (t) => {
    const dir = folder(t);
    const agent = bridge(join(dir, '.parley'));
    agent.ask('On déploie ?', ['Maintenant', 'Ce soir', 'Demain'], { recommended: 'Ce soir', suggest: 'Ce soir, après 20 h' });
    assert.deepEqual([posted(dir).at(-1).recommended, posted(dir).at(-1).suggest], [['Ce soir'], 'Ce soir, après 20 h']);
    assert.throws(() => agent.ask('X ?', ['A', 'B'], { recommended: 'C' }), /one of its choices/);
    assert.throws(() => agent.ask('X ?', ['A', 'B'], { recommended: ['A', 'B'] }), /one choice recommended/);
    agent.ask('Lesquels ?', ['A', 'B', 'C'], { many: true, recommended: ['A', 'C'] });
    assert.deepEqual(posted(dir).at(-1).recommended, ['A', 'C']);
    agent.ask('Réglages', undefined, { questions: [
        { id: 'mem', question: 'Mémoire ?', input: { kind: 'number', min: 2, max: 16, value: 4, recommended: 8 } },
        { id: 'ok', question: 'On redémarre ?', input: { kind: 'yesno', recommended: 'yes' } },
        { id: 'ord', question: 'Ordre ?', input: { kind: 'rank', items: ['A', 'B', 'C'], recommended: ['C', 'A', 'B'] } },
        { id: 'qui', question: 'Qui ?', choices: ['Moi', 'Toi'], recommended: 'Toi' },
    ] });
    const qs = posted(dir).at(-1).questions;
    assert.deepEqual(qs[0].input, { kind: 'number', min: 2, max: 16, step: 1, value: 8, recommended: 8 }, 'it starts where it is recommended');
    assert.equal(qs[1].input.recommended, 'yes');
    assert.deepEqual(qs[2].input, { kind: 'rank', items: ['C', 'A', 'B'], recommended: true });
    assert.deepEqual(qs[3].recommended, ['Toi']);
    for (const [input, why] of [[{ kind: 'number', min: 2, max: 16, recommended: 40 }, /between min and max/], [{ kind: 'rank', items: ['A', 'B'], recommended: ['A', 'C'] }, /same items/], [{ kind: 'yesno', recommended: 'maybe' }, /"yes" or "no"/], [{ kind: 'text', recommended: 'x' }, /recommended is for/]]) {
        assert.throws(() => agent.ask('R', undefined, { questions: [{ id: 'a', question: 'a', input }] }), why);
    }
    agent.tell('Fini.', { suggest: 'Merci, on passe à la suite' });
    assert.equal(posted(dir).at(-1).suggest, 'Merci, on passe à la suite');
    assert.throws(() => agent.tell('x', { suggest: 'y'.repeat(1001) }), /1000/);
    /* Said to every agent: the tools describe it. */
    const ask = TOOLS.find((x) => x.name === 'ask'); const tell = TOOLS.find((x) => x.name === 'tell');
    assert.ok(ask.inputSchema.properties.recommended && ask.inputSchema.properties.suggest && tell.inputSchema.properties.suggest);
});

test('the command: --recommend and --suggest', (t) => {
    const dir = folder(t);
    const cmd = (...args) => run(args, { cwd: dir, env: {}, stdin: () => '' });
    assert.equal(cmd('ask', 'Quand ?', '--choice', 'Lundi', '--choice', 'Mardi', '--recommend', 'Mardi', '--suggest', 'Mardi matin').code, 0);
    assert.deepEqual([posted(dir).at(-1).recommended, posted(dir).at(-1).suggest], [['Mardi'], 'Mardi matin']);
    assert.equal(cmd('tell', 'Prêt.', '--suggest', 'Vas-y').code, 0);
    assert.equal(posted(dir).at(-1).suggest, 'Vas-y');
    assert.match(cmd('ask', 'Quand ?', '--choice', 'Lundi', '--recommend', 'Jeudi').err, /one of its choices/);
});

test('the host hands them on, filtered: a recommended choice that is not one is dropped', (t) => {
    const dir = folder(t);
    const at = new Date().toISOString();
    appendFileSync(join(dir, '.parley', 'from-agent.jsonl'), `${JSON.stringify({ id: 'q1', at, kind: 'ask', text: 'Quand ?', choices: ['Lundi', 'Mardi'], recommended: ['Mardi', 'Jeudi'], suggest: 'Mardi' })}\n${JSON.stringify({ id: 'q2', at, kind: 'ask', text: 'R', choices: [], questions: [{ id: 'a', question: 'A ?', input: { kind: 'slider', min: 0, max: 10, value: 7, recommended: 7 } }, { id: 'b', question: 'B ?', choices: ['x', 'y'], recommended: ['y', 'z'] }] })}\n`);
    const got = new Parley(join(dir, '.parley')).read();
    const [one, two] = got.messages.filter((m) => m.from === 'agent');
    assert.deepEqual([one.recommended, one.suggest], [['Mardi'], 'Mardi']);
    assert.equal(two.questions[0].input.recommended, 7);
    assert.deepEqual(two.questions[1].recommended, ['y']);
});

test('the screen: "Recommended" on the choice, the card starts on it; the suggested reply above an empty box, Tab or a click makes it theirs', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const at = new Date(Date.UTC(2026, 9, 30, 9, 0)).toISOString();
    const sent = [];
    const data = { messages: [
        { from: 'agent', id: 'q', at, kind: 'ask', text: 'On déploie ?', choices: ['Maintenant', 'Ce soir'], recommended: ['Ce soir'] },
        { from: 'agent', id: 'g', at, kind: 'ask', text: 'R', choices: [], questions: [{ id: 'm', question: 'Mémoire ?', input: { kind: 'number', min: 2, max: 16, step: 1, value: 8, recommended: 8 } }, { id: 'w', question: 'Qui ?', choices: ['Moi', 'Toi'], recommended: ['Toi'] }] },
        { from: 'agent', id: 's', at, kind: 'say', text: 'Je peux lancer ?', suggest: 'Oui, lance-le' },
    ] };
    const handle = mount(root, { load: async () => data, send: async (...args) => { sent.push(args); }, words: texts('fr'), every: 0, touch: false });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    const marked = [...root.querySelectorAll('[data-recommended="true"]')];
    assert.ok(marked.some((b) => b.textContent.includes('Ce soir') && b.textContent.includes('Recommandé')));
    assert.match(root.querySelector('.parley-input-number').textContent, /Recommandé : 8/);
    const send = root.querySelector('.parley-questions-send');
    assert.equal(send.disabled, false, 'started on what it recommends: ready to send as it is');
    send.click(); await settle();
    assert.equal(sent[0][0], '1. Mémoire ?: 8\n2. Qui ?: Toi');
    const offer = root.querySelector('.parley-suggest');
    assert.equal(offer.hidden, false);
    assert.match(offer.textContent, /Oui, lance-le/);
    offer.click();
    assert.equal(root.querySelector('.parley-box').value, 'Oui, lance-le', 'theirs: in the box, to send or change');
    assert.equal(offer.hidden, true);
});
