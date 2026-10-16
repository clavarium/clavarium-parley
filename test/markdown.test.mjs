import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakePage } from './fake-dom.mjs';
import { mount, markdown, inline, safeLink, plainOf, view } from '../ui/parley-ui.js';
import { texts, cited } from '../host/parley-host.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('../ui/parley-ui.js', import.meta.url)), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();

/* Every element under a node, depth first. */
const elements = (node) => node.children.flatMap((c) => [c, ...elements(c)]);
const pages = new WeakMap();
/* Mounts the screen on a fake page with one message of the agent. */
async function shown(t, text, { refs = [], picture, diagram, highlight, short, open = () => {}, after = false } = {}) {
    /* One page per test, taken away after every chat on it. */
    if (!pages.has(t)) { const leave = fakePage(); pages.set(t, []); t.after(() => { for (const h of pages.get(t)) h.destroy(); leave(); }); }
    const root = document.createElement('div');
    document.body.append(root);
    const opened = [];
    /* `after`: a later message of the agent, so that this one is not the newest (the newest is never folded). */
    const handle = mount(root, { load: async () => ({ messages: [{ from: 'agent', id: 'm', at: at(0), kind: 'say', text, refs, ...(short ? { short } : {}) }, ...(after ? [{ from: 'agent', id: 'n', at: at(1), kind: 'say', text: 'Next.' }] : [])] }), send: async () => {}, words: texts('en'), every: 0, touch: false,
        markdown: true, picture, diagram, highlight, open: (f) => { opened.push(f); open(f); } });
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
    const ok = await shown(t, '```mermaid\npie title Disk\n"snaps" : 1.5\n```', { diagram: async () => '<svg xmlns="http://www.w3.org/2000/svg"><text>pie</text></svg>' });
    await settle();
    const img = ok.said.querySelector('img');
    assert.equal(img.src, 'blob:test/1'); assert.deepEqual(urls, ['image/svg+xml']);
    const bad = await shown(t, '```mermaid\ngraph TD\nA-->B\nclick A "javascript:alert(1)"\n```', { diagram: async () => { throw new Error('no'); } });
    await settle();
    assert.equal(bad.said.querySelector('img'), null);
    assert.match(bad.said.querySelector('pre').textContent, /click A/, 'its code, as text');
    const notSvg = await shown(t, '```mermaid\nx\n```', { diagram: async () => '<script>alert(1)</script>' });
    await settle();
    assert.equal(notSvg.said.querySelector('img'), null, 'what is not a drawing is not shown as one');
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
