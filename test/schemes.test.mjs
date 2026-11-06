/* THE APPLICATION'S OWN KINDS OF LINK (0.17.72): `schemes` of mount, { mail: { icon, open(ref, label) } }.
 * A link of a declared scheme in what the agent wrote is a chip the application opens; any other that is
 * neither http(s) nor a path stays text -- javascript:, data:, an undeclared scheme, whatever is declared.
 * A request's `re` (the mail a reply answers) and a line's `re` (the mail that came back) are the same chip. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePage } from './fake-dom.mjs';
import { mount, requestOf, requestCard, schemesOf, schemeRef, KEYS } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
const en = texts('en');
const REF = 'mail:work/CAF12%40mail.example.com?in=INBOX&uid=42';
const all = (node) => { const out = []; const walk = (n) => { for (const c of n.children ?? []) { out.push(c); walk(c); } }; walk(node); return out; };

async function shown(t, messages, schemes) {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async () => ({ messages }), send: async () => {}, words: en, every: 0, touch: false, markdown: true, schemes, act: () => {} });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    return root;
}

test('schemes: only well-named ones with an opener; those a browser acts on never, whatever is declared', () => {
    const open = () => {};
    const s = schemesOf({ mail: { icon: 'mail', open }, JavaScript: { open }, data: { open }, https: { open }, 'bad name': { open }, task: { icon: 'no-such-icon', open }, idle: { icon: 'mail' } });
    assert.deepEqual([...s.keys()], ['mail', 'task']);
    assert.equal(s.get('task').icon, 'link', 'an icon it does not have: the link sign');
    assert.equal(schemeRef(REF, s).ref, REF);
    assert.equal(schemeRef('MAIL:work/x', s).ref, 'mail:work/x', 'its scheme in lower case');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'tel:123', 'mail:', 'mail:a b', 'mail:a\u0000b', `mail:${'x'.repeat(2001)}`, 'mailto:x@example.com', '/work/a.md'])
        assert.equal(schemeRef(bad, s), null, bad);
});

test('a mail: link in a message of the agent is a chip: its icon, its label cut, its note apart; a tap tells the application', async (t) => {
    const opened = [];
    const root = await shown(t, [{ from: 'agent', id: 'm', at: at(0), kind: 'say', text: `He asked for the deposit: [Re: Leak in the bathroom · Plumber](${REF}). Also [Quote](mail:work/q%40example.org).` }],
        { mail: { icon: 'mail', open: (ref, label) => opened.push([ref, label]) } });
    const chips = root.querySelectorAll('.parley-refchip');
    assert.equal(chips.length, 2);
    assert.equal(chips[0].tagName, 'BUTTON');
    assert.equal(chips[0].dataset.scheme, 'mail');
    assert.equal(chips[0].querySelector('.parley-refchip-text').textContent, 'Re: Leak in the bathroom');
    assert.equal(chips[0].querySelector('.parley-refchip-note').textContent, '· Plumber');
    assert.ok(chips[0].querySelector('svg'), 'its icon');
    assert.equal(chips[1].querySelector('.parley-refchip-note'), null, 'no note: none drawn');
    chips[0].click(); chips[1].click();
    assert.deepEqual(opened, [[REF, 'Re: Leak in the bathroom · Plumber'], ['mail:work/q%40example.org', 'Quote']]);
    assert.equal(all(root).filter((e) => e.tagName === 'A').length, 0, 'never a link of the page');
});

test('undeclared and dangerous schemes stay text: never a link, never a chip -- even when the application declares them', async (t) => {
    const opened = [];
    const text = '[one](javascript:alert(1)) [two](data:text/html;base64,PHNjcmlwdD4=) [three](tel:123) [four](vbscript:x) [five](mail:work/a%40example.com) [six](file:///etc/passwd)';
    const root = await shown(t, [{ from: 'agent', id: 'm', at: at(0), kind: 'say', text }], { javascript: { open: () => opened.push('js') }, data: { open: () => opened.push('data') }, file: { open: () => opened.push('file') } });
    const said = root.querySelector('.parley-said');
    assert.equal(said.querySelectorAll('.parley-refchip').length, 0, 'mail: is not declared here: text');
    assert.deepEqual(all(said).filter((e) => e.tagName === 'A' || e.tagName === 'BUTTON').map((e) => e.className), ['parley-react-open'], 'its reaction button only');
    for (const word of ['one', 'two', 'three', 'four', 'five', 'six']) assert.ok(said.textContent.includes(word), word);
    assert.doesNotMatch(said.textContent, /javascript:|data:|vbscript:/, 'the address is not shown either');
    assert.deepEqual(opened, []);
});

test('a request answering a mail: "in reply to" and its chip under the title, folded and in See all; a tap, the application\'s opener', async (t) => {
    t.after(fakePage());
    const given = { kind: 'mail', title: 'Reply to Plumber', re: { ref: REF, label: 'Re: Leak in the bathroom', note: 'Plumber' }, yes: { id: 'allow:1', label: 'Send' }, no: { id: 'deny:1', label: 'Refuse' } };
    const r = requestOf(given, { words: en });
    assert.deepEqual(r.re, { ref: REF, label: 'Re: Leak in the bathroom', note: 'Plumber', lead: '' });
    assert.deepEqual(requestOf(r), r, 'what it gives, it takes back the same');
    assert.equal(requestOf({ ...given, re: { ref: 'mail:a b', label: 'x' } }).re, null, 'a ref with a space: none');
    assert.equal(requestOf({ ...given, re: 'mail:x/y' }).re, null);
    const opened = [];
    const card = requestCard(given, { words: en, act: () => {}, openRef: (ref, label) => opened.push([ref, label]) });
    document.body.append(card);
    const row = card.querySelector('.parley-request-re');
    assert.ok(row, 'the row under the title');
    assert.equal(row.querySelector('.parley-request-re-lead').textContent, 'in reply to');
    row.querySelector('.parley-refchip').click();
    assert.deepEqual(opened, [[REF, 'Re: Leak in the bathroom · Plumber']]);
    assert.equal(card.dataset.open, 'false', 'the tap does not unfold the card');
    card.querySelector('.parley-request-all').click();
    const sheet = document.body.querySelector('.parley-request-sheet');
    assert.ok(sheet.querySelector('.parley-request-re').querySelector('.parley-refchip'), 'in See all too');
    /* Its words, as the application gives them; nothing opens it: dashed, a tap does nothing. */
    const fr = texts('fr');
    const off = requestCard({ ...given, re: { ...given.re, lead: { k: 'request-re-forward' } } }, { words: fr });
    assert.equal(off.querySelector('.parley-request-re-lead').textContent, 'transfert de');
    assert.equal(off.querySelector('.parley-refchip').dataset.off, 'true');
    assert.equal(off.querySelector('.parley-refchip').tagName, 'SPAN');
});

test('in the thread: a request\'s chip and a line\'s chip (the mail that came back) open through the declared scheme', async (t) => {
    const opened = [];
    const request = { kind: 'mail', title: 'Reply to Plumber', re: { ref: REF, label: 'Re: Leak', note: 'Plumber' }, yes: { id: 'allow:1', label: 'Send' }, no: { id: 'deny:1', label: 'Refuse' } };
    const root = await shown(t, [
        { from: 'system', id: 'l1', at: at(0), text: 'mail.reply', level: 'needs-you', actions: [], request },
        { from: 'system', id: 'l2', at: at(5), text: 'Mail came back (Work): not delivered.', level: 'needs-you', tone: 'warn', actions: [], re: { ref: 'mail:work/sent%40example.com', label: 'Quote', lead: { k: 'line-re-sent' } } },
        { from: 'system', id: 'l3', at: at(6), text: 'Odd line', level: 'needs-you', actions: [], re: { ref: 'javascript:alert(1)', label: 'x' } },
    ], { mail: { icon: 'mail', open: (ref) => opened.push(ref) } });
    const chips = root.querySelectorAll('.parley-refchip');
    assert.equal(chips.length, 3);
    chips[0].click(); chips[1].click(); chips[2].click();
    assert.deepEqual(opened, [REF, 'mail:work/sent%40example.com'], 'a scheme not declared: dashed, nothing opened');
    assert.equal(chips[2].dataset.off, 'true');
    assert.equal(root.querySelector('.parley-line-re').querySelector('.parley-request-re-lead').textContent, 'the mail sent');
});

test('its words are in both dictionaries', () => {
    for (const lang of ['en', 'fr']) for (const key of ['request-re', 'request-re-forward', 'request-re-mail', 'line-re-sent', 'ref-chip']) {
        assert.ok(KEYS.includes(key), key);
        assert.equal(typeof texts(lang)[key], 'string', `${lang} ${key}`);
    }
});
