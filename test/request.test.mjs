/* A REQUEST, AS A CARD (0.17.68): an act of the application's that waits for the person, said as
 * what will happen. Folded, unfolded in place, everything in a sheet; irreversible (amber edge,
 * the newest unfolded, a hold with Undo); several at once one block; decided, one line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePage } from './fake-dom.mjs';
import { mount, view, requestOf, requestCard, requestBlock, lineText, KEYS, REQUEST_BATCH_MS } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

const settle = () => new Promise((r) => setTimeout(r, 5));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (m, s = 0) => new Date(Date.UTC(2030, 0, 1, 9, m, s)).toISOString();
const en = texts('en');
const mail = (id, more = {}) => ({
    kind: 'mail', title: `Send “Quote ${id}” to sales@example.com`, sub: 'Work mailbox · 8 lines · 1 attachment',
    facts: [['To', [{ text: 'sales@example.com', ext: true }]], ['Cc', ['books@example.org']], ['Joined', 'plan.pdf (240 KB)']],
    quote: 'Hello,\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nthe last line', why: 'you asked for it',
    yes: { id: `allow:${id}`, label: 'Send' }, no: { id: `deny:${id}`, label: 'Refuse' }, ...more,
});
const line = (id, m, request) => ({ from: 'system', id, at: at(m), text: `mail.send ${id}`, level: 'needs-you', tone: 'warn', topic: 'Demande', actions: [], request });

test('requestOf keeps what is known, bounded; a request without a title is none', () => {
    assert.equal(requestOf(null), null);
    assert.equal(requestOf({ kind: 'mail' }), null);
    const r = requestOf({ ...mail('a'), kind: 'nonsense', facts: [['To', [{ text: 'x@example.com', ext: true }, 7]], ['', ''], 'odd'], hold: 99, yes: { id: 'allow:a', label: '' }, state: { decision: 'maybe' } });
    assert.equal(r.kind, 'other');
    assert.deepEqual(r.facts, [{ label: 'To', chips: [{ text: 'x@example.com', ext: true }] }]);
    assert.equal(r.hold, 10, 'the hold is at most ten seconds');
    assert.equal(r.yes, null, 'a button without words is none');
    assert.equal(r.state.decision, 'ended');
    assert.deepEqual(requestOf(r), r, 'what it gives, it takes back the same');
});

test('view: a request rides its line; those within a minute are one block; the newest irreversible comes unfolded', () => {
    const messages = [
        line('l1', 0, mail('a')),
        line('l2', 5, mail('b', { irreversible: true })),
        line('l3', 30, mail('c', { irreversible: true })),
        { ...line('l4', 30, mail('d')), at: new Date(Date.parse(at(30)) + REQUEST_BATCH_MS - 1000).toISOString() },
        { from: 'system', id: 'l5', at: at(40), text: 'A plain line', level: 'needs-you', actions: [] },
    ];
    const v = view({ messages }, { words: en });
    const rows = v.rows.filter((r) => r.type !== 'day' && r.type !== 'gap');
    assert.equal(rows[0].request.title, 'Send “Quote a” to sales@example.com');
    assert.equal(rows[0].open, false, 'a reversible one stays folded');
    assert.equal(rows[1].open, false, 'an older irreversible one, alone, folded: only the newest unfolds');
    assert.equal(rows[2].type, 'requests', 'two within a minute: one block');
    assert.deepEqual(rows[2].lines.map((l) => l.id), ['l3', 'l4']);
    assert.equal(rows[3].request, null, 'a line without a request is a line');
    const alone = view({ messages: [line('l1', 0, mail('a', { irreversible: true })), line('l2', 9, mail('b'))] }, { words: en }).rows.filter((r) => r.request);
    assert.equal(alone[0].open, true, 'the newest irreversible one still waiting is unfolded');
    const decided = view({ messages: [line('l1', 0, mail('a', { irreversible: true, state: { decision: 'yes' } }))] }, { words: en }).rows.find((r) => r.request);
    assert.equal(decided.open, false, 'decided: nothing to unfold');
    const mixed = view({ messages: [line('l1', 0, mail('a', { state: { decision: 'no' } })), line('l2', 0, mail('b'))] }, { words: en }).rows.filter((r) => r.type !== 'day');
    assert.deepEqual(mixed.map((r) => r.type), ['message', 'message'], 'a decided one is not in a block: its own line');
});

test('the card in the thread: folded, unfolded by its head, everything in a sheet; its buttons reach the application', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const acted = [];
    const handle = mount(root, { load: async () => ({ messages: [line('l1', 0, mail('a'))] }), send: async () => {}, words: en, every: 0, touch: false, act: (id) => acted.push(id) });
    t.after(() => { try { handle.destroy(); } catch { /* gone */ } leave(); });
    await settle(); await settle();
    const card = root.querySelector('.parley-request');
    assert.ok(card, 'a card, not a grey line');
    assert.equal(root.querySelector('.parley-system'), null);
    assert.equal(card.querySelector('.parley-request-title').textContent, 'Send “Quote a” to sales@example.com');
    assert.equal(card.querySelector('.parley-request-sub').textContent, 'Work mailbox · 8 lines · 1 attachment');
    const head = card.querySelector('.parley-request-head');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    assert.equal(card.querySelector('.parley-request-body'), null, 'folded: no body');
    assert.equal(card.querySelector('.parley-request-yes').textContent, 'Send', 'the button says the act');
    head.click();
    assert.equal(card.querySelector('.parley-request-head').getAttribute('aria-expanded'), 'true');
    const body = card.querySelector('.parley-request-body');
    assert.ok(body.textContent.includes('sales@example.com · outside'), 'someone outside is said so');
    const quote = card.querySelector('.parley-request-quote');
    assert.equal(quote.dataset.clip, 'true');
    assert.ok(!quote.textContent.includes('the last line'), 'unfolded: its first lines only');
    assert.ok(body.textContent.includes('Why: you asked for it'));
    /* See all: a sheet over the page, its whole text, the same buttons. */
    card.querySelector('.parley-request-all').click();
    const sheet = root.querySelector('.parley-request-sheet');
    assert.ok(sheet, 'See all opens a sheet');
    assert.equal(sheet.getAttribute('role'), 'dialog');
    assert.ok(sheet.querySelector('.parley-request-quote').textContent.includes('the last line'), 'the sheet has all of it');
    sheet.querySelector('.parley-request-close').click();
    assert.equal(root.querySelector('.parley-request-sheet'), null, 'Close closes it');
    /* Refuse: the application is told at once, the buttons go off while it answers. */
    card.querySelector('.parley-request-no').click();
    assert.deepEqual(acted, ['deny:a']);
    assert.equal(root.querySelector('.parley-request-yes').disabled, true);
});

test('irreversible: amber edge, unfolded, its act held a moment with Undo; undone, nothing goes; else it goes', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const acted = [];
    const handle = mount(root, { load: async () => ({ messages: [line('l1', 0, mail('h', { irreversible: true, risk: ['Goes outside your domain'], hold: 0.05 }))] }), send: async () => {}, words: en, every: 0, touch: false, act: (id) => acted.push(id) });
    t.after(() => { try { handle.destroy(); } catch { /* gone */ } leave(); });
    await settle(); await settle();
    const card = root.querySelector('.parley-request');
    assert.equal(card.dataset.irreversible, 'true');
    assert.equal(card.dataset.open, 'true', 'the newest irreversible one arrives unfolded');
    assert.ok(card.querySelector('.parley-request-risk').textContent.includes('Goes outside your domain'));
    card.querySelector('.parley-request-yes').click();
    assert.ok(card.querySelector('.parley-request-hold'), 'held: its time running, and Undo');
    assert.equal(card.querySelector('.parley-request-hold-text').textContent, 'Send in a moment');
    card.querySelector('.parley-request-undo').click();
    assert.equal(card.querySelector('.parley-request-hold'), null, 'undone');
    await wait(80);
    assert.deepEqual(acted, [], 'nothing went');
    card.querySelector('.parley-request-yes').click();
    await wait(80);
    assert.deepEqual(acted, ['allow:h'], 'once its time ran out, it went');
});

test('other ways to accept wait behind "⋯", and are held as the act is', async () => {
    const leave = fakePage();
    try {
        const acted = [];
        const card = requestCard(mail('o', { others: [{ id: 'always:o', label: 'Always allow sales@example.com' }], hold: 0.03 }), { words: en, act: (id) => acted.push(id) });
        document.body.append(card);
        assert.equal(card.querySelector('.parley-request-others').hidden, true, 'not in sight at first');
        card.querySelector('.parley-request-dots').click();
        assert.equal(card.querySelector('.parley-request-others').hidden, false);
        card.querySelector('.parley-request-other').click();
        assert.equal(card.querySelector('.parley-request-hold-text').textContent, 'Always allow sales@example.com in a moment');
        await wait(60);
        assert.deepEqual(acted, ['always:o']);
    } finally { leave(); }
});

test('several at once: one block, a line each; Accept covers only the reversible ones; Refuse all refuses all', async () => {
    const leave = fakePage();
    try {
        const acted = [];
        const ctx = { act: (id) => acted.push(id), words: en, key: 'blk' };
        const list = [mail('p'), { ...mail('q'), kind: 'contacts', title: 'Add Ann Example' }, mail('r', { irreversible: true, kind: 'files', title: 'Delete drafts/old' })];
        const block = requestBlock(list, ctx); document.body.append(block);
        assert.equal(block.querySelector('.parley-requests-head').textContent, '3 requests');
        assert.equal(block.querySelectorAll('.parley-requests-line').length, 3);
        assert.equal(block.querySelectorAll('.parley-requests-tag').length, 1, 'the irreversible one says so');
        const yes = block.querySelector('.parley-request-yes');
        assert.equal(yes.textContent, 'Accept the 2 others');
        yes.click();
        assert.deepEqual(acted, ['allow:p', 'allow:q'], 'the irreversible one is decided alone');
        /* "See" unfolds one in the block. */
        block.querySelectorAll('.parley-requests-see')[0].click();
        assert.equal(block.querySelector('.parley-request').dataset.open, 'true');
        const other = requestBlock([mail('s'), mail('u')], { ...ctx, key: 'blk2' }); document.body.append(other);
        assert.equal(other.querySelector('.parley-request-yes').textContent, 'Accept all', 'none irreversible: all of them');
        other.querySelector('.parley-request-no').click();
        assert.deepEqual(acted.slice(2), ['deny:s', 'deny:u']);
    } finally { leave(); }
});

test('decided: one line, its mark and its time; no buttons. The same card stands alone, outside the thread', () => {
    const leave = fakePage();
    try {
        const yes = requestCard(mail('d', { state: { decision: 'yes', at: at(1) } }), { words: en, act: () => {} });
        assert.equal(yes.dataset.state, 'yes');
        assert.equal(yes.querySelector('.parley-request-mark').textContent, '✓');
        assert.equal(yes.querySelector('.parley-request-done-text').textContent, 'Accepted · Send “Quote d” to sales@example.com');
        assert.ok(yes.querySelector('.parley-request-time'));
        assert.equal(yes.querySelector('button'), null);
        const no = requestCard(mail('e', { state: { decision: 'no' } }), { words: en });
        assert.equal(no.querySelector('.parley-request-done-text').textContent, 'Refused · Send “Quote e” to sales@example.com');
        /* Without act: shown, nothing to press but See all. */
        const look = requestCard(mail('f'), { words: en });
        assert.equal(look.querySelector('.parley-request-yes'), null);
        assert.ok(look.querySelector('.parley-request-all'));
    } finally { leave(); }
});

test('its words are in both dictionaries', () => {
    const fr = texts('fr');
    for (const key of KEYS.filter((k) => k.startsWith('request-') || k.startsWith('req-'))) { assert.ok(Object.hasOwn(en, key), key); assert.ok(Object.hasOwn(fr, key), key); }
    assert.equal(texts('fr')['request-see-all'], 'Tout voir');
});

/* 0.17.70: the application gives words and values, each screen says them in its own language. */
const keyed = (id) => ({
    kind: 'calendar', title: { k: 'req-cal-move', v: { name: { k: 'req-quoted', v: { text: 'Project' } }, when: { at: '2030-11-12T15:00', end: '2030-11-12T16:00' } } },
    sub: ['Work calendar', { k: 'req-was', v: { when: { at: '2030-11-08T10:00', end: '2030-11-08T11:00' } } }, { k: 'req-guests-told', v: { count: 3 } }],
    risk: [{ k: 'req-risk-outside' }],
    facts: [[{ k: 'req-fact-to' }, [{ text: 'sales@example.com', ext: true }]], [{ k: 'req-fact-joined' }, { list: [{ k: 'req-file-size', v: { name: 'plan.pdf', size: { k: 'req-size-mb', v: { n: 1.5 } } } }, 'notes.txt'] }]],
    before: [{ at: '2030-11-08T10:00', end: '2030-11-08T11:00' }, 'Room 2'], after: [{ at: '2030-11-12T15:00', end: '2030-11-12T16:00' }, 'Room 2'],
    yes: { id: `allow:${id}`, label: { k: 'req-yes-move' } }, no: { id: `deny:${id}`, label: { k: 'req-no' } },
    others: [{ id: `always:${id}`, label: { k: 'req-always', v: { what: 'drafts/' } } }],
});

test('a card from keys: said in English, and in French with French days and numbers', () => {
    const leave = fakePage();
    try {
        const r = requestOf(keyed('k1'), { words: en, locale: 'en-GB' });
        assert.equal(r.title, 'Move “Project” to Tue 12 Nov · 15:00–16:00');
        assert.equal(r.sub, 'Work calendar · was Fri 8 Nov · 10:00–11:00 · 3 guests told');
        assert.deepEqual(r.risk, ['Goes outside your domain']);
        assert.deepEqual(r.facts, [{ label: 'To', chips: [{ text: 'sales@example.com', ext: true }] }, { label: 'Joined', text: 'plan.pdf (1.5 MB), notes.txt' }]);
        assert.deepEqual([r.yes.label, r.no.label, r.others[0].label], ['Move', 'Refuse', 'Always allow drafts/']);
        assert.deepEqual(requestOf(r), r, 'once said, it is plain text: taken back the same');
        const fr = texts('fr');
        const card = requestCard(keyed('k2'), { words: fr, act: () => {}, open: true });
        assert.equal(card.querySelector('.parley-request-title').textContent, 'Déplacer « Project » au mar. 12 nov. · 15:00–16:00');
        assert.equal(card.querySelector('.parley-request-sub').textContent, 'Work calendar · avant : ven. 8 nov. · 10:00–11:00 · 3 invités prévenus');
        assert.equal(card.querySelector('.parley-request-risk').textContent, 'Part hors de votre domaine');
        assert.equal(card.querySelector('.parley-request-yes').textContent, 'Déplacer');
        assert.equal(card.querySelector('.parley-request-no').textContent, 'Refuser');
        assert.equal(card.querySelector('.parley-request-all').textContent, 'Tout voir');
        const dts = [...card.querySelector('.parley-request-facts').children].filter((d) => d.tagName === 'DT').map((d) => d.textContent);
        assert.deepEqual(dts, ['À', 'Pièces jointes']);
        assert.ok(card.querySelector('.parley-request-facts').textContent.includes('plan.pdf (1,5 Mo), notes.txt'), 'a French number, a French unit');
        assert.ok(card.querySelector('.parley-request-was').textContent.includes('ven. 8 nov. · 10:00–11:00'));
        /* One count: its own word. */
        assert.equal(requestOf({ title: { k: 'req-guests-told-one', v: { count: 1 } } }, { words: fr }).title, '1 invité prévenu');
    } finally { leave(); }
});

test('a plain-text card, as older lines hold it, is drawn as it is in any language', () => {
    const leave = fakePage();
    try {
        const fr = texts('fr');
        const card = requestCard(mail('p'), { words: fr, act: () => {} });
        assert.equal(card.querySelector('.parley-request-title').textContent, 'Send “Quote p” to sales@example.com');
        assert.equal(card.querySelector('.parley-request-sub').textContent, 'Work mailbox · 8 lines · 1 attachment');
        assert.equal(card.querySelector('.parley-request-yes').textContent, 'Send');
        assert.equal(card.querySelector('.parley-request-all').textContent, 'Tout voir', 'the screen’s own words in its language');
        assert.deepEqual(requestOf(mail('p'), { words: fr }), requestOf(mail('p')), 'plain text: words change nothing');
    } finally { leave(); }
});

test('days and times in the locale: French, English, a day without a time, a date that is not one', () => {
    const fr = texts('fr');
    const say = (when, words = fr, locale) => requestOf({ title: { k: 'req-leaves', v: { when } } }, { words, locale }).title;
    assert.equal(say({ at: '2030-01-10T09:05', end: '2030-01-10T10:30' }), 'jeu. 10 janv. · 09:05–10:30 (attend dans Brouillons)');
    assert.equal(say({ at: '2030-01-10' }), 'jeu. 10 janv. (attend dans Brouillons)');
    assert.equal(say({ at: '2030-01-10T23:30:00Z' }, fr, 'fr-FR'), 'jeu. 10 janv. · 23:30 (attend dans Brouillons)', 'the time as given: no zone moves it to another day');
    assert.equal(say({ at: '2030-01-10T15:00' }, en, 'en-GB'), 'Thu 10 Jan · 15:00 (waits in Drafts)');
    assert.equal(say({ at: 'Tomorrow' }, en), 'Tomorrow (waits in Drafts)');
    /* Through the thread: view says them with its words and locale. */
    const v = view({ messages: [line('l1', 0, keyed('k3'))] }, { words: fr, locale: 'fr-FR' });
    assert.equal(v.rows.find((r) => r.request).request.title, 'Déplacer « Project » au mar. 12 nov. · 15:00–16:00');
});

/* 0.17.71: the application's own lines (a request accepted, done, failed; later news) from words too. */
const said = (id, m, text, more = {}) => ({ from: 'system', id, at: at(m), text, level: 'needs-you', tone: 'warn', actions: [], ...more });
const failed = { k: 'line-failed', v: { verb: 'mail.send', reason: 'the server refused it' }, t: 'Failed: mail.send — the server refused it' };
const bounced = { k: 'line-notice', v: { head: { k: 'notice-mail-bounced', t: 'Mail came back' }, target: 'Work mail', text: 'No such mailbox.' }, t: 'Mail came back (Work mail): No such mailbox.' };

test('a line from keys: said in English and in French, its topic too', async () => {
    const lines = [said('a', 0, failed, { topic: { k: 'line-topic-request', t: 'Request' } }), said('b', 1, bounced, { topic: { k: 'line-topic-notice', t: 'Later news' } })];
    const fr = texts('fr');
    const rows = (words, locale) => view({ messages: lines }, { words, locale, detailed: true }).rows.filter((r) => r.from === 'system');
    assert.deepEqual(rows(en).map((r) => [r.text, r.topic]), [['Failed: mail.send — the server refused it', 'Request'], ['Mail came back (Work mail): No such mailbox.', 'Later news']]);
    assert.deepEqual(rows(fr, 'fr-FR').map((r) => [r.text, r.topic]), [['Échec : mail.send — the server refused it', 'Demande'], ['Mail revenu (Work mail) : No such mailbox.', 'Nouvelles']]);
    assert.equal(lineText({ k: 'line-accepted', v: { verb: 'calendar.move' } }, { words: fr }), 'Accepté : calendar.move — en cours');
    assert.equal(lineText({ k: 'line-done', v: { verb: 'mail.send' } }, { words: en }), 'Done: mail.send');
    const leave = fakePage();
    try {
        const root = document.createElement('div'); document.body.append(root);
        const handle = mount(root, { load: async () => ({ messages: lines }), send: async () => {}, words: fr, every: 0, touch: false, detailed: true });
        await settle();
        const shown = [...root.querySelectorAll('.parley-system-text')].map((n) => n.textContent);
        assert.ok(shown.includes('Échec : mail.send — the server refused it'), shown.join(' | '));
        assert.ok(shown.includes('Mail revenu (Work mail) : No such mailbox.'), shown.join(' | '));
        handle.destroy?.();
    } finally { leave(); }
});

test('a plain line is shown as it is; a word this screen does not know, its English fallback', () => {
    const fr = texts('fr');
    const v = view({ messages: [said('p', 0, 'Done: mail.send', { topic: 'Demande' })] }, { words: fr, detailed: true });
    const row = v.rows.find((r) => r.from === 'system');
    assert.equal(row.text, 'Done: mail.send');
    assert.equal(row.topic, 'Demande');
    assert.equal(lineText('Plain text', { words: fr }), 'Plain text');
    assert.equal(lineText({ k: 'line-from-the-future', v: { verb: 'x' }, t: 'Something new: x' }, { words: fr }), 'Something new: x');
    assert.equal(lineText({ k: 'line-done', v: { verb: 'x' }, t: 'Done: x' }), 'Done: x', 'no words at all: the English fallback');
    assert.equal(lineText({ k: 'notice-mail-delayed' }, { words: fr }), 'Mail retardé');
});

test('the words of the lines are in both dictionaries', () => {
    const fr = texts('fr');
    for (const key of KEYS.filter((k) => k.startsWith('line-') || k.startsWith('notice-'))) {
        assert.ok(Object.hasOwn(en, key), key); assert.ok(Object.hasOwn(fr, key), key);
        if (!/^line-notice/.test(key)) assert.notEqual(fr[key], en[key], `${key} is said in French`);
    }
});
