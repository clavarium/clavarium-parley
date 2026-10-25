import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Parley, texts } from '../host/parley-host.mjs';
import { view, PULSE_MS } from '../ui/parley-ui.js';
import { run, HELP, STOP_CHECK } from '../bin/parley.mjs';
import { bridge, PULSE_EVERY_MS } from '../server/parley-mcp.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'parley-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const at = (minute) => new Date(Date.parse('2026-01-05T06:00:00.000Z') + minute * 60_000).toISOString();
const words = texts('en');

test('"parley pulse": for the hooks of the agent\'s tool; one small file rewritten, nothing printed, no line in the thread', (t) => {
    const work = folder(t);
    const chat = join(work, '.parley');
    mkdirSync(chat);
    const env = { PARLEY_DIR: '' };
    assert.deepEqual(run(['pulse'], { env, cwd: work }), { code: 0, out: '', err: '' }, 'nothing printed: a hook\'s output may reach the agent');
    const beat = JSON.parse(readFileSync(join(chat, 'pulse.json'), 'utf8'));
    assert.equal(beat.busy, true);
    assert.ok(Date.now() - Date.parse(beat.at) < 5000);
    assert.equal(existsSync(join(chat, 'from-agent.jsonl')), false, 'no line posted');
    assert.deepEqual(run(['pulse', '--end'], { env, cwd: work }), { code: 0, out: '', err: '' });
    assert.equal(JSON.parse(readFileSync(join(chat, 'pulse.json'), 'utf8')).busy, false, 'its turn ended');
    assert.deepEqual(run(['pulse', 'now'], { env, cwd: work }), { code: 64, out: '', err: '' }, 'not understood: said by the exit code alone');
    const elsewhere = folder(t);
    assert.deepEqual(run(['pulse'], { env, cwd: elsewhere }), { code: 2, out: '', err: '' }, 'no chat here: nothing said, nothing made');
    assert.equal(existsSync(join(elsewhere, '.parley')), false);
    assert.match(HELP, /parley pulse \[--end \[--stop-check\]\]/);
});

test('a pulse that says the same is written again only after a while: a tool may pulse at every action', (t) => {
    const dir = folder(t);
    const b = bridge(dir);
    const t0 = new Date('2026-01-05T06:00:00.000Z');
    b.pulse(true, { now: t0 });
    b.pulse(true, { now: new Date(t0.getTime() + PULSE_EVERY_MS - 1) });
    assert.equal(JSON.parse(readFileSync(join(dir, 'pulse.json'), 'utf8')).at, t0.toISOString(), 'the same, soon after: left as it is');
    const later = new Date(t0.getTime() + PULSE_EVERY_MS);
    b.pulse(true, { now: later });
    assert.equal(JSON.parse(readFileSync(join(dir, 'pulse.json'), 'utf8')).at, later.toISOString());
    const end = new Date(later.getTime() + 1000);
    b.pulse(false, { now: end });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pulse.json'), 'utf8')), { busy: false, at: end.toISOString() }, 'another state: written at once');
});

test('the application reads the pulse with the rest; what the agent\'s side wrote is not trusted', (t) => {
    const dir = folder(t);
    const now = new Date(at(10));
    const p = new Parley(dir, { now: () => now });
    assert.equal(p.read().pulse, null, 'none yet');
    writeFileSync(join(dir, 'pulse.json'), JSON.stringify({ busy: true, at: at(9) }));
    assert.deepEqual(p.read().pulse, { busy: true, at: at(9) });
    writeFileSync(join(dir, 'pulse.json'), JSON.stringify({ busy: true, at: at(60) }));
    assert.deepEqual(p.read().pulse, { busy: true, at: at(10) }, 'a time to come is taken as now');
    for (const bad of ['{', JSON.stringify({ busy: 'yes', at: at(9) }), JSON.stringify({ busy: true, at: 'soon' }), JSON.stringify({ busy: true, at: at(9), pad: 'x'.repeat(2000) })]) {
        writeFileSync(join(dir, 'pulse.json'), bad);
        assert.equal(p.read().pulse, null, bad.slice(0, 40));
    }
    rmSync(join(dir, 'pulse.json'));
    const outside = join(folder(t), 'elsewhere.json');
    writeFileSync(outside, JSON.stringify({ busy: true, at: at(9) }));
    symlinkSync(outside, join(dir, 'pulse.json'));
    assert.equal(p.read().pulse, null, 'never through a link');
});

test('the agent works without a word: its tool\'s pulse says "Working…" where Parley would say received, or no answer yet', () => {
    const read = { from: 'person', id: 'p1', kind: 'say', text: 'Rent a car.', seen: true, seenAt: at(1), at: at(0) };
    const last = (v) => v.rows.at(-1);
    let v = view({ messages: [read], pulse: { busy: true, at: at(6) } }, { words, now: Date.parse(at(7)), locale: 'en-GB' });
    assert.deepEqual([last(v).type, last(v).text, last(v).live, last(v).time], ['now', 'Working…', true, '06:06']);
    assert.ok(!v.rows.some((r) => r.type === 'received'), 'not "no answer yet" as well');
    v = view({ messages: [read], pulse: { busy: false, at: at(6) } }, { words, now: Date.parse(at(7)) });
    assert.deepEqual([last(v).type, last(v).long], ['received', true], 'its turn ended: as if there were none');
    v = view({ messages: [read], pulse: { busy: true, at: at(6) } }, { words, now: Date.parse(at(6)) + PULSE_MS });
    assert.equal(last(v).type, 'received', 'too old: it may have stopped without saying so');
    /* After its own message too: it went on working. */
    const reply = { from: 'agent', id: 'a1', kind: 'say', text: 'On it.', at: at(2) };
    v = view({ messages: [read, reply], pulse: { busy: true, at: at(30) } }, { words, now: Date.parse(at(31)) });
    assert.deepEqual([last(v).type, last(v).text], ['now', 'Working…']);
    v = view({ messages: [read, reply], pulse: { busy: true, at: at(30) } }, { words, view: 'detailed', now: Date.parse(at(31)) });
    assert.equal(v.side.now.text, 'Working…', 'detailed: on the side too');
    assert.equal(texts('fr').pulse, 'En cours…');
});

test('what it does now does not go still while its tool beats; steps after its last message fold behind "Working…"', () => {
    const asked = { from: 'person', id: 'p1', kind: 'say', text: 'Write the story.', seen: true, at: at(0) };
    const doing = { id: 'd1', kind: 'doing', state: 'working', note: 'running the tests', at: at(1) };
    let line = view({ messages: [asked], steps: [doing] }, { words, now: Date.parse(at(40)), locale: 'en-GB' }).rows.at(-1);
    assert.deepEqual([line.live, line.quiet], [false, 'nothing new since 06:01'], 'no pulse: still, as before');
    line = view({ messages: [asked], steps: [doing], pulse: { busy: true, at: at(39) } }, { words, now: Date.parse(at(40)), locale: 'en-GB' }).rows.at(-1);
    assert.deepEqual([line.text, line.live, line.quiet], ['running the tests', true, ''], 'its tool still acts: the line still moves');
    const waited = { id: 's1', kind: 'status', state: 'working', note: '', at: at(1) };
    const said = { from: 'agent', id: 'a1', kind: 'say', text: 'Started.', at: at(2) };
    const v = view({ messages: [asked, said], steps: [waited, { id: 's2', kind: 'status', state: 'waiting', note: '', at: at(3) }], status: { state: 'working', note: '', at: at(3) }, pulse: { busy: true, at: at(9) } }, { words, now: Date.parse(at(10)) });
    assert.equal(v.rows.filter((r) => r.type === 'now').length, 1, 'one line, never two');
});

test('its turn ended but it stays working: a declared-working line does not go still just because the turn ended -- a job may run in the background', () => {
    const asked = { from: 'person', id: 'p1', kind: 'say', text: 'Write the story.', seen: true, at: at(0) };
    const doing = { id: 'd1', kind: 'doing', state: 'working', note: 'running the tests', at: at(1) };
    let line = view({ messages: [asked], steps: [doing], pulse: { busy: false, at: at(3) } }, { words, now: Date.parse(at(4)), locale: 'en-GB' }).rows.at(-1);
    assert.deepEqual([line.text, line.live, line.quiet], ['running the tests', true, ''], 'the turn ended, but it said it works: the line stays live, no "stopped"');
    line = view({ messages: [asked], steps: [doing], pulse: { busy: false, at: at(3) } }, { words, now: Date.parse(at(40)), locale: 'en-GB' }).rows.at(-1);
    assert.deepEqual([line.live, line.quiet], [false, 'nothing new since 06:01'], 'still only after a long silence, and "nothing new since", never "stopped"');
});

test('the Stop hook of Claude Code: asked once to say where it is while its chat says it works; stopping again, it stops', (t) => {
    const work = folder(t); const chat = join(work, '.parley'); mkdirSync(chat);
    const env = { PARLEY_DIR: '' };
    const say = (...args) => run(args, { env, cwd: work });
    const stop = (hook) => run(['pulse', '--end', '--stop-check'], { env, cwd: work, stdin: () => JSON.stringify(hook) });
    assert.deepEqual(stop({ stop_hook_active: false }), { code: 0, out: '', err: '' }, 'it never said it works: nothing to ask');
    assert.equal(JSON.parse(readFileSync(join(chat, 'pulse.json'), 'utf8')).busy, false);
    say('doing', 'writing chapter 2');
    const asked = stop({ stop_hook_active: false });
    assert.equal(asked.code, 0);
    assert.deepEqual(JSON.parse(asked.out), { decision: 'block', reason: `${STOP_CHECK} (it says: "writing chapter 2")` });
    assert.equal(JSON.parse(readFileSync(join(chat, 'pulse.json'), 'utf8')).busy, true, 'asked to go on: still in its turn');
    assert.deepEqual(stop({ stop_hook_active: true }), { code: 0, out: '', err: '' }, 'the second time: it stops');
    assert.equal(JSON.parse(readFileSync(join(chat, 'pulse.json'), 'utf8')).busy, false);
    say('status', 'done', 'chapter 2 written');
    assert.equal(stop({ stop_hook_active: false }).out, '', 'it said done: nothing to ask');
    say('doing', 'chapter 3'); say('ask', 'A title?', '--choice', 'yes', '--choice', 'no');
    assert.equal(stop({ stop_hook_active: false }).out, '', 'it asked them something: it waits');
    assert.equal(stop({}).out, '', 'what it asked is still the newest');
    assert.equal(run(['pulse', '--end', '--stop-check'], { env, cwd: work, stdin: () => 'not json' }).code, 0, 'what the hook gives is not trusted');
});

test('what it reads and what it tells say when its chat says nothing, or something old', (t) => {
    const work = folder(t); const chat = join(work, '.parley'); mkdirSync(chat);
    const app = new Parley(chat);
    const env = { PARLEY_DIR: '' };
    app.say('Translate the page.');
    assert.match(run(['read'], { env, cwd: work }).out, /\nWhen you start on it, say so: parley doing "what you do"; when you finish: parley status done\.\n/);
    run(['doing', 'translating'], { env, cwd: work });
    assert.equal(run(['tell', 'On it.'], { env, cwd: work }).out, 'Posted. They will read it on their screen.\n', 'just said: nothing more');
    /* Its last step, a while ago. */
    const lines = readFileSync(join(chat, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const old = new Date(Date.now() - 25 * 60_000).toISOString();
    writeFileSync(join(chat, 'from-agent.jsonl'), lines.map((l) => JSON.stringify(l.kind === 'doing' ? { ...l, at: old } : l)).join('\n') + '\n');
    assert.match(run(['tell', 'Halfway.'], { env, cwd: work }).out, /^Posted\. They will read it on their screen\.\nTheir screen still says you are working on "translating", since 25 min: say what you do now/);
});
