import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePage, fakeEvent } from './fake-dom.mjs';
import { mount, view, media, titleOf, REACTIONS as SHOWN } from '../ui/parley-ui.js';
import { ICONS, fileIcon, LUCIDE } from '../ui/parley-icons.js';
import { install, Parley, texts, REACTIONS } from '../host/parley-host.mjs';
import { run, showing } from '../bin/parley.mjs';
import { bridge, REACTION_MEANINGS } from '../server/parley-mcp.mjs';

const settle = () => new Promise((r) => setImmediate(r));
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const at = (minute) => new Date(Date.parse('2026-01-05T06:00:00.000Z') + minute * 60_000).toISOString();

test('several files shown at once: one gallery, each with its title; the command and the MCP tool', (t) => {
    const home = folder(t);
    const dir = join(home, '.parley'); install(dir);
    for (const f of ['home-before.png', 'home-after.png', 'notes.md']) writeFileSync(join(home, f), 'x');
    const words = showing(['home-before.png=Home page, before', 'home-after.png', 'notes.md=The notes', 'Same', 'header'], home);
    assert.deepEqual(words, { files: [{ path: 'home-before.png', title: 'Home page, before' }, { path: 'home-after.png', title: '' }, { path: 'notes.md', title: 'The notes' }], note: 'Same header' });
    const r = run(['show', 'home-before.png=Home page, before', 'home-after.png=Home page, after', 'The new header'], { cwd: home, env: {} });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /one gallery of 2/);
    assert.equal(run(['show', 'missing.png', 'note'], { cwd: home, env: {} }).code, 1, 'a file that is not there is refused');
    assert.match(bridge(dir).show([{ path: join(home, 'notes.md'), title: 'The notes' }], 'alone', { from: home }), /Posted/);
    const posted = readFileSync(join(dir, 'from-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(posted[0].files.map((f) => f.title), ['Home page, before', 'Home page, after']);
    assert.equal(posted[0].path, join(home, 'home-before.png'), 'the first file is its path, for whoever reads one only');
    assert.equal(posted[0].text, 'The new header');
    const parley = new Parley(dir, { reach: (p) => (p.startsWith(home) ? `work:${p.slice(home.length + 1)}` : null) });
    const read = parley.read();
    assert.deepEqual(read.messages[0].files.map((f) => [f.title, f.open]), [['Home page, before', 'work:home-before.png'], ['Home page, after', 'work:home-after.png']]);
    assert.deepEqual(read.files.map((f) => f.note), ['Home page, before', 'Home page, after', 'The notes'], 'each in the files, by its title');
    const v = view(read, { words: texts('en') });
    assert.deepEqual(v.items[0].gallery.map((g) => [g.title, g.name, g.picture]), [['Home page, before', 'home-before.png', true], ['Home page, after', 'home-after.png', true]]);
    assert.equal(v.items[0].file, null);
    assert.equal(titleOf('/work/home_page-before.v2.png'), 'Home page before v2', 'no title: the name cleaned');
    assert.match(bridge(dir).read({ all: true }), /You showed them 2 files: .*"Home page, before"/);
});

test('reactions: put on a message of the agent, taken back, told to the agent with the words and time of that message; only some wake it', (t) => {
    const dir = join(folder(t), '.parley'); install(dir);
    const agent = bridge(dir);
    agent.tell('I can delete the old logs, or compress them.');
    const id = JSON.parse(readFileSync(join(dir, 'from-agent.jsonl'), 'utf8').trim()).id;
    const told = [];
    const parley = new Parley(dir, { on: (e) => told.push(e) });
    assert.deepEqual(REACTIONS.map((r) => r.id), SHOWN.map((r) => r.id), 'the screen offers the set the host knows');
    assert.deepEqual(REACTIONS.map((r) => r.id), Object.keys(REACTION_MEANINGS));
    parley.react(id, 'agree');
    assert.equal(told.at(-1).type, 'person-reacted'); assert.equal(told.at(-1).wakes, false, 'a thumbs up wakes nobody');
    assert.equal(parley.read().messages.find((m) => m.id === id).reaction.id, 'agree');
    assert.equal(parley.read().messages.filter((m) => m.from === 'person').length, 0, 'a reaction is no message');
    parley.react(id, 'stop');
    assert.equal(told.at(-1).wakes, 'now', 'stop: at once');
    let said = agent.read();
    assert.match(said, /Reaction to your message of \d{4}-\d\d-\d\d \d\d:\d\d "I can delete the old logs, or compress them\.": Agree \(thumbs up\): noted\. It is NOT an authorization/);
    assert.match(said, /STOP: stop what you are doing now/);
    parley.react(id, null);
    assert.equal(parley.read().messages.find((m) => m.id === id).reaction, undefined, 'taken back');
    assert.match(agent.read(), /They took back their reaction "stop"/);
    assert.throws(() => parley.react(id, 'party'), /A reaction is one of/);
    assert.throws(() => parley.react('nope', 'go'), /No such message/);
    /* A reply to a message that is no question: quoted, not an answer. */
    parley.say('Compress them.', id, [], { via: 'voice' });
    said = agent.read();
    assert.match(said, /Reply to your message "I can delete the old logs, or compress them\." \(dictated: may hold recognition mistakes/);
    const mine = parley.read().messages.find((m) => m.from === 'person');
    assert.deepEqual([mine.re, mine.via, mine.answers], [id, 'voice', undefined]);
    assert.match(view(parley.read(), { words: texts('en') }).items.at(-1).reply, /^In reply to: I can delete/);
    assert.equal(view(parley.read(), { words: texts('en') }).items.at(-1).dictated, true);
});

test('the media of a thread: pictures and files the person can open, once each, newest first', () => {
    const data = { messages: [
        { from: 'agent', id: 'a', at: at(0), kind: 'say', text: 'See ![The chart](/work/chart.png) and /work/notes.md', refs: [{ path: '/work/chart.png', open: 'work:chart.png' }, { path: '/work/notes.md', open: 'work:notes.md' }] },
        { from: 'person', id: 'p', at: at(1), kind: 'say', text: '', files: [{ path: '/work/.parley/files/x/photo.jpg', name: 'photo.jpg', open: 'work:.parley/files/x/photo.jpg' }] },
        { from: 'agent', id: 's', at: at(2), kind: 'show', path: '/work/a.png', text: '', files: [{ path: '/work/a.png', title: 'Before', open: 'work:a.png' }, { path: '/tmp/b.png', title: 'Secret', open: null }] },
        { from: 'agent', id: 's2', at: at(3), kind: 'show', path: '/work/chart.png', text: 'again', open: 'work:chart.png' },
    ] };
    const m = media(data);
    assert.deepEqual(m.pictures.map((x) => [x.title, x.id]), [['Chart', 's2'], ['Before', 's'], ['Photo', 'p']], 'once each, where it came last; one that cannot be opened is not there');
    assert.deepEqual(m.files.map((x) => [x.name, x.id]), [['notes.md', 'a']]);
    assert.equal(media(undefined).pictures.length, 0);
});

test('the icons: Lucide, as data, with its version; a file\'s kind; the reactions\' icons are there', () => {
    assert.match(LUCIDE, /^lucide-static \d+\.\d+\.\d+$/);
    for (const r of SHOWN) assert.ok(ICONS[r.icon], r.icon);
    assert.equal(fileIcon('a.PDF'), 'file-text'); assert.equal(fileIcon('x.tgz'), 'file-archive'); assert.equal(fileIcon('README'), 'file'); assert.equal(fileIcon('d', true), 'folder');
    for (const shapes of Object.values(ICONS)) for (const [tag, a] of shapes) { assert.match(tag, /^(path|circle|rect|line|polyline|polygon|ellipse)$/); assert.ok(Object.keys(a).every((k) => /^[a-z-]+$/.test(k) && !k.startsWith('on'))); }
});

function chat(t, data, options = {}) {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const sent = []; const reacted = [];
    let current = data;
    const handle = mount(root, { load: async () => current, send: async (...args) => { sent.push(args); }, words: texts('en'), every: 0, touch: false, markdown: true,
        picture: (f) => `/thumb/${f.open}`, react: async (id, r) => { reacted.push([id, r]); }, ...options });
    t.after(() => { handle.destroy(); leave(); });
    return { root, handle, sent, reacted, set: (d) => { current = d; }, $: (s) => root.querySelector(s), $$: (s) => root.querySelectorAll(s) };
}

test('on the screen: a gallery with titles, a reaction chosen and taken back, what arrives marked, a dictated message said so', async (t) => {
    const first = { messages: [
        { from: 'agent', id: 'a', at: at(0), kind: 'say', text: 'Hello' },
        { from: 'agent', id: 's', at: at(1), kind: 'show', path: '/work/a.png', text: 'Two pages', files: [{ path: '/work/a.png', title: 'Page one', open: 'work:a.png' }, { path: '/work/b.png', title: '', open: 'work:b.png' }] },
    ] };
    const c = chat(t, first);
    await settle(); await settle();
    const gallery = c.$('.parley-gallery');
    assert.equal(gallery.dataset.count, '2');
    assert.deepEqual(gallery.querySelectorAll('.parley-caption').map((x) => x.textContent), ['Page one', 'B'], 'its title under each; no title, its name cleaned');
    assert.equal(c.$$('.parley-row[data-arrived]').length, 0, 'the first look marks nothing');
    /* Its reactions: the button on the message, eight choices each with its word, its meaning on hover. */
    c.$('.parley-said[data-id="a"]').querySelector('.parley-react-open').click();
    const picker = c.$('.parley-react');
    assert.equal(picker.hidden, false);
    const choices = c.$$('.parley-react-choice');
    assert.deepEqual(choices.map((b) => b.textContent), ['Agree', 'Go ahead', 'Disagree', 'Not clear', 'Stop', 'Another way', 'Later', 'Love it']);
    assert.match(choices[4].title, /Stop now/);
    choices[4].click();
    await settle();
    assert.deepEqual(c.reacted, [['a', 'stop']]);
    assert.equal(picker.hidden, true);
    /* Shown under the message once the host says so; pressed again it is taken back. */
    c.set({ messages: [{ ...first.messages[0], reaction: { id: 'stop', at: at(2) } }, first.messages[1]] });
    await c.handle.refresh();
    assert.equal(c.$('.parley-said[data-id="a"]').querySelector('.parley-reaction').dataset.reaction, 'stop');
    c.$('.parley-said[data-id="a"]').querySelector('.parley-reaction').click();
    assert.equal(c.$('.parley-react-choice[data-reaction="stop"]').getAttribute('aria-pressed'), 'true');
    c.$('.parley-react-choice[data-reaction="stop"]').click();
    await settle();
    assert.deepEqual(c.reacted.at(-1), ['a', null]);
    /* Reply, from the same choice: what is typed next replies to it. */
    c.$('.parley-said[data-id="a"]').querySelector('.parley-react-open').click();
    c.$('.parley-react-reply').click();
    assert.equal(c.$('.parley-replying').hidden, false);
    /* A message that arrives while the chat is open: marked a moment. */
    c.set({ messages: [...first.messages, { from: 'agent', id: 'n', at: at(5), kind: 'say', text: 'New' }] });
    await c.handle.refresh();
    assert.equal(c.$('.parley-row[data-key="m:n"]').dataset.arrived, 'message');
    assert.equal(c.$('.parley-row[data-key="m:a"]').dataset.arrived, undefined, 'not what was there');
    /* The media of the thread, from the menu. */
    c.$('.parley-media-open').click();
    assert.equal(c.$('.parley-media').hidden, false);
    assert.deepEqual(c.$('.parley-media').querySelectorAll('figcaption').map((x) => x.textContent), ['Page one', 'B']);
});

test('dictated: what the microphone wrote goes with "via: voice", once', async (t) => {
    let on;
    const c = chat(t, { messages: [] }, { voice: { listen: async (h) => { on = h; return () => {}; } } });
    await settle();
    c.$('.parley-mic').click();
    await settle();
    on.state('listening');
    on.phrase('first part');
    c.$('.parley-box').value += ' typed';
    on.phrase('second');
    c.$('.parley-form').requestSubmit();
    await settle();
    assert.deepEqual(c.sent.at(-1), ['first part typed second', undefined, undefined, { via: 'voice' }]);
    c.$('.parley-box').value = 'typed only';
    c.$('.parley-form').requestSubmit();
    await settle();
    assert.deepEqual(c.sent.at(-1), ['typed only', undefined], 'a message typed: nothing more');
    void fakeEvent;
});
