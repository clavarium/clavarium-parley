/* ONE LINE PER PROBLEM of the machine (03-11): the lines of one problem, however far apart, are one line in the
   simple view, where it began; it says how many times, then that it is fixed; an hour after, it is gone. The
   detailed view keeps every line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { view } from '../ui/parley-ui.js';

const at = (min) => new Date(Date.UTC(2026, 10, 3, 18, min)).toISOString();
const sys = (id, min, text, extra = {}) => ({ from: 'system', id, at: at(min), text, topic: 'Machine', level: 'needs-you', tone: 'warn', ...extra });
const data = { messages: [
    { from: 'person', id: 'p1', at: at(48), text: 'Regarde mes mails.' },
    sys('s1', 49, 'Its tool was stopped: the machine ran out of memory (2.9 GB).', { brief: 'Out of memory', actions: [{ id: 'memory', label: 'More memory' }, { id: 'restart', label: 'Restart…' }] }),
    sys('s2', 49, 'The whole machine ran out of memory since it started.', { brief: 'Out of memory', actions: [{ id: 'restart', label: 'Restart…' }] }),
    sys('s3', 51, 'Said to its agent: free some room.'),
    { from: 'agent', id: 'a1', at: at(52), kind: 'say', text: 'Nettoyage fait.' },
    sys('s4', 56, 'Its tool was stopped: the machine ran out of memory (2.9 GB).', { brief: 'Out of memory', actions: [{ id: 'memory', label: 'More memory' }] }),
] };
const issues = (v) => v.rows.filter((r) => r.type === "issue");

test('the lines of one problem are one line where it began, with how many times and its one button', () => {
    const v = view(data, { words: {}, now: Date.parse(at(57)) });
    const [one] = issues(v);
    assert.equal(issues(v).length, 1);
    assert.equal(one.lines.length, 4, 'all four lines under it');
    assert.match(one.text, /Out of memory ×3/, 'three problems; what was said to its agent is not one');
    assert.equal(one.main.id, 'memory', 'the first button of the last problem');
    const order = v.rows.map((r) => r.type === 'issue' ? 'issue' : r.from).filter((x) => x === 'issue' || x === 'agent' || x === 'person');
    assert.deepEqual(order.slice(0, 3), ['person', 'issue', 'agent'], 'where it began');
    assert.equal(v.rows.filter((r) => r.from === "system").length, 0, 'no line of it left on its own');
});

test('fixed: said so, no button; an hour after, gone from the simple view; the detailed view keeps all', () => {
    const fixed = { messages: [...data.messages, { from: 'system', id: 's5', at: at(59), text: 'What was wrong with its machine is gone.', topic: 'Machine', level: 'news', brief: 'Fixed' }] };
    const v = view(fixed, { words: { 'issue-fixed': '{what}: fixed' }, now: Date.parse(at(59)) + 60_000 });
    const [one] = issues(v);
    assert.equal(one.text, 'Out of memory: fixed'); assert.equal(one.main, null); assert.ok(one.fixed);
    assert.equal(issues(view(fixed, { words: {}, now: Date.parse(at(59)) + 2 * 3600_000 })).length, 0, 'an hour after: gone');
    const detailed = view(fixed, { words: {}, view: 'detailed', now: Date.parse(at(59)) + 60_000 });
    assert.equal(issues(detailed).length, 0);
    assert.equal(detailed.rows.filter((r) => r.from === 'system').length, 5, 'every line in the detailed view');
});
