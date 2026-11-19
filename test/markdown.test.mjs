import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakePage } from './fake-dom.mjs';
import { mount, markdown, inline, safeLink, plainOf, view, maskSecrets, timesIn, TIMES } from '../ui/parley-ui.js';
import { texts, cited } from '../host/parley-host.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('../ui/parley-ui.js', import.meta.url)), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();

/* Every element under a node, depth first. */
const elements = (node) => node.children.flatMap((c) => [c, ...elements(c)]);
const pages = new WeakMap();
/* Mounts the screen on a fake page with one message of the agent. */
async function shown(t, text, { refs = [], picture, diagram, highlight, short, open = () => {}, after = false, secrets, forget, from = 'agent' } = {}) {
    /* One page per test, taken away after every chat on it. */
    if (!pages.has(t)) { const leave = fakePage(); pages.set(t, []); t.after(() => { for (const h of pages.get(t)) h.destroy(); leave(); }); }
    const root = document.createElement('div');
    document.body.append(root);
    const opened = [];
    /* `after`: a later message of the agent, so that this one is not the newest (the newest is never folded). */
    const handle = mount(root, { load: async () => ({ messages: [{ from, id: 'm', at: at(0), kind: 'say', text, refs, ...(short ? { short } : {}) }, ...(after ? [{ from: 'agent', id: 'n', at: at(1), kind: 'say', text: 'Next.' }] : [])] }), send: async () => {}, words: texts('en'), every: 0, touch: false,
        markdown: true, picture, diagram, highlight, secrets, forget, open: (f) => { opened.push(f); open(f); } });
    pages.get(t).push(handle);
    await settle(); await settle();
    return { root, said: root.querySelector('.parley-said'), opened, handle };
}

test('Markdown is read into plain data: headings, lists, tasks, emphasis, tables, quotes, alerts, badges, code', () => {
    const blocks = markdown('# Disk\n\nIt is **full**, _really_ ==now== [blocked].\n\n- **Snaps**: 1.5 GB\n- npm: 240 MB\n  - [x] cleaned\n\n1. one\n2. two\n\n> [!IMPORTANT]\n> Grow the disk.\n\n| What | Size |\n|---|--:|\n| a `x|y` | 1 |\n\n```bash\ndf -h /\n```');
    assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'list', 'list', 'alert', 'table', 'code']);
    assert.deepEqual(blocks[1].c.map((n) => n.t), ['text', 'strong', 'text', 'em', 'text', 'mark', 'text', 'badge', 'text']);
    assert.equal(blocks[2].items[1].c[1].items[0].task, true, 'a task, nested');
    assert.deepEqual([blocks[4].kind, plainOf(blocks[4].c[0].c)], ['important', 'Grow the disk.']);
    assert.deepEqual(blocks[5].align, ['', 'right']);
    assert.deepEqual(blocks[5].rows[0][0].map((n) => [n.t, n.v]), [['text', 'a '], ['code', 'x|y']], 'a "|" in code is text');
    assert.deepEqual([blocks[6].lang, blocks[6].text], ['bash', 'df -h /']);
    assert.equal(markdown('snake_case_name and 2*3*4').map((b) => plainOf(b.c)).join(), 'snake_case_name and 2*3*4', 'no emphasis inside words or numbers');
    /* Deep nesting is bounded, never a crash. */
    assert.doesNotThrow(() => markdown(`${'> '.repeat(500)}deep\n${'- '.repeat(500)}x\n${'*'.repeat(5000)}`));
});

test('a link is followed only when it is http or https; anything else is its text', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.example/x', 'file:///etc/passwd', 'relative/page.html', 'java\nscript:x'])
        assert.equal(safeLink(bad), null, bad);
    assert.equal(safeLink('https://example.com/a b'), 'https://example.com/a%20b');
    assert.equal(safeLink('HTTP://Example.com'), 'http://example.com/');
});

test('ATTACKS: what an agent writes never becomes markup, a script, a remote load, or a link elsewhere', async (t) => {
    const text = [
        '<script>window.pwned = 1</script><img src=x onerror="window.pwned=1"> <b onclick="x()">bold?</b>',
        '[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [ok](https://example.com/) <https://example.org/x>',
        '![remote](https://evil.example/track.png) ![data](data:image/png;base64,AAAA) ![svg](/work/x.svg) ![shared](/work/shot.png) ![not shared](/elsewhere/y.png)',
        '<iframe src="https://evil.example"></iframe> <svg onload=alert(1)>',
        '```html\n<script>alert(1)</script>\n```',
    ].join('\n\n');
    const { said, opened } = await shown(t, text, { refs: [{ path: '/work/shot.png', open: 'work:shot.png' }, { path: '/work/x.svg', open: 'work:x.svg' }], picture: (f) => `/pictures?p=${encodeURIComponent(f.open)}` });
    const all = elements(said);
    const tags = new Set(all.map((e) => e.tagName.toLowerCase()));
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style', 'link', 'meta', 'base']) assert.equal(tags.has(tag), false, `no <${tag}>`);
    assert.equal(globalThis.pwned, undefined);
    for (const e of all) for (const name of e.attributes.keys()) assert.doesNotMatch(name, /^on/i, `no handler attribute on ${e.tagName}`);
    const links = all.filter((e) => e.tagName === 'A');
    assert.deepEqual(links.map((a) => a.href), ['https://example.com/', 'https://example.org/x'], 'only the http(s) links are links');
    assert.ok(links.every((a) => a.target === '_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)));
    const pictures = all.filter((e) => e.tagName === 'IMG');
    assert.deepEqual(pictures.map((i) => i.src), ['/pictures?p=work%3Ashot.png'], 'a picture only from a shared folder, never from elsewhere, never an SVG');
    assert.ok(said.textContent.includes('<script>window.pwned = 1</script>'), 'a tag is shown as the text it is');
    assert.ok(said.textContent.includes('remote'), 'a picture not shown keeps its caption');
    pictures[0].parentNode.click();
    assert.equal(opened.length, 0, 'a picture opens large here, not elsewhere');
});

test('the library never writes markup: no innerHTML, no HTML parser, no eval, anywhere in it', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'DOMParser', 'document.write', 'eval(', 'new Function', 'createContextualFragment', 'srcdoc'])
        assert.equal(SOURCE.includes(bad), false, bad);
});

test('paths it cites become links that open the shared file; code is coloured from a token tree, made into spans here', async (t) => {
    assert.deepEqual(cited('See /work/PR-DESCRIPTION.md, `/work/a b` and [the plan](/resources/notes/plan.md) or https://example.com/work/x.'), ['/resources/notes/plan.md', '/work/PR-DESCRIPTION.md', '/work/a']);
    const highlight = async (code, lang) => [{ type: 'keyword', content: 'let' }, ' a = ', { type: 'number', content: '1' }, { type: 'evil"><script', content: '<b>x</b>' }];
    const { said, opened } = await shown(t, 'The text is in /work/PR-DESCRIPTION.md.\n\n```js\nlet a = 1\n```', { refs: [{ path: '/work/PR-DESCRIPTION.md', open: 'work:PR-DESCRIPTION.md' }], highlight });
    const link = said.querySelector('.parley-pathlink');
    assert.equal(link.textContent, '/work/PR-DESCRIPTION.md');
    link.click();
    assert.deepEqual(opened, [{ path: '/work/PR-DESCRIPTION.md', open: 'work:PR-DESCRIPTION.md' }]);
    await settle();
    const spans = said.querySelectorAll('.parley-tok');
    assert.deepEqual(spans.map((s) => [s.className, s.textContent]), [['parley-tok parley-tok-keyword', 'let'], ['parley-tok parley-tok-number', '1'], ['parley-tok', '<b>x</b>']], 'a type that is not a plain name is no class; content is text');
    assert.ok(said.querySelector('.parley-copy'), 'a Copy button on the block');
});

test('a mermaid drawing is shown as a picture, never as markup; a failure shows its code', async (t) => {
    const urls = [];
    const made = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = (blob) => { urls.push(blob.type); return `blob:test/${urls.length}`; };
    t.after(() => { globalThis.URL.createObjectURL = made; });
    const ok = await shown(t, '```mermaid\nflowchart LR\nA --> B\n```', { diagram: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>flow</text></svg>' });
    await settle();
    const img = ok.said.querySelector('img');
    assert.equal(img.src, 'blob:test/1'); assert.deepEqual(urls, ['image/svg+xml']);
    const pie = await shown(t, '```mermaid\npie title Disk\n"snaps" : 1.5\n```', { diagram: async () => { throw new Error('a pie is drawn here, in the screen\'s colours'); } });
    await settle();
    assert.ok(pie.said.querySelector('.parley-chart') && !pie.said.querySelector('img'), 'a Mermaid pie: a chart of its own');
    const bad = await shown(t, '```mermaid\ngraph TD\nA-->B\nclick A "javascript:alert(1)"\n```', { diagram: async () => { throw new Error('no'); } });
    await settle();
    assert.equal(bad.said.querySelector('img'), null);
    assert.match(bad.said.querySelector('pre').textContent, /click A/, 'its code, as text');
    const notSvg = await shown(t, '```mermaid\nx\n```', { diagram: async () => '<script>alert(1)</script>' });
    await settle();
    assert.equal(notSvg.said.querySelector('img'), null, 'what is not a drawing is not shown as one');
});

test('a short version longer than a title: folded, it is cut at a word with "…"; opened, it is all there; none of it is lost on the way', async (t) => {
    const long = `Intro.\n\n${Array.from({ length: 30 }, (_, i) => `- point ${i}`).join('\n')}`;
    const short = `Done: a pre-push hook is in place in both repositories. It runs the check and blocks only on a new failure. Nothing is versioned, the hooks already there are kept. The automatic sending still waits for the next commit to go.`;
    assert.ok(short.length > 200);
    const { said, root } = await shown(t, long, { short, after: true });
    const folded = said.querySelector('.parley-short').textContent;
    assert.ok(folded.endsWith('…') && folded.length <= 200, folded);
    assert.ok(short.startsWith(folded.slice(0, -1)), 'its beginning, as written');
    assert.match(folded, /\S…$/); assert.ok(/[\s]/.test(short[folded.length - 1] ?? ' '), 'cut at the end of a word, not inside one');
    said.querySelector('.parley-unfold').click();
    await settle();
    assert.equal(root.querySelector('.parley-short').textContent, short, 'opened: all of it');
});

test('two versions of a message: the short one first, the rest on demand, its IMPORTANT box always in sight', async (t) => {
    const long = `Intro.\n\n${Array.from({ length: 30 }, (_, i) => `- point ${i}`).join('\n')}\n\n> [!IMPORTANT]\n> Decide by Friday.`;
    /* The newest message of the agent is never folded: nothing seems left below it. */
    const newest = await shown(t, long, { short: 'Disk full: 3 things to do' });
    assert.match(newest.said.textContent, /point 12/); assert.equal(newest.said.querySelector('.parley-unfold'), null);
    assert.equal((await shown(t, long)).said.querySelector('[data-clip]'), null, 'nor cut short with a fade');
    const { said, root } = await shown(t, long, { short: 'Disk full: 3 things to do', after: true });
    assert.equal(said.querySelector('.parley-short').textContent, 'Disk full: 3 things to do');
    assert.match(said.textContent, /Decide by Friday/, 'its IMPORTANT box, folded or not');
    assert.doesNotMatch(said.textContent, /point 12/);
    said.querySelector('.parley-unfold').click();
    await settle();
    assert.match(root.querySelector('.parley-said').textContent, /point 12/, 'unfolded');
    /* Without a short version, a long one is folded, its box below the fold still shown. */
    const v = view({ messages: [{ from: 'agent', id: 'a', at: at(0), kind: 'say', text: long }] }, { words: texts('en') });
    assert.equal(v.items[0].short, '');
    const other = await shown(t, long, { after: true });
    assert.equal(other.said.querySelector('.parley-md').dataset.clip, 'true');
    assert.equal(other.said.querySelectorAll('.parley-callout').length, 2, 'in the folded text, and in sight below it');
    /* A question is never folded. */
    const asked = view({ messages: [{ from: 'agent', id: 'q', at: at(0), kind: 'ask', text: long, choices: ['yes'] }] }, { words: texts('en') });
    assert.equal(asked.items[0].open, true);
});

test('a lifted secret is one node, shown as stars, never the value', () => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E⟩';
    const nodes = inline(`the key is ${marker} now`);
    const sec = nodes.find((n) => n.t === 'secret');
    assert.deepEqual(sec, { t: 'secret', name: 'SECRET_0A1B2C3D4E' });
    assert.equal(plainOf(nodes), 'the key is ••••• now', 'copy/search see stars, not the marker');
    assert.equal(maskSecrets(`a ${marker} b`), 'a ••••• b');
    assert.equal(inline('ordinary text, no secret').every((n) => n.t === 'text'), true, 'ordinary text is untouched');
});

test('a secret in a shown message renders as a stars chip, the value nowhere in the page', async (t) => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E⟩';
    const { root } = await shown(t, `here: ${marker} use it`);
    const chip = root.querySelector('.parley-secret');
    assert.ok(chip, 'a secret chip is drawn');
    assert.ok(chip.textContent.includes('•••••'), 'it shows stars');
    assert.ok(!root.textContent.includes('SECRET_0A1B2C3D4E'), 'the reference name is not shown');
    assert.ok(!root.textContent.includes('⟨'), 'the raw marker is not shown');
});

test('a live secret chip shows the minutes left and a button that forgets it', async (t) => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E⟩';
    let forgot = null;
    const { root } = await shown(t, `here is ${marker}`, { secrets: { SECRET_0A1B2C3D4E: { expiresInMs: 9 * 60_000 } }, forget: (name) => { forgot = name; } });
    const chip = root.querySelector('.parley-secret');
    assert.ok(chip, 'a chip');
    assert.ok(chip.textContent.includes('9'), 'shows the minutes left');
    assert.ok(chip.textContent.includes('•••••'), 'still stars, never the value');
    const btn = chip.querySelector('.parley-secret-forget');
    assert.ok(btn, 'a forget button when it is live');
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(forgot, 'SECRET_0A1B2C3D4E', 'clicking it forgets that secret');
    assert.match(chip.textContent, /deleted/, '19-11: it says so');
    assert.ok(!chip.querySelector('.parley-secret-forget'), 'and its button goes');
});

test('a secret not deleted says why; one deleted a moment ago stays said « deleted » (19-11)', async (t) => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E⟩';
    const { root } = await shown(t, `here is ${marker}`, { secrets: { SECRET_0A1B2C3D4E: { expiresInMs: 9 * 60_000 } }, forget: async () => { throw new Error('the vault is locked'); } });
    const chip = root.querySelector('.parley-secret');
    chip.querySelector('.parley-secret-forget').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(chip.textContent, /not deleted: the vault is locked/);
    assert.ok(chip.querySelector('.parley-secret-forget'), 'its button stays, to try again');
    const gone = await shown(t, `here is ${marker}`, { secrets: { SECRET_0A1B2C3D4E: { gone: true } }, forget: () => {} });
    const c2 = gone.root.querySelector('.parley-secret');
    assert.match(c2.textContent, /deleted/);
    assert.ok(!c2.querySelector('.parley-secret-forget'));
});

test('a secret with nothing live shown about it: stars, no button (expired or not passed)', async (t) => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E⟩';
    const { root } = await shown(t, `old ${marker}`);          /* no secrets map, no forget */
    const chip = root.querySelector('.parley-secret');
    assert.ok(chip && chip.textContent.includes('•••••'));
    assert.ok(!chip.querySelector('.parley-secret-forget'), 'no button without a live secret');
});

test('the secret chip renders in the PERSON\'s own bubble too (not the raw marker)', async (t) => {
    const marker = '⟨secret:SECRET_0A1B2C3D4E@' + (Date.now() + 9 * 60_000) + '⟩';
    const { root } = await shown(t, `my token is ${marker} ok`, { from: 'person', after: true, secrets: { SECRET_0A1B2C3D4E: { expiresInMs: 9 * 60_000 } }, forget: () => {} });
    const bubble = root.querySelector('.parley-said[data-from="person"]');
    assert.ok(bubble, 'a person bubble');
    const chip = bubble.querySelector('.parley-secret');
    assert.ok(chip, 'the stars chip renders in the person bubble');
    assert.ok(chip.textContent.includes('•••••'), 'stars, not the marker');
    assert.ok(chip.textContent.includes('9'), 'with the time left');
    assert.ok(!root.textContent.includes('⟨secret:'), 'the raw marker is never shown');
});

/* TIMES WITH THEIR ZONE (15-11): read in Paris, on 15 Nov 2026 (UTC+1), a message written that morning. */
const PARIS = { zone: 'Europe/Paris', locale: 'fr', at: Date.parse('2026-11-15T07:42:00Z'), now: Date.parse('2026-11-15T12:00:00Z') };
/* What the reader sees: the text, each time found in brackets. */
const seen = (text, options = {}) => timesIn(text, { ...PARIS, ...options }).map((x) => (typeof x === 'string' ? x : `[${x.text}]`)).join('');

test('times: each form written with its zone is shown in the reader\'s, the time only today, else the day', () => {
    assert.equal(seen('2026-11-15T09:00:00Z'), '[10:00]', 'today: the time only');
    assert.equal(seen('2026-11-16T09:00Z'), '[16 nov., 10:00]', 'another day: the day too');
    assert.equal(seen('2026-11-15T23:30Z'), '[16 nov., 00:30]', 'the day changes as well');
    assert.equal(seen('2026-11-15T10:00+01:00'), '[10:00]', 'an offset of its own');
    assert.equal(seen('2026-11-15T04:00-05:00'), '[10:00]');
    assert.equal(seen('2026-11-15 09:00 UTC'), '[10:00]', 'a space, and UTC in words');
    assert.equal(seen('15-11 09:00 UTC'), '[10:00]', 'day-month: the year of the message');
    assert.equal(seen('03-04 09:00 UTC'), '[3 avr., 11:00]', 'day-month, never month-day');
    assert.equal(seen('a 09:00 (UTC), 9h UTC, 9 h UTC, 09:00 GMT, 09:00Z'), 'a [10:00], [10:00], [10:00], [10:00], [10:00]', 'a time only: the day of the message');
    assert.equal(seen('9h30 UTC et 11:00 UTC+2'), '[10:30] et [10:00]');
    assert.equal(seen('Prod at 09:00 UTC, window until 2026-11-16T07:00Z.'), 'Prod at [10:00], window until [16 nov., 08:00].');
    const [found] = timesIn('2026-11-16T07:00Z', PARIS);
    assert.deepEqual([found.at, found.written], [Date.parse('2026-11-16T07:00:00Z'), '2026-11-16T07:00Z'], 'the moment, and what was written');
    assert.equal(seen('2027-01-02T09:00Z'), '[2 janv. 2027, 10:00]', 'another year: the year too');
});

test('times: winter and summer in Paris (CET +1, CEST +2), the change of day both ways', () => {
    assert.equal(seen('2026-07-01 09:00 UTC'), '[1 juil., 11:00]', 'summer: +2');
    assert.equal(seen('2026-01-15T09:00Z'), '[15 janv., 10:00]', 'winter: +1');
    assert.equal(seen('2026-03-29T00:59Z'), '[29 mars, 01:59]', 'just before the change of March');
    assert.equal(seen('2026-03-29T01:00Z'), '[29 mars, 03:00]', 'just after it');
    assert.equal(seen('2026-10-25T00:30Z'), '[25 oct., 02:30]', 'October, before: still summer');
    assert.equal(seen('2026-10-25T01:30Z'), '[25 oct., 02:30]', 'after: winter again');
    /* A time only takes the message's day: in summer it is two hours on. */
    assert.equal(seen('a 09:00 UTC', { at: Date.parse('2026-07-01T06:00:00Z'), now: Date.parse('2026-07-01T12:00:00Z') }), 'a [11:00]');
    assert.equal(seen('a 23:30 UTC'), 'a [16 nov., 00:30]', 'its day changes in Paris');
    /* Written east of UTC, the message's day is the one of that zone. */
    assert.equal(seen('09:00 UTC+9', { at: Date.parse('2026-11-14T20:00:00Z'), now: Date.parse('2026-11-15T12:00:00Z') }), '[01:00]', 'the 15th in Tokyo: today in Paris');
    assert.equal(seen('2026-11-15T09:00Z', { zone: 'America/New_York', locale: 'en-US' }), '[4:00 AM]', 'elsewhere, its own way');
});

test('times: nothing else is touched -- a date alone, a time without zone, relative words, numbers, ranges, nonsense', () => {
    for (const text of ['2026-11-15', 'a 09:00', 'at 9:00 tomorrow', 'demain 9 h, dans 2 h', '1763197200', 'demain 09:00 UTC', 'tomorrow at 9h UTC', 'lundi 09:00 UTC',
        'le 16 a 09:00 UTC', '16 nov. 09:00 UTC', '2026-11-16 at 07:00 UTC', 'dans 2 h UTC', '09:00-10:00 UTC', '9h-10h UTC', 'v1.2.10:00Z', 'build-09:00Z',
        '25:00 UTC', '09:75 UTC', '2026-13-01T09:00Z', '2026-02-30T09:00Z', '31-02 09:00 UTC', '2026-11-15T09:00+15:00', '09:00 UTCX', '2026-11-15T09:00Zulu', 'score 3-2 UTC', 'UTC 09:00'])
        assert.equal(seen(text), text, text);
});

test('times: "as written" changes nothing; "full" says the weekday', () => {
    assert.deepEqual(TIMES, ['short', 'full', 'written']);
    assert.deepEqual(timesIn('at 09:00 UTC, 2026-11-16T09:00Z', { ...PARIS, as: 'written' }), ['at 09:00 UTC, 2026-11-16T09:00Z']);
    assert.equal(seen('2026-11-15T09:00Z and 2026-11-16T09:00Z', { as: 'full' }), '[dim. 15 nov., 10:00] and [lun. 16 nov., 10:00]');
    assert.equal(seen('2026-11-15T09:00Z', { locale: 'en-GB', as: 'full' }), '[Sun 15 Nov, 10:00]');
});

/* The screen, in Paris: a message of the agent with times in its text, its code, a link. */
async function timed(t, text, options = {}) {
    const leave = fakePage();
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async () => ({ messages: [{ from: 'agent', id: 'm', at: new Date(PARIS.at).toISOString(), kind: 'say', text }] }), send: async () => {}, words: texts('fr'), every: 0, touch: false,
        markdown: true, locale: 'fr', timeZone: 'Europe/Paris', ...options });
    t.after(() => { handle.destroy(); leave(); });
    await settle(); await settle();
    return { root, said: root.querySelector('.parley-said') };
}

test('times on screen: a <time> with the moment, what was written on hover and for a screen reader; code and links as written', async (t) => {
    const text = 'Prod at 09:00 UTC, until 2026-11-16T07:00Z.\n\nRun `at 09:00 UTC` and see [the 09:00 UTC plan](https://example.com/plan).\n\n```\n2026-11-16T07:00Z\n```';
    const { said } = await timed(t, text);
    const times = said.querySelectorAll('time.parley-at');
    assert.equal(times.length, 2, 'two times, none in code or the link');
    const want = (x) => timesIn(x, { ...PARIS, now: Date.now() })[0].text;
    assert.deepEqual(times.map((e) => e.textContent), [want('2026-11-15T09:00Z'), want('2026-11-16T07:00Z')], 'in Paris, today or not as the clock says');
    assert.equal(times[1].getAttribute('datetime'), '2026-11-16T07:00Z');
    assert.equal(times[1].title, 'Écrit : 2026-11-16T07:00Z');
    assert.equal(times[1].getAttribute('aria-label'), `${times[1].textContent} (Écrit : 2026-11-16T07:00Z)`);
    assert.equal(times[0].title, 'Écrit : 09:00 UTC');
    assert.deepEqual(said.querySelectorAll('code').map((c) => c.textContent), ['at 09:00 UTC', '2026-11-16T07:00Z'], 'inline code and a block of code untouched');
    assert.equal(said.querySelector('a.parley-link').textContent, 'the 09:00 UTC plan', 'a link untouched');
    assert.ok(!said.querySelector('pre').querySelector('time') && !said.querySelector('a.parley-link').querySelector('time'));
});

test('times on screen: a long press shows what was written, a few seconds; a mouse does nothing', async (t) => {
    const { said } = await timed(t, 'Prod at 09:00 UTC.');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const time = said?.querySelector('time.parley-at');
    assert.ok(time, 'a time');
    const shownText = time.textContent;
    time.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse' }); t.mock.timers.tick(600);
    assert.equal(time.textContent, shownText, 'a mouse has the hover');
    time.dispatchEvent({ type: 'pointerdown', pointerType: 'touch' }); t.mock.timers.tick(200); time.dispatchEvent({ type: 'pointerup', pointerType: 'touch' }); t.mock.timers.tick(600);
    assert.equal(time.textContent, shownText, 'a short tap: nothing');
    time.dispatchEvent({ type: 'pointerdown', pointerType: 'touch' }); t.mock.timers.tick(500);
    assert.equal(time.textContent, '09:00 UTC', 'held: as written');
    t.mock.timers.tick(4100);
    assert.equal(time.textContent, shownText, 'then back');
});

test('times in the menu of settings: their way and their zone, told to the application, drawn again at once', async (t) => {
    const told = []; const zones = [];
    const { root } = await timed(t, 'Prod at 09:00 UTC.', { onTimes: (v) => told.push(v), onTimeZone: (z) => zones.push(z) });
    const as = root.querySelector('select.parley-times-as');
    const zone = root.querySelector('select.parley-times-zone');
    assert.ok(as && zone, 'two lines in the menu');
    assert.deepEqual(as.querySelectorAll('option').map((o) => [o.value, o.textContent]), [['short', 'Courtes'], ['full', 'Complètes'], ['written', "Telles qu'écrites"]]);
    assert.equal(as.value, 'short');
    root.querySelector('.parley-prefs-open').click();
    const options = zone.querySelectorAll('option');
    assert.equal(options[0].value, '', 'the browser\'s first');
    assert.match(options[0].textContent, /^Navigateur \(.+\)$/);
    assert.ok(options.some((o) => o.value === 'Asia/Tokyo') && options.some((o) => o.value === 'UTC'));
    assert.equal(zone.value, 'Europe/Paris', 'the one given');
    as.value = 'written'; as.dispatchEvent({ type: 'change' }); await settle();
    assert.deepEqual(told, ['written']);
    assert.equal(root.querySelector('.parley-said').querySelector('time.parley-at'), null, 'as written: no time converted');
    assert.ok(root.querySelector('.parley-said').textContent.includes('Prod at 09:00 UTC.'));
    as.value = 'short'; as.dispatchEvent({ type: 'change' }); await settle();
    zone.value = 'Asia/Tokyo'; zone.dispatchEvent({ type: 'change' }); await settle();
    assert.deepEqual(zones, ['Asia/Tokyo']);
    assert.equal(root.querySelector('.parley-said').querySelector('time.parley-at').getAttribute('datetime'), '2026-11-15T09:00Z', 'the same moment');
    assert.match(root.querySelector('.parley-said').querySelector('time.parley-at').textContent, /18:00$/, 'in Tokyo now');
    zone.value = ''; zone.dispatchEvent({ type: 'change' }); await settle();
    assert.deepEqual(zones, ['Asia/Tokyo', ''], 'back to the browser\'s');
});

test('times: what the agent wrote stays as written for the thread and its copy -- markdown() does not change', () => {
    assert.deepEqual(plainOf(inline('at 09:00 UTC')), 'at 09:00 UTC');
    assert.ok(!SOURCE.slice(SOURCE.indexOf('export function markdown('), SOURCE.indexOf('export function markdown(') + 4000).includes('timesIn'));
});
