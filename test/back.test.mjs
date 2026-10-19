/* Back closes what Parley opened over the thread, the one on top first; a
   layer closed by its own button takes its step back; a page may keep the
   steps itself. A small history stands in for the browser's. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepper } from '../ui/parley-ui.js';

function fakeHistory() {
    const entries = [{ state: null }]; let at = 0; const listeners = new Set();
    const fire = () => { for (const f of listeners) f({ state: entries[at].state }); };
    globalThis.location = { href: 'https://example.com/' };
    globalThis.history = {
        get state() { return entries[at].state; },
        get length() { return entries.length; },
        pushState(state) { entries.splice(at + 1); entries.push({ state: structuredClone(state) }); at += 1; },
        replaceState(state) { entries[at] = { state: structuredClone(state) }; },
        go(n) { const to = Math.max(0, Math.min(entries.length - 1, at + n)); if (to === at) return; at = to; setTimeout(fire, 0); },
        back() { this.go(-1); },
    };
    globalThis.addEventListener = (type, f) => { if (type === 'popstate') listeners.add(f); };
    globalThis.removeEventListener = (type, f) => { if (type === 'popstate') listeners.delete(f); };
    return { get at() { return at; } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('each layer takes a step; Back closes the one on top, then the next', async () => {
    const h = fakeHistory();
    history.replaceState({ page: 3 }, '');
    const s = stepper();
    const shut = [];
    s.opened('media', () => shut.push('media'));
    s.opened('zoom', () => shut.push('zoom'));
    assert.equal(h.at, 2);
    assert.equal(history.state.page, 3, 'the page\'s own state is kept in each step');
    history.back(); await tick();
    assert.deepEqual(shut, ['zoom']);
    assert.deepEqual(s.open, ['media']);
    history.back(); await tick();
    assert.deepEqual(shut, ['zoom', 'media']);
    assert.deepEqual(s.open, []);
    s.destroy();
});

test('closed by its button: the step is taken back, and nothing else closes', async () => {
    const h = fakeHistory();
    const s = stepper();
    const shut = [];
    s.opened('search', () => shut.push('search'));
    s.closed('search');
    await tick(); await tick();
    assert.equal(h.at, 0);
    assert.deepEqual(shut, []);
    s.destroy();
});

test('one closed and another opened at once share a step', async () => {
    const h = fakeHistory();
    const s = stepper();
    s.opened('prefs', () => {});
    s.closed('prefs');
    s.opened('search', () => {});
    await tick();
    assert.equal(h.at, 1);
    assert.deepEqual(s.open, ['search']);
    s.destroy();
});

test('false: the history is not touched; an object: the page keeps the steps', async () => {
    const h = fakeHistory();
    const none = stepper(false);
    none.opened('zoom', () => {});
    assert.equal(h.at, 0);
    const given = [];
    let closer;
    const own = stepper({ open(name, close) { given.push(['open', name]); closer = close; return 7; }, closed(token) { given.push(['closed', token]); } });
    const shut = [];
    own.opened('zoom', () => shut.push('zoom'));
    own.closed('zoom');
    own.opened('media', () => shut.push('media'));
    closer();
    assert.equal(h.at, 0);
    assert.deepEqual(given, [['open', 'zoom'], ['closed', 7], ['open', 'media']]);
    assert.deepEqual(shut, ['media']);
    assert.deepEqual(own.open, []);
});

test('words of a line of the application are buttons: kept as text, cut to the set', async () => {
    const { view } = await import('../ui/parley-ui.js');
    const out = view({ messages: [{ from: 'system', id: 'y1', at: '2026-01-01T00:00:00Z', text: 'Sent to main: 2 commits (abc1234).', level: 'needs-you', links: [{ text: 'abc1234', id: 'commit:r.abc1234' }, { text: '', id: 'x' }, { text: 'no', id: 5 }] }] });
    const line = out.rows.find((r) => r.from === 'system');
    assert.deepEqual(line.links, [{ text: 'abc1234', id: 'commit:r.abc1234' }]);
});
