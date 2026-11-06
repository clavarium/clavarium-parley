import { test } from 'node:test';
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { fakePage } from './fake-dom.mjs';
import { mount, chartOf, numberOf, mermaidChart, cardsOf, niceTicks, KEYS, CHART_TYPES } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';
import { TOOLS, CHARTS } from '../server/parley-mcp.mjs';
import { run } from '../bin/parley.mjs';

const F = '```';
const settle = () => new Promise((r) => setTimeout(r, 5));
const elements = (node) => (node.children ?? []).flatMap((c) => [c, ...elements(c)]);

test('numbers as people write them; anything else is not one', () => {
    for (const [text, n] of [['5.7', 5.7], ['5,7', 5.7], ['1 234', 1234], ['1,234', 1234], ['1,234.5', 1234.5], ['-3', -3], ['−3', -3], ['12 %', 12], ['0,125', 0.125], ['.5', 0.5]]) assert.equal(numberOf(text), n, text);
    assert.equal(numberOf('22 Go', 'Go'), 22, 'its unit after it');
    for (const bad of ['abc', '', '1.2.3', '12 apples', '1e5', 'NaN', '--1']) assert.equal(numberOf(bad), null, bad);
});

test('a chart: keys, then one series as "Label: value", or several as a table; its first row the labels', () => {
    const one = chartOf('type: bar\ntitle: What takes the room\nunit: GB\ndata:\n  Test disk: 22\n  System: 5,7 GB\n  - Logs: 1 234\n  10:00: 3');
    assert.deepEqual([one.type, one.title, one.unit], ['bar', 'What takes the room', 'GB']);
    assert.deepEqual(one.labels, ['Test disk', 'System', 'Logs', '10:00'], 'a colon in a label: the last one splits');
    assert.deepEqual(one.series, [{ name: 'What takes the room', values: [22, 5.7, 1234, 3] }]);
    const many = chartOf('type: line\nx: Day\n| Mon | Tue | Wed |\n|---|---|---|\n| Visits | 12 | 15 | 9 |\nSales | 3 | 4 | 5');
    assert.deepEqual(many.labels, ['Mon', 'Tue', 'Wed']);
    assert.deepEqual(many.series.map((s) => [s.name, s.values]), [['Visits', [12, 15, 9]], ['Sales', [3, 4, 5]]]);
    assert.deepEqual(chartOf('type: stacked\nDay | Mon | Tue\nA | 1 | 2').labels, ['Mon', 'Tue'], 'a corner cell names nothing drawn');
    assert.equal(chartOf('A: 1\nB: 2').type, 'bar', 'no type: bars');
    assert.deepEqual(CHART_TYPES, ['bar', 'line', 'pie', 'donut', 'stacked']);
});

test('a chart it cannot read is null (shown as written)', () => {
    for (const [bad, why] of [
        ['', 'empty'], ['type: radar\nA: 1', 'an unknown type'], ['type: bar\nA: abc', 'not a number'], ['type: bar\njust words', 'no value'],
        ['type: line\nA: 1', 'a line of one point'], ['type: pie\nA: 3\nB: -1', 'a negative slice'], ['type: pie\nA: 0\nB: 0', 'nothing to share'],
        ['type: stacked\n| a | b\nX | 1 | -2', 'a negative in a stack'], ['| a | b | c\nX | 1 | 2\nY | 1 | 2 | 3', 'rows of different lengths'],
        ['| a | b\nX | 1 | 2 | 3 | 4', 'more values than labels'], ['type: pie\n| a | b\nX | 1 | 2\nY | 1 | 2', 'a pie of two series'],
        ['data: 3\nA: 1', 'data with a value'], ['type: bar', 'no numbers'],
        [`| ${Array.from({ length: 61 }, (_, k) => k).join(' | ')}\nX | ${Array.from({ length: 61 }, () => 1).join(' | ')}`, 'too many points'],
        [`| a\n${Array.from({ length: 7 }, (_, k) => `S${k} | 1`).join('\n')}`, 'too many series'],
    ]) assert.equal(chartOf(bad), null, why);
});

test('a pie of more slices than colours: the smallest together are "Other"', () => {
    const c = chartOf(`type: pie\n${Array.from({ length: 9 }, (_, k) => `S${k}: ${k + 1}`).join('\n')}`);
    assert.equal(c.labels.length, 7);
    assert.equal(c.other, true);
    assert.equal(c.labels.at(-1), '');
    assert.equal(c.series[0].values.at(-1), 1 + 2 + 3, 'the three smallest');
    assert.equal(c.series[0].values.reduce((a, b) => a + b, 0), 45, 'nothing lost');
});

test('round steps for an axis', () => {
    assert.deepEqual(niceTicks(0, 22.3, 5), [0, 5, 10, 15, 20, 25]);
    assert.deepEqual(niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(niceTicks(-3, 7, 5), [-4, -2, 0, 2, 4, 6, 8]);
    assert.ok(niceTicks(5, 5, 4).length >= 2, 'one value still has an axis');
});

test('a Mermaid pie or xychart is read as a chart; anything else of Mermaid is not', () => {
    const pie = mermaidChart('pie showData title Pets\n  "Dogs" : 386\n  "Cats" : 85.5');
    assert.deepEqual([pie.type, pie.title, pie.labels, pie.series[0].values], ['donut', 'Pets', ['Dogs', 'Cats'], [386, 85.5]]);
    const xy = mermaidChart('xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar]\n  y-axis "Revenue" 0 --> 100\n  bar [50, 60, 75]\n  line [40, 65, 70]');
    assert.deepEqual([xy.type, xy.title, xy.y, xy.labels, xy.series.length], ['line', 'Sales', 'Revenue', ['jan', 'feb', 'mar'], 2]);
    assert.equal(mermaidChart('xychart-beta\n  x-axis [a, b]\n  bar [1, 2]').type, 'bar');
    assert.equal(mermaidChart('flowchart LR\n  A --> B'), null);
    assert.equal(mermaidChart('pie\n  "A" : x'), null, 'a slice it cannot read');
    assert.equal(mermaidChart('xychart-beta\n  x-axis 0 --> 10\n  line [1, 2]'), null, 'a numeric axis: left to Mermaid');
});

test('result cards: "Title | value | state | note", a heading; a line it cannot read gives up', () => {
    const set = cardsOf('# Results\n- Tests | 841/841 | ok\n- Beta | 0.2.154 | [OK]\n- Box | 0.1.51 | warn | power cut\n* Disk | 92 % | almost full\nPlain | 3 | | a note');
    assert.equal(set.heading, 'Results');
    assert.deepEqual(set.cards.map((c) => [c.title, c.value, c.state, c.note]), [
        ['Tests', '841/841', 'ok', ''], ['Beta', '0.2.154', 'ok', ''], ['Box', '0.1.51', 'warn', 'power cut'], ['Disk', '92 %', '', 'almost full'], ['Plain', '3', '', 'a note'],
    ]);
    assert.equal(cardsOf('- Tests 841'), null, 'no |');
    assert.equal(cardsOf('- | 3 | ok'), null, 'no title');
    assert.equal(cardsOf('- Tests | | ok'), null, 'no value');
    assert.equal(cardsOf(''), null);
    assert.equal(cardsOf(Array.from({ length: 13 }, (_, k) => `C${k} | ${k}`).join('\n')), null, 'too many');
});

const pages = new WeakMap();
async function shown(t, text, more = {}) {
    if (!pages.has(t)) { const leave = fakePage(); pages.set(t, []); t.after(() => { for (const h of pages.get(t)) h.destroy(); leave(); }); }
    const root = document.createElement('div');
    document.body.append(root);
    const handle = mount(root, { load: async () => ({ messages: [{ from: 'agent', id: 'm', at: new Date(Date.UTC(2030, 0, 1)).toISOString(), kind: 'say', text, refs: [], choices: [] }] }), send: async () => {}, words: texts('en'), every: 0, touch: false, markdown: true, locale: 'en-US', ...more });
    pages.get(t).push(handle);
    await settle(); await settle();
    return root;
}

test('a chart on the screen: SVG made node by node, a summary to hear, a value on a tap, the numbers as a table', async (t) => {
    const evil = '<img src=x onerror=alert(1)>';
    const root = await shown(t, `${F}chart\ntype: bar\ntitle: Disk\nunit: GB\ndata:\n  ${evil}: 22\n  System: 5.7\n${F}`);
    const fig = root.querySelector('.parley-chart');
    assert.equal(fig.dataset.type, 'bar');
    assert.equal(elements(root.querySelector('.parley-said')).filter((e) => ['IMG', 'SCRIPT', 'A', 'FOREIGNOBJECT'].includes(e.tagName)).length, 0, 'no markup from a label');
    const svg = fig.querySelector('svg');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.match(svg.getAttribute('aria-label'), /^Disk: .*22 GB, System 5\.7 GB$/);
    assert.equal(fig.querySelectorAll('.parley-chart-mark').length, 2);
    assert.deepEqual(fig.querySelectorAll('.parley-chart-mark').map((m) => m.dataset.s), ['1', '1'], 'one series, one colour');
    assert.equal(fig.querySelector('.parley-chart-legend'), null, 'one series: no legend, its title says it');
    assert.ok(fig.querySelector('.parley-chart-title').textContent.startsWith('Disk'));
    const tip = fig.querySelector('.parley-chart-tip');
    assert.equal(tip.hidden, true);
    fig.querySelectorAll('.parley-chart-hit')[1].click();
    assert.equal(tip.hidden, false);
    assert.equal(tip.textContent, 'System5.7 GB');
    assert.equal(fig.dataset.focus, 'true');
    assert.equal(fig.querySelectorAll('.parley-chart-mark')[1].getAttribute('data-on'), 'true', 'the one tapped stands out');
    fig.querySelectorAll('.parley-chart-hit')[1].click();
    assert.equal(tip.hidden, true, 'tapped again: gone');
    const stage = fig.querySelector('.parley-chart-stage');
    stage.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
    assert.ok(!tip.hidden && tip.textContent.includes('22'), 'the arrow keys go through the values');
    const toggle = fig.querySelector('.parley-chart-toggle');
    const table = fig.querySelector('.parley-chart-table');
    assert.equal(table.hidden, true);
    toggle.click();
    assert.deepEqual([table.hidden, stage.hidden, toggle.getAttribute('aria-pressed'), toggle.textContent], [false, true, 'true', 'Chart']);
    assert.deepEqual(table.querySelectorAll('td').map((td) => td.textContent), [evil, '22 GB', 'System', '5.7 GB']);
    toggle.click();
    assert.deepEqual([table.hidden, stage.hidden, toggle.textContent], [true, false, 'Table']);
});

test('several series: a colour each in order, a legend; a line, a crosshair; a stack, its total', async (t) => {
    const line = (await shown(t, `${F}chart\ntype: line\n| Mon | Tue | Wed\nVisits | 12 | 15 | 9\nSales | 3 | 4 | 5\n${F}`)).querySelector('.parley-chart');
    assert.deepEqual(line.querySelectorAll('.parley-chart-line').map((l) => l.dataset.s), ['1', '2']);
    assert.deepEqual(line.querySelector('.parley-chart-legend').querySelectorAll('li').map((li) => li.textContent), ['Visits', 'Sales']);
    assert.equal(line.querySelectorAll('.parley-chart-dot').length, 6);
    line.querySelectorAll('.parley-chart-hit')[1].click();
    assert.equal(line.querySelector('.parley-chart-tip').textContent, 'TueVisits15Sales4');
    assert.equal(line.querySelector('.parley-chart-cross').getAttribute('visibility'), 'visible');
    const stack = (await shown(t, `${F}chart\ntype: stacked\nunit: min\n| Lot 1 | Lot 2\nTests | 4 | 6\nBeta | 2 | 0\n${F}`)).querySelector('.parley-chart');
    assert.equal(stack.querySelectorAll('.parley-chart-mark').length, 3, 'a zero takes no room');
    stack.querySelectorAll('.parley-chart-hit')[0].click();
    assert.equal(stack.querySelector('.parley-chart-tip').textContent, 'Lot 1Tests4 minBeta2 minTotal6 min');
    assert.ok(stack.querySelectorAll('.parley-chart-value').some((v) => v.textContent === '6 min'), 'its total at its end');
});

test('a pie: its slices, a legend with each value and share, "Other" grey; a Mermaid pie drawn the same way', async (t) => {
    const root = await shown(t, `${F}chart\ntype: donut\ntitle: Disk\ndata:\n${Array.from({ length: 8 }, (_, k) => `S${k}: ${8 - k}`).join('\n')}\n${F}`);
    const fig = root.querySelector('.parley-chart');
    assert.deepEqual(fig.querySelectorAll('.parley-chart-slice').map((s) => s.dataset.s), ['1', '2', '3', '4', '5', '6', '0']);
    const rows = fig.querySelector('.parley-chart-legend').querySelectorAll('li');
    assert.equal(rows.at(-1).textContent, 'Other38.3\u202f%', 'the two smallest, together');
    assert.ok(fig.textContent.includes('36') && fig.textContent.includes('Total'), 'its total in the middle');
    rows[0].click();
    assert.equal(fig.querySelector('.parley-chart-tip').textContent, 'S08 · 22\u202f%');
    const m = (await shown(t, `${F}mermaid\npie title Pets\n  "Dogs" : 3\n  "Cats" : 1\n${F}`)).querySelector('.parley-chart');
    assert.equal(m.dataset.type, 'donut');
    assert.equal(m.querySelectorAll('.parley-chart-slice').length, 2);
});

test('a block it cannot read, and a Mermaid drawing that is no chart, are not charts', async (t) => {
    const bad = await shown(t, `${F}chart\ntype: bar\ndata:\n  Not a number: abc\n${F}`);
    assert.ok(bad.querySelector('.parley-code') && !bad.querySelector('.parley-chart'), 'shown as written');
    assert.match(bad.querySelector('.parley-code').textContent, /Not a number: abc/);
    const flow = await shown(t, `${F}mermaid\nflowchart LR\n  A --> B\n${F}`);
    assert.ok(!flow.querySelector('.parley-chart') && flow.querySelector('.parley-code'), 'no diagram slot: code, as before');
    const badCards = await shown(t, `${F}cards\njust a line\n${F}`);
    assert.ok(badCards.querySelector('.parley-code') && !badCards.querySelector('.parley-cards'));
});

test('result cards on the screen: a grid, each its value, title, state badge and note', async (t) => {
    const root = await shown(t, `${F}cards\n# Results\n- Tests | 841/841 | ok\n- Box | 0.1.51 | warn | power cut\n- <b>x</b> | 3\n${F}`);
    const box = root.querySelector('.parley-cards');
    assert.equal(box.querySelector('.parley-cards-head').textContent, 'Results');
    const cards = box.querySelectorAll('.parley-result');
    assert.deepEqual(cards.map((c) => c.dataset.state ?? ''), ['ok', 'warn', '']);
    assert.deepEqual(cards.map((c) => c.querySelector('.parley-result-value').textContent), ['841/841', '0.1.51', '3']);
    assert.deepEqual(cards.map((c) => c.querySelector('.parley-result-title').textContent), ['Tests', 'Box', '<b>x</b>'], 'a title, as text');
    assert.equal(cards[1].querySelector('.parley-badge').dataset.kind, 'warn');
    assert.equal(cards[1].querySelector('.parley-result-note').textContent, 'power cut');
    assert.equal(cards[2].querySelector('.parley-badge'), null);
    assert.ok(cards.every((c) => !c.querySelector('.parley-result-long')), 'a short value keeps its large size');
    const long = await shown(t, `${F}cards\n- Key | reads, talks, 403 elsewhere | ok\n${F}`);
    assert.ok(long.querySelector('.parley-result-value.parley-result-long'), 'a long value is set smaller, whole (06-11)');
    assert.equal(elements(box).filter((e) => e.tagName === 'B').length, 0);
});

test('the words of charts are in both dictionaries; the agent is told how to write both blocks', () => {
    for (const key of ['chart', 'chart-table', 'chart-show', 'chart-other', 'chart-total']) { assert.ok(KEYS.includes(key), key); assert.ok(texts('fr')[key], key); }
    for (const name of ['tell', 'ask']) { const d = TOOLS.find((x) => x.name === name).description; assert.ok(d.includes(CHARTS), name); }
    assert.match(CHARTS, /```chart/); assert.match(CHARTS, /```cards/); assert.match(CHARTS, /type: bar\|line\|pie\|donut\|stacked/);
    assert.match(run(['--help'], { cwd: '/', env: {} }).out, /```cards/);
    assert.match(run(['guide'], { cwd: '/', env: {} }).out, /```chart/);
});
