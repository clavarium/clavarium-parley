/* A DENSE THREAD: tens of thousands of lines, most of them steps (doing, status), read the way an
   application reads it -- a window, a cursor, a count of what is not read -- every few seconds.
   Two things are proved here. What is read is the same as a thread read whole for the first time
   (a copy of the folders, read cold), whatever was done to the files in between. And a thread that
   grew by one line is read again in a time that does not grow with the thread. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { install, Parley } from '../host/parley-host.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-dense-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

/* The same thread each time: a small generator of numbers, so that a failure can be run again. */
function numbers(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const T0 = Date.parse('2026-01-01T08:00:00.000Z');
const atOf = (k) => new Date(T0 + k * 7000).toISOString();
const WORDS = 'the build of the page went through and the tests passed before the change to the list of files was written'.split(' ');

/* Lines as the agent's command and this host write them: `n` in all, about 55% of them steps. */
function lines(n, seed = 1) {
    const r = numbers(seed);
    const words = (k) => Array.from({ length: k }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    const agent = [], person = [];
    /* Most questions get an answer, as in a real thread: a few stay open. */
    const asks = [], said = [], waits = [];
    for (let k = 0; k < n; k += 1) {
        const at = atOf(k), id = `m${seed}-${k}`;
        const x = r();
        if (x < 0.4) agent.push({ id, at, kind: 'doing', text: `Doing ${words(8)}` });
        else if (x < 0.55) agent.push({ id, at, kind: 'status', state: ['working', 'waiting', 'done'][Math.floor(r() * 3)], text: words(10) });
        else if (x < 0.66) { agent.push({ id, at, kind: 'say', text: `${words(30)} see /work/out/report-${k}.html`, short: words(6) }); said.push(id); }
        else if (x < 0.69) { agent.push({ id, at, kind: 'ask', text: words(20), choices: ['Yes', 'No'] }); asks.push(id); waits.push(id); }
        else if (x < 0.71) agent.push({ id, at, kind: 'show', path: `/work/out/chart-${k}.png`, text: words(6), ...(r() < 0.3 ? { files: [{ path: `/work/out/a-${k}.png`, title: 'A' }, { path: `/work/out/b-${k}.png`, title: 'B' }] } : {}) });
        else if (x < 0.712 && asks.length) agent.push({ id, at, kind: 'close', answers: asks[Math.floor(r() * asks.length)], text: 'Answered in the chat' });
        else if (x < 0.714 && said.length) agent.push({ id, at, kind: 'pin', pin: said[Math.floor(r() * said.length)], text: '', ...(r() < 0.3 ? { removed: true } : {}) });
        else if (x < 0.9) {
            const y = r();
            const line = { id, at, text: words(18) };
            if (y < 0.25 && waits.length) Object.assign(line, { answers: waits.pop(), question: 'A question' });
            else if (y < 0.4 && said.length) Object.assign(line, { re: said.at(-1), quote: 'what was said' });
            else if (y < 0.48) line.files = [{ path: `/work/.parley/files/f-${k}.txt`, name: `f-${k}.txt`, size: 120 }];
            else if (y < 0.52) line.via = 'voice';
            person.push(line);
        } else if (x < 0.98 && said.length) person.push({ id, at, text: '', to: said[Math.floor(r() * said.length)], quote: 'q', toAt: at, reaction: ['agree', 'go', 'love'][Math.floor(r() * 3)], ...(r() < 0.1 ? { removed: true } : {}) });
        else if (said.length) person.push({ id, at, text: '', pin: said[Math.floor(r() * said.length)], quote: 'q', toAt: at, ...(r() < 0.3 ? { removed: true } : {}) });
        else agent.push({ id, at, kind: 'doing', text: words(5) });
    }
    return { agent, person };
}
const jsonl = (list) => list.map((l) => `${JSON.stringify(l)}\n`).join('');
/* A thread of `n` lines in a new bridge folder; the agent has read all but the last few lines of the person. */
function thread(t, n, { seed = 1, keep = false } = {}) {
    const work = folder(t);
    const dir = join(work, '.parley');
    install(dir);
    const { agent, person } = lines(n, seed);
    writeFileSync(join(dir, 'from-agent.jsonl'), jsonl(agent));
    writeFileSync(join(dir, 'to-agent.jsonl'), jsonl(person));
    const done = Math.max(0, person.length - 3);
    const reads = Array.from({ length: 250 }, (_, k) => ({ lines: Math.round((done * (k + 1)) / 250), at: atOf(n * ((k + 1) / 250)) }));
    writeFileSync(join(dir, 'read.json'), JSON.stringify({ lines: done, reads: reads.slice(-200) }));
    return { work, dir, keep: keep ? join(work, 'kept') : undefined, n };
}
const NOW = new Date(T0 + 60_000 * 7000);
const host = (th, more = {}) => new Parley(th.dir, { keep: th.keep, now: () => NOW, ...more });
let serial = 0;
const agentLine = (kind, more = {}) => ({ id: `x-${(serial += 1)}`, at: atOf(1_000_000 + serial), kind, text: `New ${kind} ${serial}`, ...more });
const post = (th, line) => appendFileSync(join(th.dir, 'from-agent.jsonl'), `${JSON.stringify(line)}\n`);

/* EVERYTHING AN APPLICATION READS of a thread, as text: compared whole, key order too. */
function everything(p, since) {
    const all = p.read({ all: true });
    const ids = all.messages.map((m) => m.id);
    const mid = ids[Math.floor(ids.length / 2)];
    return JSON.stringify({
        plain: p.read(),
        last: p.read({ last: 200 }),
        page: p.read({ before: mid, last: 50 }),
        from: p.read({ before: mid, from: ids[Math.floor(ids.length / 3)] }),
        days: p.read({ days: 2 }),
        all,
        since: since ? p.read({ last: 200, since }) : null,
        unread: p.unread(),
        search: p.search('passed'),
    });
}
/* The same, read cold: both folders copied to new places, read once, by a new host. */
function reference(t, th, since, more) {
    const work = folder(t);
    const dir = join(work, '.parley');
    cpSync(th.dir, dir, { recursive: true });
    const keep = th.keep ? join(work, 'kept') : undefined;
    if (keep && existsSync(th.keep)) cpSync(th.keep, keep, { recursive: true });
    return everything(new Parley(dir, { keep, now: () => NOW, ...more }), since);
}

for (const kept of [false, true]) {
    test(`a dense thread read again as it changes is read as if read whole (${kept ? 'with' : 'without'} a keep folder)`, (t) => {
        const th = thread(t, 3000, { seed: 7, keep: kept });
        const one = host(th);
        let cursor = one.read({ last: 200 }).cursor;
        const same = (why, more = {}) => {
            /* Read by the host that read before (warm), and by a new one (as the application makes one per call). */
            const warm = everything(more.reach ? host(th, more) : one, cursor);
            assert.equal(warm, reference(t, th, cursor, more), why);
            assert.equal(everything(host(th, more), cursor), warm, `${why} (a new host)`);
            cursor = host(th, more).read({ last: 200 }).cursor;
        };
        same('as it is');
        post(th, agentLine('doing')); post(th, agentLine('status', { state: 'waiting' }));
        same('steps added');
        post(th, agentLine('doing'));
        same('a doing after waiting: working again');
        const ask = agentLine('ask', { choices: ['Red', 'Blue'] });
        post(th, ask); post(th, agentLine('say', { text: 'Wrote /work/out/new.html and /work/out/chart-12.png' }));
        post(th, agentLine('show', { path: '/work/out/new.html', text: 'the page' }));
        same('a question, a message citing files, a file shown');
        one.say('Blue', ask.id);
        same('the question answered');
        const ask2 = agentLine('ask', { choices: ['A', 'B'] });
        post(th, ask2);
        same('another question');
        post(th, agentLine('close', { answers: ask2.id, text: 'Done another way' }));
        same('it closed it');
        const said = one.read({ all: true }).messages.filter((m) => m.from === 'agent' && m.kind === 'say');
        one.react(said.at(-1).id, 'agree');
        one.react(said.at(-3).id, 'go');
        same('reactions');
        one.react(said.at(-1).id, null);
        same('a reaction taken back');
        one.pin(said.at(-2).id); one.pin(said.at(-10).id);
        post(th, agentLine('pin', { pin: said.at(-4).id }));
        post(th, agentLine('pin', { pin: 'later-1' }));
        same('pins, one of a message not there yet');
        post(th, { ...agentLine('say'), id: 'later-1' });
        same('the message pinned before it was there');
        one.pin(said.at(-2).id, false);
        post(th, agentLine('pin', { pin: said.at(-4).id, removed: true }));
        same('pins taken away');
        one.say('Here is the file', undefined, [{ path: '/work/.parley/files/plan.pdf', name: 'plan.pdf', size: 10 }]);
        same('a file attached');
        /* The agent reads: the count moves, a read is added, the oldest read goes (200 kept). */
        const r = JSON.parse(readFileSync(join(th.dir, 'read.json'), 'utf8'));
        const toN = readFileSync(join(th.dir, 'to-agent.jsonl'), 'utf8').split('\n').filter(Boolean).length;
        writeFileSync(join(th.dir, 'read.json'), JSON.stringify({ lines: toN - 1, reads: [...r.reads, { lines: toN - 1, at: atOf(2_000_000) }].slice(-200) }));
        same('the agent read');
        writeFileSync(join(th.dir, 'read.json'), JSON.stringify({ lines: 5, reads: [{ lines: 5, at: atOf(3) }] }));
        same('read.json written again, lower');
        writeFileSync(join(th.dir, 'read.json'), JSON.stringify({ lines: toN + 10, reads: [{ lines: 2, at: atOf(3) }] }));
        same('read.json beyond what was written');
        /* Lines out of order, and an id said twice. */
        post(th, { ...agentLine('say'), at: atOf(1500) });
        post(th, { ...agentLine('say'), id: said.at(-5).id });
        one.say('Same time as the next');
        const at = one.read({ last: 1 }).messages.at(-1).at;
        post(th, { ...agentLine('say'), at });
        same('out of order, an id twice, the same time on both sides');
        /* A line not ended yet, then ended. */
        appendFileSync(join(th.dir, 'from-agent.jsonl'), JSON.stringify(agentLine('say')));
        same('a line not ended yet');
        appendFileSync(join(th.dir, 'from-agent.jsonl'), '\n');
        post(th, agentLine('doing'));
        same('the line ended');
        appendFileSync(join(th.dir, 'from-agent.jsonl'), 'not json at all\n');
        post(th, agentLine('say'));
        same('a line that is no object keeps its place');
        /* Its rooms named: the names of whom a message is for. */
        one.setRooms([{ id: 'r1', name: 'Kitchen', members: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Helper', kind: 'ai' }] }]);
        post(th, agentLine('say', { to: ['aaaaaaaa-0000-0000-0000-000000000001'], text: 'For @{aaaaaaaa-0000-0000-0000-000000000001}' }));
        same('rooms set');
        one.setRooms([{ id: 'r1', name: 'Kitchen', members: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Cook', kind: 'ai' }] }]);
        same('a member renamed');
        /* The application's way to open a file changed. */
        same('reach changed', { reach: (p) => (p.includes('chart') ? null : `open:${p}`) });
        /* The person's side written by someone else (an 'added' line, with a keep folder). */
        appendFileSync(join(th.dir, 'to-agent.jsonl'), `${JSON.stringify({ id: 'slipped', at: atOf(4_000_000), text: 'not written by the host' })}\n`);
        same('a person line written in the bridge');
        /* The bridge rewritten: a line changed in place (same length), one gone, then the file shorter. */
        const file = join(th.dir, 'from-agent.jsonl');
        /* A message near the end changed, its length kept: in place, then with a line added in the same write
           (a change further back than the end compared is found when the file is next read whole: WHOLE_EVERY). */
        const near = (text) => text.split('\n').filter((l) => l.includes('"kind":"say"') && l.includes('"text":"New say')).at(-1);
        const change = (text, to) => { const was = near(text); assert.ok(was); return text.replace(was, was.replace('"text":"New say', `"text":"${to}`)); };
        writeFileSync(file, change(readFileSync(file, 'utf8'), 'NEW say'));
        same('a line rewritten in place');
        writeFileSync(file, change(readFileSync(file, 'utf8'), 'NEw say') + `${JSON.stringify(agentLine('say'))}\n`);
        same('a line rewritten, and one added at once');
        const kept2 = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, `${[...kept2.slice(0, 100), ...kept2.slice(101)].join('\n')}\n`);
        same('a line gone');
        writeFileSync(file, `${kept2.slice(0, 500).join('\n')}\n`);
        same('the file shorter');
        post(th, agentLine('say'));
        same('and grown again');
    });
}

/* THE TIMES: printed, and held to a budget that does not grow with the thread (a 1-vCPU host,
   busy with other work: wide margins). The old way rebuilt the whole thread on every read: about
   a second on 50,000 lines. */
const BUDGET = { grown: 60, since: 15, unread: 15 };
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const timed = (f) => { const t0 = performance.now(); const r = f(); return [performance.now() - t0, r]; };
for (const kept of [false, true]) {
    test(`a thread of 50,000 lines is read again fast once it grew by one line (${kept ? 'with' : 'without'} a keep folder)`, (t) => {
        const th = thread(t, 50_000, { seed: 3, keep: kept });
        const [cold] = timed(() => host(th).read({ last: 200 }));
        const [warm] = timed(() => host(th).read({ last: 200 }));
        const doing = [], said = [], since = [], unread = [];
        for (let k = 0; k < 5; k += 1) {
            post(th, agentLine('doing'));
            doing.push(timed(() => host(th).read({ last: 200 }))[0]);
            said.push(timed(() => { host(th).say(`Fine ${k}`); return host(th).read({ last: 200 }); })[0]);
            const cursor = host(th).read({ last: 200 }).cursor;
            since.push(timed(() => host(th).read({ last: 200, since: cursor }))[0]);
            unread.push(timed(() => host(th).unread())[0]);
        }
        const ms = (x) => `${x.toFixed(1)} ms`;
        t.diagnostic(`${kept ? 'kept' : 'bridge only'}: cold ${ms(cold)}, warm ${ms(warm)}, after a doing ${ms(median(doing))}, after a message of the person (say + read) ${ms(median(said))}, since (no change) ${ms(median(since))}, unread ${ms(median(unread))}`);
        assert.ok(median(doing) < BUDGET.grown, `read after one doing: ${ms(median(doing))}, budget ${BUDGET.grown} ms`);
        assert.ok(median(said) < 2 * BUDGET.grown, `say and read: ${ms(median(said))}, budget ${2 * BUDGET.grown} ms`);
        assert.ok(median(since) < BUDGET.since, `since, no change: ${ms(median(since))}`);
        assert.ok(median(unread) < BUDGET.unread, `unread: ${ms(median(unread))}`);
    });
}
