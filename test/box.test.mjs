import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakePage } from './fake-dom.mjs';
import { mount, KEYS, AUTO_SEND_MS } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

const CSS = readFileSync(fileURLToPath(new URL('../ui/parley-ui.css', import.meta.url)), 'utf8');
/* A class whose own rule takes it out of the flow: shown or not, it takes no room. */
const floating = (name) => new RegExp(`(^|\\n)\\.${name} \\{[^}]*position: absolute`).test(CSS);
const settle = () => new Promise((r) => setImmediate(r));

/* What takes room on the page: every element shown, in order, but what is
   inside a button (its own size is its business) and what floats over the page. */
function room(root) {
    const out = [];
    const walk = (node, path) => {
        for (const [i, c] of node.children.entries()) {
            if (c.hidden) continue;
            const name = c.className.split(' ')[0] || c.tagName.toLowerCase();
            if (name && floating(name)) continue;
            out.push(`${path}/${i}:${name}`);
            if (c.tagName !== 'BUTTON') walk(c, `${path}/${i}`);
        }
    };
    walk(root, '');
    return out;
}

function chat(t, options = {}) {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const sent = [];
    const kept = [];
    let on;
    let closed = 0;
    let refuse = false;
    const voice = { listen: async (handlers) => { if (refuse) throw new Error('denied'); on = handlers; return () => { closed += 1; }; } };
    const handle = mount(root, { load: async () => ({ messages: [] }), send: async (text) => { sent.push(text); }, words: texts('en'), every: 0, touch: false,
        voice, onAutoSend: (v) => kept.push(v), ...options });
    t.after(() => { handle.destroy(); leave(); });
    const $ = (s) => root.querySelector(s);
    return { root, handle, sent, kept, $, on: () => on, closed: () => closed, refuse: (v) => { refuse = v; } };
}

test('dictating grows nothing: what the microphone does is said inside the box, and nothing below it takes room', async (t) => {
    const { root, $, on, closed, refuse } = chat(t);
    const words = texts('en');
    await settle();
    const idle = room(root);
    const form = $('.parley-form');
    const composer = $('.parley-composer');
    assert.equal(root.children.at(-1), composer, 'the box and what goes with it, last, set apart from the thread');
    assert.equal(composer.children.at(-1).className, 'parley-problem', 'under the box, only the line that says a message was not sent');
    assert.deepEqual(composer.children.slice(composer.children.indexOf(form) + 1).filter((c) => !c.hidden), [], 'nothing shown under the box');
    for (const name of ['parley-voice', 'parley-voice-said', 'parley-prefs-menu', 'parley-mic-auto']) assert.ok(floating(name), `${name} floats: it takes no room`);
    assert.equal(root.querySelectorAll('.parley-auto').length, 1);
    assert.ok(!form.contains($('.parley-auto')), 'no "send when I stop" by the box');
    assert.equal($('.parley-box').placeholder, words.placeholder);
    const mic = $('.parley-mic');
    mic.click(); await settle();
    assert.equal(mic.getAttribute('aria-pressed'), 'true');
    assert.equal(mic.title, 'Stop dictation', 'a sign on the button; its words in its title');
    assert.equal(mic.textContent, '', 'no word on the button: the round stop sign says it');
    const voice = $('.parley-voice');
    assert.ok($('.parley-field').contains(voice), 'said on the box\'s frame');
    assert.equal(voice.getAttribute('aria-hidden'), 'true');
    assert.equal($('.parley-voice-said').getAttribute('role'), 'status', 'and told to whoever does not see it');
    assert.equal($('.parley-box').placeholder, words['voice-placeholder'], 'the empty box says to speak');
    assert.deepEqual(room(root), idle, 'listening: nothing took room');
    for (const state of ['calibrating', 'listening', 'hearing', 'transcribing']) {
        on().state(state);
        assert.equal(voice.hidden, false);
        assert.equal(voice.dataset.state, state);
        assert.equal($('.parley-field').dataset.voice, state);
        assert.equal(voice.textContent, words[`voice-${state}`]);
        assert.equal($('.parley-voice-said').textContent, words[`voice-${state}`]);
        assert.equal(mic.dataset.state, state);
        assert.deepEqual(room(root), idle, `${state}: nothing took room`);
    }
    /* Send while a phrase is being written: said in the same place. */
    on().state('hearing');
    $('.parley-send').click();
    assert.equal(voice.textContent, words['voice-wait']);
    assert.deepEqual(room(root), idle);
    on().phrase('hello there'); await settle();
    on().error('The microphone went away.');
    assert.equal(voice.dataset.state, 'error');
    assert.equal(voice.textContent, 'The microphone went away.');
    assert.equal($('.parley-voice-said').textContent, 'The microphone went away.');
    assert.deepEqual(room(root), idle, 'an error: nothing took room');
    mic.click();
    assert.equal(closed(), 1);
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
    assert.equal(voice.hidden, true);
    assert.equal($('.parley-voice-said').textContent, '');
    assert.equal($('.parley-box').placeholder, words.placeholder);
    assert.deepEqual(room(root), idle, 'stopped: as before');
    /* The microphone refused: said in the box, for a while, and nothing moves. */
    refuse(true);
    mic.click(); await settle();
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
    assert.equal(voice.hidden, false);
    assert.equal(voice.dataset.state, 'error');
    assert.equal(voice.textContent, words['voice-off']);
    assert.equal($('.parley-voice-said').textContent, words['voice-off']);
    assert.deepEqual(room(root), idle, 'refused: nothing took room');
});

test('"send when I stop" is a choice of the device, beside the view; the microphone wears a dot while it is on', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, handle, sent, kept, $, on } = chat(t);
    const words = texts('en');
    await settle();
    const prefs = $('.parley-prefs');
    assert.ok($('.parley-top').contains(prefs), 'in the header, beside the view');
    assert.equal(prefs.hidden, false);
    const open = $('.parley-prefs-open');
    const menu = $('.parley-prefs-menu');
    const auto = $('.parley-auto');
    assert.equal(open.getAttribute('aria-label'), words.settings);
    assert.equal(menu.hidden, true); assert.equal(open.getAttribute('aria-expanded'), 'false');
    const mic = $('.parley-mic');
    assert.equal(mic.dataset.auto, 'false'); assert.equal(mic.title, words.mic);
    open.click();
    assert.equal(menu.hidden, false); assert.equal(open.getAttribute('aria-expanded'), 'true');
    assert.equal(auto.querySelector('.parley-auto-word').textContent, words['auto-send']);
    assert.equal(auto.querySelector('.parley-auto-off').textContent, words['auto-send-off'], 'what off means, said under it');
    assert.equal(auto.getAttribute('aria-pressed'), 'false');
    const before = room(root);
    auto.click();
    assert.equal(auto.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(kept, [true], 'told to the application, which keeps it');
    assert.equal(mic.dataset.auto, 'true', 'a dot on the microphone');
    assert.equal(mic.title, `${words.mic} - ${words['auto-on']}`); assert.equal(mic.getAttribute('aria-label'), mic.title);
    assert.deepEqual(room(root), before, 'the menu floats');
    /* Escape, or a press elsewhere, closes the menu. */
    prefs.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true, preventDefault() {} });
    assert.equal(menu.hidden, true);
    open.click(); $('.parley-thread').dispatchEvent({ type: 'pointerdown', bubbles: true, preventDefault() {} });
    assert.equal(menu.hidden, true);
    /* On: what is said is sent once the person stopped, unless they speak again. */
    mic.click(); await settle();
    assert.equal(mic.title, `${words['mic-stop']} - ${words['auto-on']}`);
    on().phrase('first part');
    t.mock.timers.tick(AUTO_SEND_MS - 100);
    on().speech();
    t.mock.timers.tick(500);
    assert.deepEqual(sent, [], 'speaking again holds it');
    on().phrase('and the rest');
    t.mock.timers.tick(AUTO_SEND_MS);
    await settle();
    assert.deepEqual(sent, ['first part and the rest']);
    /* Off, from the menu, while it listens: nothing goes by itself. */
    open.click(); auto.click();
    assert.deepEqual(kept, [true, false]);
    assert.equal(mic.dataset.auto, 'false');
    on().phrase('kept in the box');
    t.mock.timers.tick(AUTO_SEND_MS * 3);
    await settle();
    assert.deepEqual(sent, ['first part and the rest']);
    assert.equal($('.parley-box').value, 'kept in the box');
    /* Without a voice, no such choice: the menu keeps the view and the search. */
    handle.voice = null;
    assert.equal($('.parley-dictation').hidden, true); assert.equal(mic.hidden, true);
    assert.equal(prefs.hidden, false);
});

test('"send when I stop" starts as the application kept it', (t) => {
    const { $ } = chat(t, { autoSend: true });
    assert.equal($('.parley-auto').getAttribute('aria-pressed'), 'true');
    assert.equal($('.parley-mic').dataset.auto, 'true');
    for (const key of ['auto-send', 'auto-on', 'settings', 'voice-placeholder']) assert.ok(KEYS.includes(key));
});

test('without a voice, neither a microphone nor its choice', (t) => {
    const other = chat(t, { voice: undefined });
    assert.equal(other.$('.parley-dictation').hidden, true);
    assert.equal(other.$('.parley-prefs').hidden, false, 'the one button of settings stays: the view, the search');
    assert.ok(other.$('.parley-prefs-menu').contains(other.$('.parley-views')), 'the view is chosen in it');
    assert.equal(other.$('.parley-mic').hidden, true);
});

/* A tap in a word on a phone: its keyboard takes the word up again (composition, then input). */
const correcting = (box) => {
    const events = [];
    const fire = (type, more = {}) => { const e = { type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...more }; box.dispatchEvent(e); events.push(type); };
    globalThis.document.dispatchEvent({ type: 'selectionchange', bubbles: false, preventDefault() {}, stopPropagation() {} });
    fire('compositionstart'); fire('compositionupdate', { data: 'quick' });
    box.value = 'The quikc brown fox'; fire('input', { isComposing: true });
    box.value = 'The quick brown fox'; fire('input', { isComposing: true });
    fire('compositionend', { data: 'quick' }); fire('input');
    return events;
};
const watchHeights = (box) => {
    const set = [];
    const style = box.style;
    box.style = new Proxy(style, { set(o, k, v) { if (k === 'height') set.push(v); o[k] = v; return true; } });
    return set;
};

test('typing and a word taken up again by the keyboard never collapse the box to measure it: a hidden copy is measured, the box set only when its height changes', async (t) => {
    const { root, $ } = chat(t);
    await settle();
    const idle = room(root);
    const box = $('.parley-box');
    const heights = watchHeights(box);
    box.value = 'The quikc brown fox'; box.dispatchEvent({ type: 'input', bubbles: true, preventDefault() {}, stopPropagation() {} });
    correcting(box);
    assert.ok(!heights.includes(''), `never emptied: ${JSON.stringify(heights)}`);
    assert.equal(heights.length, 1, 'set once: the height did not change');
    assert.equal($('.parley-box-mirror').value, 'The quick brown fox', 'measured on its copy');
    assert.equal($('.parley-box-mirror').getAttribute('aria-hidden'), 'true');
    assert.equal(root.querySelectorAll('.parley-box').length, 1, 'one box to write in');
    assert.deepEqual(room(root), idle, 'the copy takes no room');
    assert.match(CSS, /\.parley-box-mirror \{[^}]*visibility: hidden[^}]*height: 0/);
});

test('where the browser sizes a field by its content, the box is sized by the style sheet alone', async (t) => {
    globalThis.CSS = { supports: (property, value) => property === 'field-sizing' && value === 'content' };
    t.after(() => { delete globalThis.CSS; });
    const { $ } = chat(t);
    await settle();
    const box = $('.parley-box');
    const heights = watchHeights(box);
    box.value = 'One\nTwo\nThree'; box.dispatchEvent({ type: 'input', bubbles: true, preventDefault() {}, stopPropagation() {} });
    correcting(box);
    assert.deepEqual(heights, [], 'no height written');
    assert.equal($('.parley-box-mirror'), null, 'no copy needed');
    assert.match(CSS, /\.parley-box \{[^}]*field-sizing: content/);
});
