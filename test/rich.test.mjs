import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePage } from './fake-dom.mjs';
import { mount, markdown, inline, plainOf, familyOf, zonesOf, askedZone, mathCopy, sized, MATH_OPTIONS, KATEX, FAMILY_LINKS_MAX } from '../ui/parley-ui.js';
import { install, Parley, texts, aboutOf } from '../host/parley-host.mjs';
import { bridge, RICH } from '../server/parley-mcp.mjs';
import { run } from '../bin/parley.mjs';

const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
const elements = (node) => (node.children ?? []).flatMap((c) => [c, ...elements(c)]);
const F = '```';

test('formulas: $...$, \\(...\\) in a line; $$...$$ and \\[...\\] on lines of their own; a price, code and an escaped $ stay text', () => {
    const math = (nodes) => nodes.filter((n) => n.t === 'math').map((n) => [n.tex, n.display]);
    assert.deepEqual(math(inline('Area $\\pi r^2$, and \\(a+b\\), and $$x$$ here.')), [['\\pi r^2', false], ['a+b', false], ['x', true]]);
    for (const price of ['It costs 5 $ here', '$5 and $6', 'from $5, $10 and $20', 'a $ b $ c', 'cost $5$10']) assert.equal(math(inline(price)).length, 0, price);
    assert.equal(plainOf(inline('\\$x\\$ is not one')), '$x$ is not one', 'an escaped $ is a dollar');
    assert.deepEqual(inline('`$x$`'), [{ t: 'code', v: '$x$' }], 'never in code');
    assert.equal(plainOf(inline('see $x^2$')), 'see x^2', 'a formula reads as its source');
    const blocks = markdown('Before\n$$\nC_n = C_0 (1+t)^n\n$$\nafter\n\n\\[ a + b \\]\n\n```\n$$ y $$\n```');
    assert.deepEqual(blocks.map((b) => b.t), ['p', 'math', 'p', 'math', 'code']);
    assert.deepEqual([blocks[1].tex, blocks[1].display, blocks[3].tex], ['C_n = C_0 (1+t)^n', true, 'a + b']);
    assert.deepEqual(markdown('$$ never closed\nstill text').map((b) => b.t), ['p'], 'unclosed: text');
    assert.equal(inline(`$${'x'.repeat(5000)}$`).filter((n) => n.t === 'math').length, 0, 'too long: text');
});

test('a family: couples, children by indentation, dates, notes, generations, links of another kind; a line it cannot read gives up', () => {
    const f = familyOf(`# Grandparents | Parents | Children
[Paul](app:people/1) (1925–2001) + Anna (1931), married in 1952
  Leo (1954) + Mia
    Zoe (1983)
  Eva (1958)
Rose + Max
Paul ~ Max : brothers
Anna ~ Rose : sisters
Rose ~ Eva : godmother`);
    assert.deepEqual(f.bands, ['Grandparents', 'Parents', 'Children']);
    assert.equal(f.roots.length, 2);
    const [paul, anna] = f.roots[0].people;
    assert.deepEqual([paul.name, paul.ref, paul.dates, anna.name, anna.inlaw], ['Paul', 'app:people/1', '1925–2001', 'Anna', false]);
    assert.equal(f.roots[0].note, 'married in 1952');
    assert.deepEqual(f.roots[0].children.map((c) => c.people.map((p) => p.name)), [['Leo', 'Mia'], ['Eva']]);
    assert.equal(f.roots[0].children[0].people[1].inlaw, true, 'married into the family');
    assert.deepEqual(f.roots[0].children[0].children[0].people[0].name, 'Zoe');
    assert.deepEqual(f.links, [{ a: 'Paul', b: 'Max', word: 'brothers' }, { a: 'Anna', b: 'Rose', word: 'sisters' }, { a: 'Rose', b: 'Eva', word: 'godmother' }]);
    assert.equal(familyOf('A + B + C'), null, 'three in a couple');
    assert.equal(familyOf('A\n      B'), null, 'a generation skipped');
    assert.equal(familyOf('A (19(5)4)'), null, 'brackets in brackets');
    assert.equal(familyOf(''), null);
    assert.equal(familyOf(Array.from({ length: 61 }, (_, k) => `P${k}`).join('\n')), null, 'too many people');
    assert.equal(familyOf(`A\n${Array.from({ length: 9 }, () => 'A ~ A : x').join('\n')}`).links.length, FAMILY_LINKS_MAX, 'a few links of another kind, no more');
});

test('zones on a picture: a picture, then label or ?, x y w h as fractions, a line; out of the picture or unreadable gives up', () => {
    const z = zonesOf(`![Wedding, 1952](/work/wedding.jpg)
[Anna](app:people/12)   0.20 0.30 0.18 0.36  the bride, 21
Max                     .43 .29 .20 .36
?                       0.69 0.33 0.19 0.34`);
    assert.deepEqual([z.alt, z.src], ['Wedding, 1952', '/work/wedding.jpg']);
    assert.deepEqual(z.zones.map((x) => [x.label, x.ref, x.unknown, x.box, x.line]), [
        ['Anna', 'app:people/12', false, [0.2, 0.3, 0.18, 0.36], 'the bride, 21'],
        ['Max', null, false, [0.43, 0.29, 0.2, 0.36], ''],
        ['?', null, true, [0.69, 0.33, 0.19, 0.34], ''],
    ]);
    assert.equal(zonesOf('no picture first\nA 0 0 1 1'), null);
    assert.equal(zonesOf('![x](/a.jpg)\nA 0.8 0 0.5 0.5'), null, 'out of the picture');
    assert.equal(zonesOf('![x](/a.jpg)\nA 0 0 0 0.5'), null, 'no width');
    assert.equal(zonesOf('![x](/a.jpg)\nA 0 0 2 0.5'), null, 'not a fraction');
    assert.equal(zonesOf('![x](/a.jpg)\njust words'), null);
    assert.deepEqual(askedZone(`Who is this?\n${F}picture\n![x](/work/a.jpg)\nAnna 0.1 0.1 0.2 0.2\n? 0.5 0.5 0.2 0.2\n${F}`), { label: '?', picture: '/work/a.jpg', box: [0.5, 0.5, 0.2, 0.2] });
    assert.equal(askedZone(`${F}picture\n![x](/work/a.jpg)\n? 0.1 0.1 0.2 0.2\n? 0.5 0.5 0.2 0.2\n${F}`), null, 'two asked at once: none taken for the answer');
});

test('KaTeX, as Parley gives it: its own copy with its licence and version; with no trust, TeX carries no link, class, style, picture or markup', async () => {
    const dir = new URL('../ui/vendor/katex/', import.meta.url);
    for (const f of ['katex.mjs', 'katex.min.css', 'LICENSE', 'VERSION', 'fonts/KaTeX_Main-Regular.woff2']) assert.ok(existsSync(new URL(f, dir)), f);
    assert.equal(KATEX, 'vendor/katex/katex.mjs');
    const katex = (await import(new URL('katex.mjs', dir))).default;
    assert.match(readFileSync(new URL('VERSION', dir), 'utf8'), new RegExp(`KaTeX ${katex.version.replace(/\./g, '\\.')}`));
    assert.equal(MATH_OPTIONS.trust, false);
    for (const tex of ['\\href{javascript:alert(1)}{x}', '\\url{https://example.com}', '\\includegraphics{https://example.com/a.png}', '\\htmlClass{evil}{x}', '\\htmlStyle{background:url(https://example.com)}{y}', '\\htmlData{x=y}{z}', '\\text{<script>alert(1)</script><img src=x onerror=alert(1)>}']) {
        /* Its source is said once, as text, for a screen reader: what is drawn is what counts. */
        const html = katex.renderToString(tex, { ...MATH_OPTIONS }).replace(/<annotation[^>]*>[^<]*<\/annotation>/g, '');
        assert.doesNotMatch(html, /<a\b|href=|<img|<script|class="evil"|url\(|data-x/i, tex);
    }
    assert.throws(() => katex.renderToString('\\def\\a{\\a\\a}\\a', { ...MATH_OPTIONS }), /expansions/i, 'a macro bomb stops');
});

test('what KaTeX drew is copied through a list: spans, MathML and SVG kept; scripts, links, pictures, handlers and addresses left out', (t) => {
    t.after(fakePage());
    const node = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
    const drawn = node('span', { class: 'katex', onclick: 'alert(1)', style: 'height:1em;vertical-align:-0.25em' },
        node('math', { xmlns: 'http://www.w3.org/1998/Math/MathML' }, node('mi', { mathvariant: 'normal', href: 'javascript:alert(1)' }, 'x')),
        node('script', {}, 'alert(1)'), node('a', { href: 'https://example.com' }, 'link'), node('img', { src: 'https://example.com/a.png' }),
        node('span', { style: 'background:url(https://example.com/a.png)' }, 'y'),
        node('svg', { viewBox: '0 0 10 10', onload: 'alert(1)' }, node('path', { d: 'M0 0h10' }), node('foreignObject', {}, node('span', {}, 'z'))));
    const copy = mathCopy(drawn);
    const all = [copy, ...elements(copy)];
    assert.deepEqual(all.map((e) => e.tagName.toLowerCase()), ['span', 'math', 'mi', 'span', 'svg', 'path']);
    assert.equal(copy.getAttribute('class'), 'katex');
    assert.equal(copy.getAttribute('style'), 'height:1em;vertical-align:-0.25em');
    for (const e of all) for (const name of e.getAttributeNames()) assert.ok(!/^on|href|src/i.test(name), `${e.tagName} ${name}`);
    assert.equal(all[3].getAttribute('style'), null, 'a style with an address is left out');
    assert.equal(copy.textContent, 'xy', 'text stays text; what was left out took its text with it');
});

test('a Mermaid drawing is given the size of its viewBox, so that a picture of it is not 0 by 0', () => {
    assert.match(sized('<svg id="d" width="100%" style="max-width: 484.6px;" viewBox="0 0 484.64 514.57"><g/></svg>'), /^<svg width="485" height="515" id="d" style/);
    assert.equal(sized('<svg width="30" viewBox="0 0 5 5"></svg>'), '<svg width="30" viewBox="0 0 5 5"></svg>', 'a size of its own is kept');
    assert.equal(sized('<svg width="100%"></svg>'), '<svg width="100%"></svg>', 'no viewBox: as it was');
});

const pages = new WeakMap();
/* The screen, with one message of the agent; what it sends and opens, kept. */
async function shown(t, text, { kind = 'say', refs = [], targets, math = false } = {}) {
    /* One page per test, taken away after every chat on it. */
    if (!pages.has(t)) { const leave = fakePage(); pages.set(t, []); t.after(() => { for (const h of pages.get(t)) h.destroy(); leave(); }); }
    const root = document.createElement('div');
    document.body.append(root);
    const sent = []; const opened = [];
    const handle = mount(root, { load: async () => ({ messages: [{ from: 'agent', id: 'm', at: at(0), kind, text, refs, choices: kind === 'ask' ? ['Max', 'Leo'] : [] }] }), send: async (...a) => { sent.push(a); }, words: texts('en'), every: 0, touch: false,
        markdown: true, picture: (f) => `blob:${f.open}`, math, refs: targets ?? { label: (ref) => (ref.startsWith('app:') ? 'See the record' : null), open: (ref) => opened.push(ref) } });
    pages.get(t).push(handle);
    await settle(); await settle();
    return { root, sent, opened };
}

test('a family on the screen: SVG made node by node, names as text, a card on a tap, its ref opened by the application, "Talk about it" sent with it', async (t) => {
    const evil = '<img src=x onerror=alert&#40;1&#41;>';
    const { root, sent, opened } = await shown(t, `${F}family\n# Grandparents | Parents\n[Paul](app:people/1) (1925) + Anna, married in 1952\n  ${evil} (1954)\nPaul ~ Anna : friends\n${F}`);
    const fig = root.querySelector('.parley-family');
    assert.ok(fig, 'drawn');
    assert.equal(elements(root.querySelector('.parley-said')).filter((e) => ['IMG', 'SCRIPT', 'A', 'FOREIGNOBJECT'].includes(e.tagName)).length, 0, 'no markup from a name');
    assert.ok(fig.textContent.includes('<img src=x oner'), 'the name, as text (cut to its width)');
    assert.ok(fig.textContent.includes('Grandparents') && fig.textContent.includes('friends') && fig.textContent.includes('1952'));
    const paul = root.querySelectorAll('.parley-family-person').find((g) => g.getAttribute('aria-label') === 'Paul, 1925');
    paul.click();
    const card = root.querySelector('.parley-zone-card');
    assert.ok(card.textContent.startsWith('Paul'));
    assert.ok(card.textContent.includes('friends : Anna'), 'its other links said on its card');
    card.querySelectorAll('button').find((b) => b.textContent === 'See the record').click();
    assert.deepEqual(opened, ['app:people/1']);
    assert.equal(root.querySelector('.parley-zone-card'), null, 'its work done, the card closes');
    for (const e of elements(root)) for (const name of e.getAttributeNames()) assert.ok(!String(e.getAttribute(name)).includes('app:people/1'), 'a ref is shown nowhere');
    root.querySelectorAll('.parley-family-person').find((g) => g.getAttribute('aria-label') === 'Anna').click();
    assert.equal(root.querySelector('.parley-zone-card').querySelectorAll('button').map((b) => b.textContent).join('|'), 'Talk about it', 'no ref, no button for it');
    root.querySelector('.parley-zone-card').querySelector('button').click();
    await settle();
    assert.deepEqual(sent.at(-1), ["Let's talk about Anna.", undefined, undefined, { about: { label: 'Anna' } }]);
    const bad = await shown(t, `${F}family\nA + B + C\n${F}`);
    assert.ok(bad.root.querySelector('.parley-code'), 'a family it cannot read: shown as written');
});

test('zones on a picture: shown only from a path the application opens; a ? zone answered with its zone, a choice too', async (t) => {
    const text = `Who is on the right?\n${F}picture\n![Wedding](/work/w.jpg)\n[Anna](javascript:alert&#40;1&#41;) 0.2 0.3 0.18 0.36 the bride\n? 0.69 0.33 0.19 0.34\n${F}`;
    const { root, sent, opened } = await shown(t, text, { kind: 'ask', refs: [{ path: '/work/w.jpg', open: 'work:w.jpg' }], targets: { label: () => null, open: (r) => opened.push(r) } });
    assert.equal(root.querySelector('.parley-zoned').querySelector('img').src, 'blob:work:w.jpg');
    const zones = root.querySelectorAll('.parley-zone');
    assert.equal(zones.length, 2);
    assert.equal(zones[0].style.left, '20%');
    zones[0].click();
    assert.deepEqual(root.querySelector('.parley-zone-card').querySelectorAll('button').map((b) => b.textContent), ['Talk about it'], 'the application names no button for that ref: none');
    for (const e of elements(root)) for (const name of e.getAttributeNames()) assert.ok(!String(e.getAttribute(name)).includes('javascript'), 'a ref is no link');
    zones[1].click();
    const ask = root.querySelector('.parley-zone-card');
    assert.ok(ask.textContent.startsWith('What is it?'));
    ask.querySelector('button').click();
    assert.match(root.querySelector('.parley-replying').textContent, /What is it\?/);
    const box = root.querySelector('.parley-box'); box.value = 'My brother';
    root.querySelector('.parley-form').requestSubmit();
    await settle(); await settle();
    assert.deepEqual(sent.at(-1), ['My brother', 'm', undefined, { about: { label: '?', picture: '/work/w.jpg', box: [0.69, 0.33, 0.19, 0.34] } }]);
    root.querySelector('.parley-choices').querySelectorAll('button').find((b) => b.textContent === 'Max').click();
    await settle();
    assert.deepEqual(sent.at(-1), ['Max', 'm', undefined, { about: { label: '?', picture: '/work/w.jpg', box: [0.69, 0.33, 0.19, 0.34] } }], 'a choice goes back with the zone it is about');
    const off = await shown(t, text);
    assert.ok(off.root.querySelector('.parley-code') && !off.root.querySelector('.parley-zoned'), 'a picture the application does not open: the block as written');
});

test('a formula on the screen: its source until KaTeX draws it; with math: false, its source stays', async (t) => {
    const { root } = await shown(t, 'Area $\\pi r^2$.\n\n$$\nC_n = C_0\n$$');
    const shownMath = root.querySelectorAll('.parley-math');
    assert.deepEqual(shownMath.map((m) => [m.dataset.display, m.textContent]), [['false', '\\pi r^2'], ['true', 'C_n = C_0']]);
    assert.equal(shownMath[1].tagName, 'DIV');
});

test('what they tapped goes to the agent: kept by the host, bounded; parley read says it; the guide says when to use each', (t) => {
    const home = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, '.parley'); install(dir);
    const agent = bridge(dir);
    agent.ask('Who is on the right?', ['Max', 'Leo']);
    const parley = new Parley(dir);
    const id = parley.read().messages[0].id;
    parley.say('Max', id, [], { about: { label: '?', picture: '/work/w.jpg', box: [0.69, 0.33, 0.19, 0.34] } });
    parley.say("Let's talk about Anna.", undefined, [], { about: { label: 'Anna', ref: 'app:people/12' } });
    const mine = parley.read().messages.filter((m) => m.from === 'person');
    assert.deepEqual(mine.map((m) => m.about), [{ label: '?', picture: '/work/w.jpg', box: [0.69, 0.33, 0.19, 0.34] }, { label: 'Anna', ref: 'app:people/12' }]);
    const said = agent.read();
    assert.match(said, /Answer to your question "Who is on the right\?": Max \(about "\?", the zone 0\.69 0\.33 0\.19 0\.34 of \/work\/w\.jpg\)/);
    assert.match(said, /Message: Let's talk about Anna\. \(about "Anna" \[app:people\/12\]\)/);
    assert.equal(aboutOf({ label: '' }), undefined, 'no label, nothing');
    assert.deepEqual(aboutOf({ label: 'x\u202e', picture: 'relative.jpg', box: [0, 0, 2, 1], ref: 'a\nb' }), { label: 'x', ref: 'a b' }, 'cleaned: a relative picture, a zone out of it, left out');
    assert.match(RICH, /never as decoration/);
    assert.match(RICH, /```family/); assert.match(RICH, /```picture/);
    assert.match(run(['--help'], { cwd: home, env: {} }).out, /```picture/);
    assert.match(run(['guide'], { cwd: home, env: {} }).out, /only when\s+the topic calls for it/);
});
