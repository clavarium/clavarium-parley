/* THE ARCHIVE: a thread split into volumes by the host, never cut. Proved here: what is read of a
   thread split is what is read of the same lines never split -- each part of it, on both sides
   (the host's read and search, the agent's `parley read`); no line is lost or read twice when the
   agent writes while the files are renamed; a cursor and the count of what the agent read stay
   valid; and a thread of 50,000 lines split is read from its end without reading its volumes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, cpSync, existsSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { install, Parley, ARCHIVE_STATS, splitOf, SPLIT } from '../host/parley-host.mjs';
import { bridge } from '../server/parley-mcp.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-archive-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
function numbers(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const T0 = Date.parse('2026-01-01T08:00:00.000Z');
const STEP_MS = 7000;
const atOf = (k) => new Date(T0 + k * STEP_MS).toISOString();
const WORDS = 'the build of the page went through and the tests passed before the change to the list of files was written'.split(' ');

/* A thread as both sides write it, in time order: steps, messages, questions (most answered),
   files, reactions, pins, closes. `marks`: a word only some messages hold, to search for. */
function lines(n, { seed = 1, step = 1 } = {}) {
    const r = numbers(seed);
    const words = (k) => Array.from({ length: k }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    const agent = [], person = [], asks = [], said = [], waits = [];
    for (let k = 0; k < n; k += 1) {
        /* Ids that differ in their first characters, as the agent's `read` shows them. */
        const at = atOf(k * step), id = `${(Math.imul(k + 1, 2654435761) >>> 0).toString(16).padStart(8, '0')}-${seed}-${k}`;
        const x = r();
        if (x < 0.4) agent.push({ id, at, kind: 'doing', text: `Doing ${words(8)}` });
        else if (x < 0.5) agent.push({ id, at, kind: 'status', state: ['working', 'waiting', 'done'][Math.floor(r() * 3)], text: words(6) });
        else if (x < 0.62) { agent.push({ id, at, kind: 'say', text: `${words(20)}${k % 97 === 0 ? ' zebracorn' : ''} see /work/out/report-${k % 400}.html`, short: words(5) }); said.push(id); }
        else if (x < 0.66) { agent.push({ id, at, kind: 'ask', text: words(12), choices: ['Yes', 'No'] }); asks.push(id); waits.push(id); }
        else if (x < 0.68) agent.push({ id, at, kind: 'show', path: `/work/out/chart-${k % 300}.png`, text: words(4) });
        else if (x < 0.685 && asks.length) agent.push({ id, at, kind: 'close', answers: asks[Math.floor(r() * asks.length)], text: 'Answered in the chat' });
        /* Pins are put on messages on the screen: among the newest. */
        else if (x < 0.69 && said.length) agent.push({ id, at, kind: 'pin', pin: said.at(-1 - Math.floor(r() * Math.min(30, said.length))), text: '', ...(r() < 0.3 ? { removed: true } : {}) });
        else if (x < 0.9) {
            const line = { id, at, text: `${words(12)}${k % 89 === 0 ? ' zebracorn' : ''}` };
            if (r() < 0.3 && waits.length > 2) Object.assign(line, { answers: waits.shift(), question: 'A question' });
            person.push(line);
        } else if (x < 0.97 && said.length) person.push({ id, at, text: '', to: said[Math.floor(r() * said.length)], quote: 'q', toAt: at, reaction: ['agree', 'go', 'love'][Math.floor(r() * 3)] });
        else if (said.length) person.push({ id, at, text: '', pin: said.at(-1 - Math.floor(r() * Math.min(30, said.length))), quote: 'q', toAt: at, ...(r() < 0.3 ? { removed: true } : {}) });
        else agent.push({ id, at, kind: 'doing', text: words(4) });
    }
    return { agent, person };
}
const jsonl = (list) => list.map((l) => `${JSON.stringify(l)}\n`).join('');
/* The same lines in a bridge folder, with the split given (false: never). */
function thread(t, n, { seed = 1, split, step, keep = false } = {}) {
    const work = folder(t);
    const dir = join(work, '.parley');
    install(dir);
    const { agent, person } = lines(n, { seed, step });
    writeFileSync(join(dir, 'from-agent.jsonl'), jsonl(agent));
    writeFileSync(join(dir, 'to-agent.jsonl'), jsonl(person));
    const done = Math.max(0, person.length - 3);
    writeFileSync(join(dir, 'read.json'), JSON.stringify({ lines: done, reads: [{ lines: Math.floor(done / 2), at: atOf(n / 2) }, { lines: done, at: atOf(n - 5) }] }));
    if (split !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ split }));
    return { work, dir, keep: keep ? join(work, 'kept') : undefined, n, agent, person };
}
const NOW = new Date(T0 + 60_000 * STEP_MS);
const host = (th, more = {}) => new Parley(th.dir, { keep: th.keep, now: () => NOW, settle: 0, ...more });
/* The same folders copied: read by a host that never saw them (nothing of them in memory). */
function copy(t, th) {
    const work = folder(t);
    cpSync(th.dir, join(work, '.parley'), { recursive: true });
    if (th.keep && existsSync(th.keep)) cpSync(th.keep, join(work, 'kept'), { recursive: true });
    return { ...th, work, dir: join(work, '.parley'), keep: th.keep ? join(work, 'kept') : undefined };
}
/* Split now: begun at the first read, counted at the next (settle: 0). */
function split(th, more) { host(th, more).read(); host(th, more).read(); }
const volumesOf = (dir) => JSON.parse(readFileSync(join(dir, 'archive', 'index.json'), 'utf8')).volumes;
/* Every line of a side, in its places: the volumes, then the current file. */
const allLines = (dir, name) => [...volumesOf(dir).flatMap((v) => readFileSync(join(dir, 'archive', `${v.name}.${name}`), 'utf8').split('\n').filter(Boolean)), ...readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)];

/* The parts an application reads, each asked of a host that never saw the folder. */
const PARTS = [
    ['plain', () => undefined],
    ['last 200', () => ({ last: 200 })],
    ['last 1000', () => ({ last: 1000 })],
    ['days 1', () => ({ days: 1 })],
    ['days 3', () => ({ days: 3 })],
    ['all', () => ({ all: true })],
];
function parts(t, th, ref) {
    const all = ref.read({ all: true }).messages.map((m) => m.id);
    const extra = [
        ['before, early', { before: all[Math.floor(all.length / 10)], last: 50 }],
        ['before, mid', { before: all[Math.floor(all.length / 2)], days: 1 }],
        ['from, early', { before: all[Math.floor(all.length / 5)], from: all[Math.floor(all.length / 8)] }],
    ];
    for (const [why, o] of [...PARTS.map(([w, f]) => [w, f()]), ...extra]) {
        assert.equal(JSON.stringify(host(copy(t, th)).read(o)), JSON.stringify(ref.read(o)), why);
    }
    assert.equal(JSON.stringify(host(copy(t, th)).search('zebracorn')), JSON.stringify(ref.search('zebracorn')), 'search');
    assert.equal(host(copy(t, th)).unread(), ref.unread(), 'unread');
}

test('the setting: messages, days (a day, half of one), never; anything else the default', () => {
    assert.deepEqual(splitOf({ messages: 2000 }), { messages: 2000 });
    assert.deepEqual(splitOf({ days: 7 }), { days: 7 });
    assert.deepEqual(splitOf({ days: 1 }), { days: 1 });
    assert.deepEqual(splitOf({ days: 0.5 }), { days: 0.5 });
    assert.equal(splitOf(false), false);
    for (const bad of [undefined, null, {}, { messages: 3 }, { messages: 2.5 }, { days: 0 }, { days: -1 }, 'week']) assert.deepEqual(splitOf(bad), { ...SPLIT });
});

test('split by count: volumes named by their time span, every line in one place only, the same thread read', (t) => {
    const th = thread(t, 1600, { seed: 5, split: { messages: 300 } });
    const ref = new Parley(thread(t, 1600, { seed: 5, split: false }).dir, { now: () => NOW });
    const before = host(th).read({ last: 200 });
    /* Begun: the files renamed, not counted yet -- read the same meanwhile. */
    const p = new Parley(th.dir, { now: () => NOW, settle: 60_000 });
    p.read();
    assert.ok(existsSync(join(th.dir, 'archive', 'moving.from-agent.jsonl')));
    assert.equal(JSON.stringify(new Parley(th.dir, { now: () => NOW, settle: 60_000 }).read({ last: 200 })), JSON.stringify(before), 'while it is being split');
    host(th).read();
    const vols = volumesOf(th.dir);
    assert.ok(vols.length >= 4 && vols.length <= 6, `${vols.length} volumes`);
    for (const v of vols) {
        assert.match(v.name, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ--\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
        assert.ok(v.from.lines + v.to.lines >= 300, v.name);
        assert.equal(v.first.slice(0, 19).replace(/:/g, '-'), v.name.slice(0, 19));
    }
    assert.deepEqual(vols.map((v) => v.name), [...vols.map((v) => v.name)].sort(), 'sortable by name');
    assert.deepEqual(readdirSync(join(th.dir, 'archive')).filter((f) => f.startsWith('moving')), [], 'nothing left moving');
    /* Nothing lost, nothing changed: the lines of the volumes and the current files are the lines written, in order. */
    assert.deepEqual(allLines(th.dir, 'from-agent.jsonl'), jsonl(th.agent).split('\n').filter(Boolean));
    assert.deepEqual(allLines(th.dir, 'to-agent.jsonl'), jsonl(th.person).split('\n').filter(Boolean));
    assert.equal(JSON.stringify(host(th).read({ last: 200 })), JSON.stringify(before), 'once split');
    parts(t, th, ref);
});

test('split by days: no volume spans more than its days -- a week, a day', (t) => {
    for (const days of [7, 1]) {
        /* 1,600 lines a minute apart and more: about nine days. */
        const th = thread(t, 1600, { seed: 9, split: { days }, step: 70 });
        const ref = new Parley(thread(t, 1600, { seed: 9, split: false, step: 70 }).dir, { now: () => NOW });
        /* Split a month after its first line. */
        split(th, { now: () => new Date(T0 + 30 * 86_400_000) });
        const vols = volumesOf(th.dir);
        assert.ok(vols.length >= (days === 1 ? 8 : 2), `${days} days: ${vols.length} volumes`);
        for (const v of vols) assert.ok(Date.parse(v.last) - Date.parse(v.first) < days * 86_400_000, `${v.name} spans less than ${days} days`);
        parts(t, th, ref);
    }
});

test('the agent writes while the files are renamed: no line lost, none twice; its counts never go back', (t) => {
    const th = thread(t, 400, { seed: 2, split: { messages: 100 } });
    const agent = bridge(th.dir);
    const counts = [];
    /* What the agent read: all of the person's lines, counted through the archive. */
    const count = () => { agent.read(); counts.push(JSON.parse(readFileSync(join(th.dir, 'read.json'), 'utf8')).lines); };
    let held;
    const steps = [];
    const p = new Parley(th.dir, {
        now: () => NOW, settle: 0,
        onSplit: (step) => {
            steps.push(step);
            agent.tell(`said at ${step}`);
            count();
            /* A write the agent opened before its file was renamed, and finished after: it lands in the file renamed. */
            if (step === 'moved to-agent.jsonl') held = openSync(join(th.dir, 'from-agent.jsonl'), 'a');
            if (step === 'moved from-agent.jsonl') { writeSync(held, `${JSON.stringify({ id: 'late-1', at: atOf(900), kind: 'say', text: 'written late' })}\n`); closeSync(held); }
        },
    });
    count();
    p.say('the person writes too');
    assert.deepEqual(steps, ['marked', 'moved to-agent.jsonl', 'moved from-agent.jsonl']);
    agent.tell('said before it is counted');
    count();
    p.read();
    assert.ok(volumesOf(th.dir).length >= 4);
    agent.tell('said after');
    count();
    const ids = (name) => allLines(th.dir, name).map((l) => JSON.parse(l).id);
    const from = ids('from-agent.jsonl');
    assert.equal(new Set(from).size, from.length, 'no line twice');
    for (const id of [...th.agent.map((l) => l.id), 'late-1']) assert.ok(from.includes(id), `${id} kept`);
    const said = host(th).read({ all: true }).messages.filter((m) => m.from === 'agent' && m.text.startsWith('said'));
    assert.deepEqual(said.map((m) => m.text).sort(), ['said after', 'said at marked', 'said at moved from-agent.jsonl', 'said at moved to-agent.jsonl', 'said before it is counted'].sort());
    const toN = th.person.length + 1;
    assert.deepEqual(counts, [th.person.length, toN, toN, toN, toN, toN], 'the agent counts every line of the person, through the split');
    assert.equal(host(th).unread(), 0);
});

test('a cursor, read.json and an answer to an old question stay valid across a split', (t) => {
    const th = thread(t, 900, { seed: 4, split: false });
    /* A question asked first, and never answered: it ends up in the oldest volume. */
    const file = join(th.dir, 'from-agent.jsonl');
    writeFileSync(file, `${JSON.stringify({ id: 'a0a0a0a0-old', at: atOf(0), kind: 'ask', text: 'An old question', choices: ['Yes', 'No'] })}\n${readFileSync(file, 'utf8')}`);
    const p = host(th);
    const cursor = p.read({ last: 200 }).cursor;
    const unread = p.unread();
    const open = p.read().waiting;
    writeFileSync(join(th.dir, 'settings.json'), JSON.stringify({ split: { messages: 200 } }));
    p.setSplit({ messages: 200 });
    assert.deepEqual(p.split(), { messages: 200 });
    split(th);
    assert.ok(volumesOf(th.dir).length >= 3);
    const q = host(th);
    assert.equal(q.unread(), unread);
    assert.equal(q.read().waiting, open, 'the questions still open, from the volumes');
    /* Nothing new: the same cursor, nothing changed. */
    const same = q.read({ last: 200, since: cursor });
    assert.equal(same.since, true);
    assert.equal(same.messages.length, 0);
    assert.equal(same.cursor, cursor);
    appendFileSync(join(th.dir, 'from-agent.jsonl'), `${JSON.stringify({ id: 'new-1', at: atOf(5000), kind: 'say', text: 'new after the split' })}\n`);
    const grown = host(copy(t, th)).read({ last: 200, since: cursor });
    assert.equal(grown.since, true);
    assert.deepEqual(grown.messages.map((m) => m.id), ['new-1']);
    /* A question still open in a volume is answered from the screen, and is answered. */
    const old = q.read({ last: 200 }).messages.find((m) => m.id === 'a0a0a0a0-old');
    assert.ok(old, 'the question left open in the oldest volume comes with the newest window');
    const after = host(th).say('Yes', old.id);
    assert.ok(after.messages.some((m) => m.answers === old.id));
    assert.equal(host(th).read().waiting, open - 1);
});

test('"earlier messages" walks back through every volume to the start: the same messages, in order', (t) => {
    const th = thread(t, 2000, { seed: 6, split: { messages: 250 } });
    const plain = thread(t, 2000, { seed: 6, split: false });
    const ref = new Parley(plain.dir, { now: () => NOW });
    split(th);
    const walk = (p) => {
        let page = p.read({ last: 60 });
        const seen = [page.messages];
        while (page.window.before) { page = p.read({ before: page.window.before, last: 60 }); seen.unshift(page.messages); }
        return seen.flat().map((m) => m.id);
    };
    const c = copy(t, th);
    const before = ARCHIVE_STATS.parsed;
    const first = host(c).read({ last: 60 });
    const files = 2 * volumesOf(th.dir).length;
    assert.ok(ARCHIVE_STATS.parsed - before <= files / 2, `the newest page reads the newest volumes only (${ARCHIVE_STATS.parsed - before} files of ${files})`);
    assert.deepEqual(first.window, ref.read({ last: 60 }).window);
    assert.deepEqual(walk(host(c)), walk(ref));
    /* The agent's side: its pages too, the same words. */
    const a = bridge(copy(t, th).dir), b = bridge(copy(t, plain).dir);
    const id = (text) => /--before (\S+)/.exec(text)?.[1];
    let x = a.read({ last: 100 }), y = b.read({ last: 100 });
    for (let k = 0; k < 8 && id(y); k += 1) {
        assert.equal(x, y, `page ${k}`);
        x = a.read({ before: id(x), last: 100 }); y = b.read({ before: id(y), last: 100 });
    }
    assert.equal(a.read({ days: 2 }), b.read({ days: 2 }));
    assert.equal(a.read(), b.read(), 'nothing new');
});

test('with a keep folder: what is kept is split the same way, and nothing is noted as changed', (t) => {
    const th = thread(t, 1200, { seed: 8, split: { messages: 300 }, keep: true });
    const ref = new Parley(thread(t, 1200, { seed: 8, split: false }).dir, { now: () => NOW });
    let changed = 0;
    const p = new Parley(th.dir, { keep: th.keep, now: () => NOW, settle: 0, on: (e) => { if (e.type === 'history-changed') changed += 1; },
        onSplit: (step) => { if (step === 'moved from-agent.jsonl') appendFileSync(join(th.dir, 'from-agent.jsonl'), `${JSON.stringify({ id: 'during', at: atOf(1300), kind: 'say', text: 'said during the split' })}\n`); } });
    p.read();
    p.read();
    p.read();
    assert.equal(changed, 0);
    assert.ok(volumesOf(th.keep).length >= 3, 'the copy split');
    assert.ok(volumesOf(th.dir).length >= 3, 'the bridge split');
    assert.deepEqual(p.read().altered, []);
    const all = p.read({ all: true }).messages.map((m) => m.id);
    assert.deepEqual(all.filter((id) => id !== 'during'), ref.read({ all: true }).messages.map((m) => m.id));
    assert.ok(all.includes('during'));
    assert.equal(host(copy(t, th)).read({ last: 200 }).messages.length, 200);
});

/* THE TIMES: 50,000 lines split into 25 volumes. A read of the end after one line was added keeps
   the budget of a thread never split (test/dense.test.mjs); one by a host that never saw the
   folder reads its current files and a volume or two, never all of them. */
test('50,000 lines split: the end read fast, warm and cold, without reading the volumes', (t) => {
    const th = thread(t, 50_000, { seed: 3, split: { messages: 2000 } });
    split(th);
    const vols = volumesOf(th.dir);
    assert.ok(vols.length >= 20, `${vols.length} volumes`);
    const c = copy(t, th);
    const before = ARCHIVE_STATS.parsed;
    const t0 = performance.now();
    const cold = host(c).read({ last: 200 });
    const coldMs = performance.now() - t0;
    const parsed = ARCHIVE_STATS.parsed - before;
    assert.equal(cold.messages.length >= 200, true);
    assert.equal(cold.window.total, new Parley(thread(t, 50_000, { seed: 3, split: false }).dir, { now: () => NOW }).read({ last: 1 }).window.total);
    assert.ok(parsed <= 4, `a cold read parsed ${parsed} of ${2 * vols.length} files`);
    const times = [];
    for (let k = 0; k < 5; k += 1) {
        appendFileSync(join(c.dir, 'from-agent.jsonl'), `${JSON.stringify({ id: `d-${k}`, at: atOf(60_000 + k), kind: 'doing', text: 'Doing more' })}\n`);
        const t1 = performance.now();
        host(c).read({ last: 200 });
        times.push(performance.now() - t1);
    }
    const median = [...times].sort((a, b) => a - b)[2];
    t.diagnostic(`split into ${vols.length}: cold ${coldMs.toFixed(1)} ms (${parsed} files of the archive read), after a doing ${median.toFixed(1)} ms`);
    assert.ok(median < 60, `read after one doing: ${median.toFixed(1)} ms, budget 60 ms`);
    assert.ok(coldMs < 500, `cold: ${coldMs.toFixed(1)} ms`);
});

test('a pin put now on a message of an old volume is shown, found where it is', (t) => {
    const th = thread(t, 1500, { seed: 11, split: { messages: 200 } });
    split(th);
    const old = host(th).read({ all: true }).messages.find((m) => m.from === 'agent' && m.kind === 'say');
    host(th).pin(old.id);
    const pins = host(copy(t, th)).read().pins;
    assert.deepEqual(pins.map((p) => p.id), [...host(th).read().pins.map((p) => p.id)]);
    assert.ok(pins.some((p) => p.id === old.id && p.from === 'agent'));
    /* Split again: the pin and its message are carried, and found with no search. */
    for (let k = 0; k < 300; k += 1) appendFileSync(join(th.dir, 'from-agent.jsonl'), `${JSON.stringify({ id: `more-${k}`, at: atOf(20_000 + k), kind: 'doing', text: 'Doing' })}\n`);
    split(th);
    const c = copy(t, th);
    const before = ARCHIVE_STATS.parsed;
    assert.ok(host(c).read().pins.some((p) => p.id === old.id));
    /* No more than the newest volumes a window needs (the split left the current files empty). */
    const vols = volumesOf(c.dir);
    let need = 0;
    for (let q = vols.length - 1, n = 0; q >= 0 && n < 200; q -= 1) { n += vols[q].messages; need += 2; }
    assert.ok(ARCHIVE_STATS.parsed - before <= need, `${ARCHIVE_STATS.parsed - before} files read, ${need} needed`);
});

/* 14-11, found on a real thread: a question answered at once, but carried on for another reason (a
   file it cites, a pin on it), came back open at the next split -- its answer is in a volume not
   carried. The newest window then showed old questions as open. */
test('a question answered, carried on for a file it cites or a pin, stays answered over every split', (t) => {
    const make = (split) => {
        const work = folder(t), dir = join(work, '.parley');
        install(dir);
        const agent = [], person = [];
        for (let k = 0; k < 3000; k += 1) {
            const at = atOf(k), id = `${(Math.imul(k + 1, 2654435761) >>> 0).toString(16).padStart(8, '0')}-q-${k}`;
            if (k % 150 === 10) {
                agent.push({ id, at, kind: 'ask', text: `Which one? see /work/out/plan-${k}.html`, choices: ['A', 'B'] });
                person.push({ id: `${id}-a`, at: atOf(k + 0.5), text: 'A', answers: id, question: 'Which one?' });
                if (k % 300 === 10) person.push({ id: `${id}-p`, at: atOf(k + 0.6), text: '', pin: id, quote: 'q', toAt: at });
            } else if (k % 7 === 0) person.push({ id, at, text: 'fine' });
            else agent.push({ id, at, kind: k % 3 ? 'doing' : 'say', text: `step ${k}` });
        }
        writeFileSync(join(dir, 'from-agent.jsonl'), jsonl(agent));
        writeFileSync(join(dir, 'to-agent.jsonl'), jsonl(person));
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ split }));
        return { work, dir };
    };
    const plain = new Parley(make(false).dir, { now: () => NOW });
    const th = make({ messages: 400 });
    split(th);
    assert.ok(volumesOf(th.dir).length >= 6);
    for (const o of [undefined, { last: 200 }, { days: 1 }, { last: 1000 }, { all: true }]) {
        const got = host(copy(t, th)).read(o);
        assert.equal(got.waiting, 0, `${JSON.stringify(o)}: nothing open`);
        assert.equal(JSON.stringify(got), JSON.stringify(plain.read(o)), JSON.stringify(o));
    }
    /* The agent's side: nothing open either, once it read what was new. */
    const agent = bridge(copy(t, th).dir);
    agent.read();
    assert.equal(agent.read(), 'No new message.');
});

/* The agent reads the folder through a mount (sshfs): inodes change from one look to the next, so
   nothing on its side may rest on them. A split caught half way, in a copy where every inode is new:
   the current file read before it was renamed is the same file (its first line), counted once. */
test('the agent counts a split caught half way once, with no inode to go by', (t) => {
    const th = thread(t, 600, { seed: 13, split: false });
    const agent = bridge(th.dir);
    agent.read();
    const before = JSON.parse(readFileSync(join(th.dir, 'read.json'), 'utf8')).lines;
    const said = agent.read({ last: 300 });
    /* As a reader sees it when it read the current files just before they were renamed. */
    const c = copy(t, th);
    cpSync(join(c.dir, 'to-agent.jsonl'), join(c.dir, 'archive', 'moving.to-agent.jsonl'), { recursive: true });
    cpSync(join(c.dir, 'from-agent.jsonl'), join(c.dir, 'archive', 'moving.from-agent.jsonl'));
    writeFileSync(join(c.dir, 'archive', 'index.json'), JSON.stringify({ volumes: [], moving: { since: Date.now() } }));
    const copied = bridge(c.dir);
    copied.read();
    assert.equal(JSON.parse(readFileSync(join(c.dir, 'read.json'), 'utf8')).lines, before);
    assert.equal(copied.read({ last: 300 }), said);
    /* And once renamed: the new current files are empty, the lines all in the file renamed. */
    writeFileSync(join(c.dir, 'to-agent.jsonl'), '');
    writeFileSync(join(c.dir, 'from-agent.jsonl'), '');
    copied.read();
    assert.equal(JSON.parse(readFileSync(join(c.dir, 'read.json'), 'utf8')).lines, before);
    assert.equal(copied.read({ last: 300 }), said);
});
