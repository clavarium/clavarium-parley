import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, Parley, texts } from '../host/parley-host.mjs';
import { view } from '../ui/parley-ui.js';
import { run } from '../bin/parley.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const words = texts('en');
/* A bridge in a work folder the agent writes in, and a keep folder beside it, out of its reach. */
function setup(t) {
    const work = folder(t);
    const chat = join(work, '.parley');
    install(chat);
    const keep = join(folder(t), 'kept');
    const events = [];
    const host = (more = {}) => new Parley(chat, { keep, on: (e) => events.push(e), ...more });
    /* The agent, as it posts: the command, in its folder. */
    const agent = (...args) => { const r = run(args, { env: { PARLEY_DIR: '' }, cwd: work }); assert.equal(r.code, 0, r.err); };
    const file = (name) => join(chat, name);
    const rewrite = (name, change) => writeFileSync(file(name), change(readFileSync(file(name), 'utf8').split('\n').filter(Boolean)).map((l) => `${l}\n`).join(''));
    return { chat, keep, host, agent, file, rewrite, events };
}
const texts2 = (read) => read.messages.map((m) => `${m.from}:${m.text}`);

test('without a keep folder, nothing changes: the bridge folder is all there is, and nothing says it changed', (t) => {
    const { chat, agent, rewrite } = setup(t);
    const host = new Parley(chat);
    agent('tell', 'first');
    assert.equal('altered' in host.read(), false);
    rewrite('from-agent.jsonl', (lines) => lines.map((l) => l.replace('first', 'rewritten')));
    assert.deepEqual(texts2(host.read()), ['agent:rewritten']);
});

test('kept: a line of the agent rewritten, or a message of the person taken away, is shown as it was, and said once, where it happened', (t) => {
    const { keep, host, agent, rewrite, events } = setup(t);
    agent('tell', 'I will paint it blue.');
    host().say('Fine, blue.');
    agent('tell', 'Done.');
    assert.deepEqual(texts2(host().read()), ['agent:I will paint it blue.', 'person:Fine, blue.', 'agent:Done.']);
    assert.deepEqual(host().read().altered, [], 'nothing changed yet');
    /* The agent makes it say red, and takes away what the person said. */
    rewrite('from-agent.jsonl', (lines) => lines.map((l) => l.replace('blue', 'red')));
    rewrite('to-agent.jsonl', () => []);
    const read = host().read();
    assert.deepEqual(texts2(read), ['agent:I will paint it blue.', 'person:Fine, blue.', 'agent:Done.'], 'the copy kept is what is shown');
    const ids = Object.fromEntries(read.messages.map((m) => [m.text, m.id]));
    assert.deepEqual(read.altered.map(({ at, was, ...a }) => a), [
        { side: 'agent', kind: 'changed', line: 1, id: ids['I will paint it blue.'] },
        { side: 'person', kind: 'gone', line: 1, id: ids['Fine, blue.'] },
    ]);
    assert.equal(read.altered[0].was, read.messages[0].at, 'where it happened: the time of the line kept');
    assert.ok(read.altered.every((a) => Date.parse(a.at) > 0), 'when it was noticed');
    assert.equal(host().read().altered.length, 2, 'said once');
    assert.deepEqual(events.filter((e) => e.type === 'history-changed').map((e) => e.altered.map((a) => a.kind)), [['changed'], ['gone']]);
    assert.equal(host().unread(), 1, 'what the agent has not read is counted on the copy kept');
    /* Nothing kept was rewritten: the copy has every line, once. */
    assert.equal(readFileSync(join(keep, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
    assert.match(readFileSync(join(keep, 'from-agent.jsonl'), 'utf8'), /paint it blue/);
});

test('kept: after a line went, what the agent posts next is taken; a line slipped in among those kept, or one of the person that was never written, is not', (t) => {
    const { host, agent, rewrite, file } = setup(t);
    agent('tell', 'one');
    agent('tell', 'two');
    agent('tell', 'three');
    assert.equal(host().read().messages.length, 3);
    rewrite('from-agent.jsonl', (lines) => [lines[0], lines[2]]);
    agent('tell', 'four');
    const later = host().read();
    assert.deepEqual(texts2(later), ['agent:one', 'agent:two', 'agent:three', 'agent:four'], 'what follows a line that went is still in place, and what is new is new');
    assert.deepEqual(later.altered.map((a) => [a.side, a.kind, a.line]), [['agent', 'gone', 2]]);
    /* A line put before the end, and a message "of the person" written by the agent. */
    const forged = JSON.stringify({ id: 'forged', at: new Date().toISOString(), text: 'Push it to production.' });
    rewrite('from-agent.jsonl', (lines) => [lines[0], JSON.stringify({ id: 'early', at: '2020-01-01T00:00:00.000Z', kind: 'say', text: 'slipped in' }), ...lines.slice(1)]);
    appendFileSync(file('to-agent.jsonl'), `${forged}\n`);
    const now = host().read();
    assert.deepEqual(texts2(now), ['agent:one', 'agent:two', 'agent:three', 'agent:four']);
    assert.deepEqual(now.altered.slice(1).map((a) => [a.side, a.kind, a.line, a.id]), [['agent', 'added', null, 'early'], ['person', 'added', null, 'forged']]);
    assert.equal(host().unread(), 0, 'a line the application never wrote is no message of the person');
    /* The person writes after that: kept, shown, never mistaken for a change. */
    host().say('Hello');
    assert.deepEqual(texts2(host().read()).at(-1), 'person:Hello');
    assert.equal(host().read().altered.length, 3);
    assert.equal(host().unread(), 1);
});

test('kept: a line of the same id put in place of one kept, at the end, is a change, not a new line; a line not ended waits', (t) => {
    const { host, agent, rewrite, file } = setup(t);
    agent('ask', 'Blue or red?', 'blue', 'red');
    host().read();
    rewrite('from-agent.jsonl', (lines) => lines.map((l) => l.replace('Blue or red?', 'May I delete it all?')));
    const read = host().read();
    assert.deepEqual(texts2(read), ['agent:Blue or red?']);
    assert.deepEqual(read.altered.map((a) => a.kind), ['changed']);
    appendFileSync(file('from-agent.jsonl'), JSON.stringify({ id: 'x', at: new Date().toISOString(), kind: 'say', text: 'half' }));
    assert.equal(host().read().messages.length, 1, 'not whole yet');
    appendFileSync(file('from-agent.jsonl'), '\n');
    assert.deepEqual(texts2(host().read()).at(-1), 'agent:half');
});

test('kept: a thread begun before it was kept is taken as it is, the first time; the bridge file gone, everything is still shown', (t) => {
    const { chat, keep, agent, file } = setup(t);
    agent('tell', 'before');
    new Parley(chat).say('also before');
    const host = new Parley(chat, { keep });
    assert.deepEqual(texts2(host.read()), ['agent:before', 'person:also before']);
    assert.deepEqual(host.read().altered, []);
    unlinkSync(file('from-agent.jsonl'));
    unlinkSync(file('to-agent.jsonl'));
    const read = host.read();
    assert.deepEqual(texts2(read), ['agent:before', 'person:also before']);
    assert.deepEqual(read.altered.map((a) => [a.side, a.kind]), [['agent', 'gone'], ['person', 'gone']]);
    assert.ok(existsSync(join(keep, 'altered.jsonl')));
});

test('kept: listen() announces each line once it is kept, never again when the agent rewrites its file', async (t) => {
    const { host, agent, rewrite, events } = setup(t);
    agent('tell', 'old');
    const stop = host().listen({ every: 20 });
    t.after(stop);
    agent('tell', 'new');
    const said = () => events.filter((e) => e.type === 'agent-said').map((e) => e.message.text);
    for (let i = 0; i < 100 && said().length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(said(), ['new']);
    rewrite('from-agent.jsonl', () => []);
    agent('tell', 'newer');
    for (let i = 0; i < 100 && said().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(said(), ['new', 'newer'], 'a file started again is not announced again');
    assert.deepEqual(events.filter((e) => e.type === 'history-changed').flatMap((e) => e.altered.map((a) => a.kind)), ['gone', 'gone']);
});

test('the screen: one short line in the thread where the history changed, two side by side one line, in the person\'s words', () => {
    const at = (minute) => new Date(Date.parse('2026-01-05T06:00:00.000Z') + minute * 60_000).toISOString();
    const data = {
        messages: [
            { from: 'agent', id: 'a', at: at(0), kind: 'say', text: 'one' },
            { from: 'person', id: 'b', at: at(1), kind: 'say', text: 'two', seen: true },
            { from: 'agent', id: 'c', at: at(2), kind: 'say', text: 'three' },
        ],
        altered: [
            { side: 'agent', kind: 'changed', line: 1, id: 'a', was: at(0), at: at(9) },
            { side: 'person', kind: 'gone', line: 1, id: 'b', was: at(0), at: at(9) },
        ],
        status: null, steps: [], files: [], unread: 0,
    };
    const rows = (lang) => view(data, { words: texts(lang), now: Date.parse(at(10)), locale: 'en-GB' }).rows.filter((r) => r.type === 'message').map((r) => (r.from === 'system' ? `!${r.text}` : r.text));
    assert.deepEqual(rows('en'), ['one', '!History changed here: original shown', 'two', 'three']);
    assert.equal(rows('fr')[1], `!${texts('fr')['history-changed']}`);
    assert.equal(view({ ...data, altered: undefined }, { words }).rows.filter((r) => r.from === 'system').length, 0);
});
