import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePage } from './fake-dom.mjs';
import { mount, view } from '../ui/parley-ui.js';
import { Parley, texts } from '../host/parley-host.mjs';

const settle = () => new Promise((r) => setTimeout(r, 20));
const at = (k) => new Date(Date.UTC(2030, 0, 1, 10, k)).toISOString();
const room = { id: 'room-1', name: 'Assistants', message: 'm1' };
const fr = texts('fr');

async function shown(t, messages, more = {}) {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const handle = mount(root, { load: async () => ({ messages, ...more }), send: async () => {}, words: fr, every: 0, touch: false, markdown: true, locale: 'fr-FR' });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    return root;
}

test('in a room, what the AIs say to one another is folded under one line; what is said to all stays in sight (06-11)', async (t) => {
    const messages = [
        { from: 'person', id: 'p1', at: at(1), kind: 'say', text: 'Regarde les autres conversations.', refs: [], choices: [] },
        { from: 'agent', id: 'a1', at: at(2), kind: 'say', text: 'Bonjour, quels sujets couvres-tu ?', by: { id: 'thomas', name: 'Thomas', kind: 'ai', look: { initial: 'M', hue: 40 } }, to: ['msm'], toNames: ['Main MSM'], refs: [], choices: [] },
        { from: 'agent', id: 'a2', at: at(3), kind: 'say', text: 'Bonjour, quels sujets couvres-tu ?', by: { id: 'thomas', name: 'Thomas', kind: 'ai' }, to: ['perso'], toNames: ['Main Perso'], refs: [], choices: [] },
        { from: 'agent', id: 'a3', at: at(4), kind: 'say', text: 'J’ai demandé aux deux, je te fais une synthèse.', by: { id: 'thomas', name: 'Thomas', kind: 'ai' }, refs: [], choices: [] },
    ];
    const v = view({ messages }, { words: fr });
    const folds = v.rows.filter((r) => r.type === 'aifold');
    assert.equal(folds.length, 1);
    assert.equal(folds[0].items.length, 2);
    assert.equal(folds[0].text, 'Entre les IA · 2 → Main MSM, Main Perso');
    assert.ok(v.rows.some((r) => r.id === 'a3'), 'said to all: in sight');
    const own = view({ messages: [{ from: 'agent', id: 'b1', at: at(5), kind: 'say', text: 'Il fait 18 degrés.', to: ['box-1'], toNames: ['Salon'], refs: [], choices: [] }] }, { words: fr });
    assert.equal(own.rows.filter((r) => r.type === 'aifold').length, 0, 'its own answer to a voice box is never folded');
    assert.equal(view({ messages }, { words: fr, view: 'detailed' }).rows.filter((r) => r.type === 'aifold').length, 0, 'the detailed view keeps every message');
    const root = await shown(t, messages);
    const fold = root.querySelector('.parley-roomfold[data-ais="true"]');
    assert.ok(fold, 'drawn as a fold');
    assert.equal(fold.querySelector('.parley-roomfold-open'), null, 'no « open the room »: it is the room');
    const sign = fold.querySelector('.parley-roomfold-signs')?.querySelector('.parley-look');
    assert.ok(sign, 'who speaks in it: its sign on the folded line (06-11)');
    assert.equal(sign.textContent, 'M'); assert.equal(sign.dataset.hue, '40');
});

test('a message to an AI of a room names it, never by its id (06-11: « → 4d9f6c73-… »)', async () => {
    const { bridge } = await import('../server/parley-mcp.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'parley-rf-'));
    try {
        const d = join(dir, '.parley'); mkdirSync(d);
        const own = new Parley(d);
        const msm = '4d9f6c73-522b-436c-9c83-1a70c2fa01b4';
        own.setRooms([{ id: 'room-1', name: 'Assistants', members: [{ id: msm, name: 'Main Sales', kind: 'ai' }] }]);
        own.say('Regarde.', undefined, [], { room: { id: 'room-1', name: 'Assistants', message: 'abcdef1234567890' } });
        const agent = bridge(d); agent.read();
        agent.tell('Bonjour, quels sujets ?', { room: 'room-1', to: [msm] });
        assert.deepEqual(own.read().messages.at(-1).toNames, ['Main Sales']);
        agent.tell(`J’ai demandé à @{${msm}}.`, { room: 'room-1' });
        assert.equal(own.read().messages.at(-1).text, 'J’ai demandé à @Main Sales.', 'a member named in the words: by its name');
        own.say(`@{${msm}} : une question.`, undefined, [], { room: { id: 'room-1', name: 'Assistants', message: 'abcdef1299' } });
        assert.equal(own.read().messages.at(-1).text, '@Main Sales : une question.', 'what came from the room too');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a speaker keeps its sign (letter, colour) through the host; a bad one is dropped', async () => {
    const { byOf } = await import('../host/parley-host.mjs');
    assert.deepEqual(byOf({ id: 'a', name: 'Thomas', kind: 'ai', look: { initial: 'M', hue: 40 } }).look, { initial: 'M', hue: 40 });
    assert.equal(byOf({ id: 'a', name: 'Thomas', look: { initial: 'MM', hue: 40 } }).look, undefined);
    assert.equal(byOf({ id: 'a', name: 'Thomas', look: { initial: 'M', hue: 400 } }).look, undefined);
});

test('in a conversation, a room fold shows a message that came with its steps as a message, never « [object …] » (06-11)', async (t) => {
    const room = { id: 'room-1', name: 'Assistants', message: 'm1' };
    const root = await shown(t, [
        { from: 'person', id: 'p1', at: at(1), kind: 'say', text: 'Regarde les autres conversations.', room, refs: [], choices: [] },
        { from: 'agent', id: 'a1', at: at(3), kind: 'say', text: 'J’ai demandé aux deux.', room, refs: [], choices: [] },
        { from: 'agent', id: 'z', at: at(9), kind: 'say', text: 'fin', refs: [], choices: [] },
    ], { steps: [{ kind: 'doing', text: 'Je lis le salon', at: at(2) }] });
    const walk = (n, out = []) => { if (n.nodeType === 3) out.push(n.data); for (const c of n.childNodes ?? []) walk(c, out); return out; };
    const folds = root.querySelectorAll('.parley-roomfold');
    assert.ok(folds.length);
    const text = folds.map((f) => walk(f).join(' ')).join(' | ');
    assert.doesNotMatch(text, /\[object /, text);
    assert.match(text, /J’ai demandé aux deux\./);
});

test('a room\'s thread is marked read by the application once its AIs have it: the clock goes (06-11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-seen-'));
    try {
        const d = join(dir, '.parley'); mkdirSync(d);
        const room = new Parley(d, { room: true });
        room.say('Bonjour à tous.');
        assert.equal(room.unread(), 1);
        assert.equal(room.seen(), 1);
        assert.equal(room.unread(), 0);
        assert.equal(room.seen(), 1, 'again: nothing changes');
        assert.throws(() => new Parley(d).seen(), /Only a room/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('in a room, a message for the person is marked, not tabbed « → Toi »; for the person and an AI, never folded (06-11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parley-you-'));
    try {
        const d = join(dir, '.parley'); mkdirSync(d);
        const room = new Parley(d, { room: true });
        room.setSpeakers([{ id: 'me', name: 'Toi', kind: 'person' }, { id: 'msm', name: 'Main Sales', kind: 'ai' }]);
        room.relay({ text: 'Pour toi.', by: { id: 'perso', name: 'Perso', kind: 'ai' }, to: ['me'] });
        room.relay({ text: 'Pour vous deux.', by: { id: 'perso', name: 'Perso', kind: 'ai' }, to: ['me', 'msm'] });
        room.relay({ text: 'Entre nous.', by: { id: 'perso', name: 'Perso', kind: 'ai' }, to: ['msm'] });
        const read = room.read();
        const [a, b, c] = read.messages.slice(-3);
        assert.equal(a.toYou, true); assert.deepEqual(a.toNames, []);
        assert.equal(b.toYou, true); assert.deepEqual(b.toNames, ['Main Sales']);
        assert.equal(c.toYou, undefined); assert.deepEqual(c.toNames, ['Main Sales']);
        const v = view(read, { words: fr });
        const fold = v.rows.find((r) => r.type === 'aifold');
        assert.deepEqual(fold.items.map((x) => x.text), ['Entre nous.'], 'only what is between the AIs folds');
        assert.ok(v.rows.some((r) => r.text === 'Pour toi.' && r.toYou), 'for the person: in sight, marked');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
