import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakePage, fakeEvent } from './fake-dom.mjs';
import { mount, panelOf, KEYS, PANEL_MAX, PANEL_PX } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

const CSS = readFileSync(fileURLToPath(new URL('../ui/parley-ui.css', import.meta.url)), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));

const ITEMS = [
    { id: '1', title: 'Fix diff line numbers', state: 'Doing', checked: true, tone: 'active' },
    { id: '2', title: 'Keyboard folds when tapping the box', state: 'Proposed' },
    { id: '3', title: 'Settings redesign', state: 'Done', done: true, checked: true },
    { id: '4', title: 'Binder 0.1.1 stable', state: 'For you', checked: true, tone: 'attention', owner: 'Ops' },
    { id: '5', title: 'Disk check before a resize', state: 'Done', done: true },
];

function chat(t, side, { width = 0 } = {}) {
    const leave = fakePage();
    const root = document.createElement('div');
    root.clientWidth = width;
    document.body.append(root);
    const handle = mount(root, { load: async () => ({ messages: [] }), send: async () => {}, words: texts('en'), every: 0, touch: false, back: false, side });
    t.after(() => { handle.destroy(); leave(); });
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => root.querySelectorAll(s);
    const item = (id) => $$('.parley-panel-item').find((x) => x.dataset.id === id);
    return { root, handle, $, $$, item };
}

test('panelOf: only what is well formed, those not done first, done after; an owner, a state, a tone as given; at most PANEL_MAX', () => {
    assert.equal(panelOf(null), null);
    assert.equal(panelOf('x'), null);
    const p = panelOf({ title: '  Batches  ', items: [...ITEMS, { id: '', title: 'no id' }, { id: '6', title: '   ' }, { id: '1', title: 'twice' }, { id: 7, title: 'a number id', tone: 'loud' }, null] });
    assert.equal(p.title, 'Batches');
    assert.deepEqual(p.open.map((x) => x.id), ['1', '2', '4', '7']);
    assert.deepEqual(p.done.map((x) => x.id), ['3', '5']);
    assert.equal(p.count, 4, 'by default, the number of those not done');
    assert.equal(p.open[3].tone, '', 'a tone it does not know is none');
    assert.equal(p.open[2].owner, 'Ops');
    assert.equal(p.done[0].tickable, false, 'what is done is not ticked any more');
    assert.equal(panelOf({ items: [{ id: 'a', title: 'x', tick: false }] }).open[0].tickable, false);
    assert.equal(panelOf({ items: [], count: 0 }).count, 0);
    assert.equal(panelOf({ items: [], count: -1 }).count, 0);
    assert.equal(panelOf({ items: Array.from({ length: PANEL_MAX + 20 }, (_, i) => ({ id: String(i), title: `Batch ${i}` })) }).open.length, PANEL_MAX);
    assert.equal(panelOf({ items: [], action: { label: 'Start the list' } }).action, null, 'an action without what it runs is none');
    assert.equal(panelOf({ items: [], action: { label: 'Start the list', run: () => {} } }).action.label, 'Start the list');
});

test('no side given: no button, no panel, the chat as before', async (t) => {
    const { root, $ } = chat(t, undefined);
    await settle();
    assert.equal($('.parley-panel-open').hidden, true);
    assert.equal($('.parley-panel').hidden, true);
    assert.equal(root.dataset.panel, undefined);
    assert.equal(root.children.at(-1).className, 'parley-composer', 'the box, last');
});

test('wide: beside the thread; a tick goes to the application at once, a refusal is said and the box comes back; a click opens; what is done is folded', async (t) => {
    const ticks = []; const opened = []; let refuse = null;
    const { root, handle, $, $$, item } = chat(t, { title: 'Batches', items: ITEMS, count: 1,
        tick: async (id, on) => { ticks.push([id, on]); if (refuse) throw new Error(refuse); }, open: (id) => opened.push(id) });
    await settle();
    assert.equal(root.dataset.panel, 'beside');
    assert.equal($('.parley-panel').hidden, false);
    assert.equal($('.parley-panel-name').textContent, 'Batches');
    assert.equal($('.parley-panel-open').hidden, false);
    assert.equal($('.parley-panel-count').textContent, '1');
    assert.equal($('.parley-panel-open').getAttribute('aria-expanded'), 'true');
    /* Those not done, in order; those done behind one button. */
    assert.deepEqual($$('.parley-panel-item').map((x) => x.dataset.id), ['1', '2', '4']);
    assert.equal($('.parley-panel-done').textContent, 'Done (2)');
    $('.parley-panel-done').click();
    assert.deepEqual($$('.parley-panel-item').map((x) => x.dataset.id), ['1', '2', '4', '3', '5']);
    assert.equal(item('3').querySelector('.parley-panel-tick'), null, 'no box on what is done');
    /* What is set is said, what is empty is not. */
    assert.equal(item('4').querySelector('.parley-panel-meta').textContent, 'For you · Ops');
    assert.equal(item('4').dataset.tone, 'attention');
    assert.equal(item('2').querySelector('.parley-panel-meta').textContent, 'Proposed');
    assert.equal(panelOf({ items: [{ id: 'z', title: 'bare' }] }).open[0].state, '');
    /* Ticked: at once on the screen, then given to the application. */
    item('2').querySelector('.parley-panel-tick').click();
    assert.equal(item('2').querySelector('.parley-panel-tick').getAttribute('aria-checked'), 'true');
    await settle();
    assert.deepEqual(ticks, [['2', true]]);
    /* The application gives the list again, with it ticked: its word wins. */
    handle.side = { ...handle.side, items: ITEMS.map((x) => (x.id === '2' ? { ...x, checked: true, state: 'Approved' } : x)) };
    assert.equal(item('2').querySelector('.parley-panel-tick').getAttribute('aria-checked'), 'true');
    assert.equal(item('2').querySelector('.parley-panel-meta').textContent, 'Approved');
    /* Refused: said in one line, the box as it was. */
    refuse = 'only a person approves';
    item('1').querySelector('.parley-panel-tick').click();
    await settle(); await settle();
    assert.deepEqual(ticks.at(-1), ['1', false]);
    assert.equal(item('1').querySelector('.parley-panel-tick').getAttribute('aria-checked'), 'true');
    assert.equal($('.parley-panel-problem').textContent, 'Not saved: only a person approves');
    /* A click on a title opens it. */
    item('4').querySelector('.parley-panel-title').click();
    assert.deepEqual(opened, ['4']);
});

test('folded from the bar or the panel, told to the application; given folded at first; null takes the panel away', async (t) => {
    const folds = [];
    const { root, handle, $ } = chat(t, { title: 'Batches', items: ITEMS, folded: true, onFold: (f) => folds.push(f) });
    await settle();
    assert.equal(root.dataset.panel, 'folded');
    assert.equal($('.parley-panel').hidden, true);
    assert.equal($('.parley-panel-open').getAttribute('aria-expanded'), 'false');
    assert.equal($('.parley-panel-open').title, 'Show Batches');
    assert.equal($('.parley-panel-count').textContent, '3', 'those not done');
    $('.parley-panel-open').click();
    assert.equal(root.dataset.panel, 'beside');
    assert.equal($('.parley-panel').hidden, false);
    $('.parley-panel-fold').click();
    assert.equal($('.parley-panel').hidden, true);
    assert.deepEqual(folds, [false, true]);
    /* Given again: the person's choice stays. */
    handle.side = { title: 'Batches', items: ITEMS.slice(0, 2), folded: false, onFold: (f) => folds.push(f) };
    assert.equal($('.parley-panel').hidden, true);
    /* The application sets it, and is not told back. */
    handle.folded = false;
    assert.equal($('.parley-panel').hidden, false);
    assert.equal(handle.folded, false);
    assert.deepEqual(folds, [false, true]);
    handle.side = null;
    assert.equal($('.parley-panel').hidden, true);
    assert.equal($('.parley-panel-open').hidden, true);
    assert.equal(root.dataset.panel, undefined);
});

test('narrow: never beside the thread; a sheet from the bar, closed by Escape, by a tap elsewhere, or once an item is opened', async (t) => {
    const opened = [];
    const { root, handle, $, item } = chat(t, { title: 'Batches', items: ITEMS, folded: false, open: (id) => opened.push(id) }, { width: PANEL_PX - 300 });
    await settle();
    assert.equal(root.dataset.panel, 'folded', 'the thread keeps the whole width');
    assert.equal($('.parley-panel').hidden, true);
    $('.parley-panel-open').click();
    assert.equal($('.parley-panel').hidden, false);
    assert.equal($('.parley-panel').dataset.sheet, 'true');
    assert.deepEqual(handle.layers, ['panel']);
    $('.parley-panel').dispatchEvent(fakeEvent('keydown', { key: 'Escape' }));
    assert.equal($('.parley-panel').hidden, true);
    assert.deepEqual(handle.layers, []);
    $('.parley-panel-open').click();
    document.dispatchEvent(fakeEvent('pointerdown', { target: $('.parley-thread') }));
    assert.equal($('.parley-panel').hidden, true, 'a tap elsewhere closes it');
    $('.parley-panel-open').click();
    item('1').querySelector('.parley-panel-title').click();
    assert.deepEqual(opened, ['1']);
    assert.equal($('.parley-panel').hidden, true, 'what was opened is in sight');
    /* Folded by the application: a sheet is closed, never opened. */
    $('.parley-panel-open').click();
    handle.folded = true;
    assert.equal($('.parley-panel').hidden, true);
    handle.folded = false;
    assert.equal($('.parley-panel').hidden, true);
});

test('an empty list says so in one line; its action is one button; what an item says is text, never markup', async (t) => {
    let ran = 0;
    const { $, handle } = chat(t, { title: 'Batches', items: [], action: { label: 'Start the list', run: () => { ran += 1; } } });
    await settle();
    assert.equal($('.parley-panel-empty').textContent, 'Nothing yet');
    assert.equal($('.parley-panel-count').hidden, true, 'no number when there is none');
    $('.parley-panel-action').click();
    assert.equal(ran, 1);
    handle.side = { title: 'Batches', items: [{ id: 'x', title: '<img src=x onerror=alert(1)>' }] };
    assert.equal($('.parley-panel-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal($('.parley-panel-title').children.length, 0);
    assert.equal($('.parley-panel-empty'), null);
    assert.equal($('.parley-panel-action'), null);
});

test('the style sheet: beside, a column of its own from the bar to the box; narrow, a sheet over the thread; every word in both dictionaries', () => {
    assert.match(CSS, /\.parley\[data-panel="beside"\] \{ display: grid; grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(CSS, /\.parley\[data-panel="beside"\] > \.parley-panel \{ grid-area: 1 \/ 2 \/ 5 \/ 3; \}/);
    assert.match(CSS, /\.parley-panel\[data-sheet="true"\] \{ position: absolute;/);
    const fr = texts('fr');
    for (const key of ['panel', 'panel-show', 'panel-hide', 'panel-empty', 'panel-done', 'panel-not-saved']) {
        assert.ok(KEYS.includes(key), key);
        assert.notEqual(fr[key], texts('en')[key], `${key} is said in French`);
    }
});
