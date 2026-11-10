import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { fakePage, fakeEvent } from './fake-dom.mjs';
import { mount, view, since, KEYS } from '../ui/parley-ui.js';
import { ICONS } from '../ui/parley-icons.js';
import { texts } from '../host/parley-host.mjs';

const settle = () => new Promise((r) => setImmediate(r));
const at = (minute) => new Date(Date.parse('2026-01-05T06:00:00.000Z') + minute * 60_000).toISOString();
const messages = [
    { from: 'agent', id: 'a1', at: at(0), kind: 'say', text: 'We ship on Tuesdays.' },
    { from: 'person', id: 'p1', at: at(1), kind: 'say', text: 'The docs: https://docs.example.com', seen: true },
    { from: 'agent', id: 'a2', at: at(2), kind: 'say', text: 'Noted.' },
];
const pin = (id, minute, text, from = 'agent', by = 'person') => ({ id, at: at(minute), by, from, text, toAt: at(0) });

function chat(t, data, options = {}) {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    let current = data;
    const handle = mount(root, { load: async () => current, send: async () => {}, words: texts('en'), every: 0, touch: false, markdown: true, ...options });
    t.after(() => { handle.destroy(); leave(); });
    return { root, handle, set: (d) => { current = d; }, $: (s) => root.querySelector(s), $$: (s) => root.querySelectorAll(s) };
}

test('the words of pins are in both dictionaries; the pin icons are there; a look since a cursor brings the pins', () => {
    for (const key of ['pin', 'unpin', 'pinned', 'pinned-count', 'pinned-mark']) { assert.ok(KEYS.includes(key), key); assert.ok(texts('en')[key], key); assert.ok(texts('fr')[key], key); }
    assert.equal(texts('fr').pin, 'Épingler'); assert.equal(texts('fr').unpin, 'Désépingler'); assert.equal(texts('fr')['pinned-count'], '{count} épinglés');
    assert.ok(ICONS.pin && ICONS['pin-off']);
    const merged = since({ messages, pins: [], cursor: '1.1.1' }, { since: true, messages: [], pins: [pin('a1', 3, 'We ship on Tuesdays.')], cursor: '2.1.1' });
    assert.deepEqual(merged.pins.map((p) => p.id), ['a1']);
    /* The view: newest first, each message pinned marked. */
    const v = view({ messages, pins: [pin('a1', 3, 'We ship on Tuesdays.'), pin('p1', 4, 'The docs', 'person')] }, { words: texts('en') });
    assert.deepEqual(v.pins.map((p) => p.id), ['p1', 'a1']);
    assert.deepEqual(v.items.map((i) => [i.id, i.pinned]), [['a1', true], ['p1', true], ['a2', false]]);
});

test('the pinned bar: hidden without pins; the newest shown; the count and the list with two or more; a tap brings the message into sight', async (t) => {
    const c = chat(t, { messages }, { pin: async () => {} });
    await settle(); await settle();
    assert.equal(c.$('.parley-pins').hidden, true, 'nothing pinned, no bar');
    c.set({ messages, pins: [pin('a1', 3, 'We ship on Tuesdays.')] });
    await c.handle.refresh();
    assert.equal(c.$('.parley-pins').hidden, false);
    assert.equal(c.$('.parley-pins-text').textContent, 'We ship on Tuesdays.');
    assert.equal(c.$('.parley-pins-more').hidden, true, 'one pin: no count');
    assert.equal(c.$('.parley-said[data-id="a1"]').dataset.pinned, 'true');
    assert.ok(c.$('.parley-said[data-id="a1"]').querySelector('.parley-who').querySelector('.parley-pinned-mark'), 'marked beside its name and time');
    assert.equal(c.$('.parley-said[data-id="a2"]').querySelector('.parley-pinned-mark'), null);
    c.set({ messages, pins: [pin('a1', 3, 'We ship on Tuesdays.'), pin('p1', 4, 'The docs: https://docs.example.com', 'person'), pin('old', 5, 'An older message', 'agent', 'agent')] });
    await c.handle.refresh();
    assert.equal(c.$('.parley-pins-text').textContent, 'An older message', 'the newest pin, whatever the age of its message');
    assert.equal(c.$('.parley-pins-more').hidden, false);
    assert.equal(c.$('.parley-pins-count').textContent, '3 pinned');
    assert.ok(c.$('.parley-said[data-id="p1"]').querySelector('.parley-pinned-person').querySelector('.parley-pinned-mark'), 'the person\'s message marked too');
    c.$('.parley-pins-more').click();
    assert.equal(c.$('.parley-pins-list').hidden, false);
    assert.equal(c.$('.parley-pins-more').getAttribute('aria-expanded'), 'true');
    const rows = c.$$('.parley-pins-item');
    assert.deepEqual(rows.map((r) => r.dataset.id), ['old', 'p1', 'a1'], 'newest first');
    assert.deepEqual(rows.map((r) => r.dataset.loaded), ['false', 'true', 'true'], 'one not in the thread as shown: said so');
    assert.equal(c.$$('.parley-pins-unpin').length, 3);
    /* Not in the thread: no jump, the list stays. */
    rows[0].querySelector('.parley-pins-go').click();
    assert.equal(c.$('.parley-pins-list').hidden, false);
    /* In the thread: brought into sight and marked a moment; the list closes. */
    rows[2].querySelector('.parley-pins-go').click();
    assert.equal(c.$('.parley-pins-list').hidden, true);
    assert.ok(c.$('.parley-said[data-id="a1"]').classList.contains('parley-flash'));
    /* The bar's newest, not in the thread: the list opens instead; Escape closes it. */
    c.$('.parley-pins-newest').click();
    assert.equal(c.$('.parley-pins-list').hidden, false);
    c.$('.parley-pins').dispatchEvent(fakeEvent('keydown', { key: 'Escape' }));
    assert.equal(c.$('.parley-pins-list').hidden, true);
    c.set({ messages, pins: [] });
    await c.handle.refresh();
    assert.equal(c.$('.parley-pins').hidden, true, 'all unpinned: the bar goes');
});

test('Pin in a message\'s menu only when the application gives pin(to, on)', async (t) => {
    const without = chat(t, { messages, pins: [pin('a1', 3, 'We ship on Tuesdays.'), pin('p1', 4, 'The docs', 'person')] });
    await settle(); await settle();
    without.$('.parley-said[data-id="a2"]').querySelector('.parley-react-open').click();
    assert.equal(without.$('.parley-react-pin').hidden, true, 'no hook, no Pin');
    without.$('.parley-pins-more').click();
    assert.equal(without.$$('.parley-pins-unpin').length, 0, 'no hook, no Unpin in the list');
});

test('with pin(to, on): Pin on either side, Unpin when pinned; Unpin in the list', async (t) => {
    const calls = [];
    let data = { messages, pins: [pin('a1', 3, 'We ship on Tuesdays.')] };
    const c = chat(t, data, { pin: async (to, on) => { calls.push([to, on]); } });
    await settle(); await settle();
    const menuOf = (id) => { c.$(`.parley-said[data-id="${id}"]`).querySelector('.parley-react-open').click(); return c.$('.parley-react-pin'); };
    let b = menuOf('a2');
    assert.equal(b.hidden, false); assert.equal(b.textContent, 'Pin');
    b.click(); await settle();
    assert.deepEqual(calls.at(-1), ['a2', true]);
    b = menuOf('p1');
    assert.equal(b.hidden, false, 'the person\'s own message too');
    b.click(); await settle();
    assert.deepEqual(calls.at(-1), ['p1', true]);
    b = menuOf('a1');
    assert.equal(b.textContent, 'Unpin');
    b.click(); await settle();
    assert.deepEqual(calls.at(-1), ['a1', false]);
    data = { messages, pins: [pin('a1', 3, 'We ship on Tuesdays.'), pin('a2', 4, 'Noted.')] };
    c.set(data); await c.handle.refresh();
    c.$('.parley-pins-more').click();
    c.$$('.parley-pins-unpin')[0].click(); await settle();
    assert.deepEqual(calls.at(-1), ['a2', false], 'the newest first in the list');
});

test('in French: the words of the bar and of the menu', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const data = { messages, pins: [pin('a1', 3, 'We ship on Tuesdays.'), pin('a2', 4, 'Noted.')] };
    const handle = mount(root, { load: async () => data, send: async () => {}, words: texts('fr'), every: 0, touch: false, pin: async () => {} });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    assert.equal(root.querySelector('.parley-pins-count').textContent, '2 épinglés');
    root.querySelector('.parley-said[data-id="a1"]').querySelector('.parley-react-open').click();
    assert.equal(root.querySelector('.parley-react-pin').textContent, 'Désépingler');
});
