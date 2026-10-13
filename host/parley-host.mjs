/* THE OTHER SIDE OF THE BRIDGE: for the application that shows the exchange.
 *
 * The agent's side is parley-mcp.mjs. This is what an application uses to
 * read what the agent posted, to write what the person answers, and to tell
 * the agent that a message arrived. It knows nothing of screens (see ui/) and
 * nothing of how an agent is reached: the application gives it one function,
 * `nudge(line)`, which gets that line to the agent -- typed in its terminal,
 * most of the time.
 *
 * WHAT IS READ HERE WAS WRITTEN BY AN AGENT: text chosen by a program. It is
 * bounded, cleaned of what a screen obeys rather than shows, and handed over
 * as text. Showing it as text, never building it, is the application's part.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

export const TEXT_MAX = 4000;
export const SHOWN_MAX = 200;
export const FILE_MAX = 2 * 1024 * 1024;
export const STATES = ['working', 'waiting', 'done'];
const KINDS = ['say', 'ask', 'show', 'status'];
const SERVER = fileURLToPath(new URL('../server/parley-mcp.mjs', import.meta.url));

/* The two lines an agent is given. The first, once: what it is asked to do.
   The second, each time the person wrote: that a message arrived, and only
   that. What the person wrote is never put on this line. */
export const INVITE = 'From now on, use the tools of the MCP server named "parley" to talk with me: tell to tell me something, ask to ask me a question (do not ask it here), show to point me to a file, status to say where you are. When I tell you a message arrived, call read. Start now: call tell and say in one line that you are ready.';
export const ARRIVED = 'A message arrived for you: call the read tool of the "parley" server and act on it.';

// eslint-disable-next-line no-control-regex
const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const clean = (text, max = TEXT_MAX) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').slice(0, max);
const oneLine = (text, max) => clean(text, max).replace(/\s+/g, ' ').trim();

/* The lines of a file that only grows: the last part of it, never a link,
   never more than is wanted, and a line that is not an object is skipped. */
function lines(file) {
    try {
        if (lstatSync(file).isSymbolicLink() || statSync(file).size > 16 * FILE_MAX) return [];
        const text = readFileSync(file, 'utf8');
        return (text.length > FILE_MAX ? text.slice(-FILE_MAX) : text).split('\n').filter(Boolean)
            .flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' && !Array.isArray(j) ? [j] : []; } catch { return []; } });
    } catch { return []; }
}

/* Puts the bridge in `dir`: the agent's server and the two files. Resolves
   with how the server is declared to an agent. `as`: where that folder is
   seen FROM THE AGENT, when that is not the same path (a mounted folder). */
export function install(dir, { as = dir } = {}) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(SERVER, `${dir}/server.mjs`);
    for (const file of ['from-agent.jsonl', 'to-agent.jsonl']) if (!existsSync(`${dir}/${file}`)) writeFileSync(`${dir}/${file}`, '');
    return { name: 'parley', command: ['node', `${as}/server.mjs`] };
}

export class Parley {
    #dir; #nudge; #now;

    /* `nudge(line)`: gets one line to the agent; resolves true when it did. */
    constructor(dir, { nudge = async () => false, now = () => new Date() } = {}) { this.#dir = dir; this.#nudge = nudge; this.#now = now; }

    /* Both sides, in the order they were written; how many questions wait; where the agent says it is. */
    read() {
        const fromAgent = lines(`${this.#dir}/from-agent.jsonl`).map((m) => {
            const kind = KINDS.includes(m.kind) ? m.kind : 'say';
            return { from: 'agent', id: String(m.id ?? ''), at: String(m.at ?? ''), kind, text: clean(m.text),
                choices: kind === 'ask' && Array.isArray(m.choices) ? m.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [],
                ...(kind === 'show' ? { path: oneLine(m.path, 1000) } : {}),
                ...(kind === 'status' ? { state: STATES.includes(m.state) ? m.state : 'working' } : {}) };
        });
        const fromPerson = lines(`${this.#dir}/to-agent.jsonl`).map((m) => ({ from: 'person', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: 'say', text: clean(m.text), choices: [], ...(m.answers ? { answers: String(m.answers) } : {}) }));
        const answered = new Set(fromPerson.map((m) => m.answers).filter(Boolean));
        const last = fromAgent.filter((m) => m.kind === 'status').at(-1);
        return {
            messages: [...fromAgent.filter((m) => m.kind !== 'status'), ...fromPerson].sort((a, b) => a.at.localeCompare(b.at)).slice(-SHOWN_MAX),
            waiting: fromAgent.filter((m) => m.kind === 'ask' && !answered.has(m.id)).length,
            status: last ? { state: last.state, note: last.text, at: last.at } : null,
        };
    }

    /* The person writes. `answers`: the id of the question this answers. The agent is then told that a message arrived. */
    async say(text, answers) {
        const said = clean(text).trim();
        if (!said) throw new RangeError('Write something.');
        const entry = { id: randomUUID(), at: this.#now().toISOString(), text: said };
        if (typeof answers === 'string' && answers) {
            const asked = this.read().messages.find((m) => m.from === 'agent' && m.kind === 'ask' && m.id === answers);
            if (asked) { entry.answers = asked.id; entry.question = oneLine(asked.text, 300); }
        }
        appendFileSync(`${this.#dir}/to-agent.jsonl`, `${JSON.stringify(entry)}\n`);
        const told = await Promise.resolve(this.#nudge(ARRIVED)).then((r) => r !== false, () => false);
        return { ...this.read(), told };
    }

    /* Asks the agent, once it has been given the server, to use it. */
    async invite() { return Promise.resolve(this.#nudge(INVITE)).then((r) => r !== false, () => false); }
}

/* ---------- the two hooks ---------- */

/* TOWARDS THE AGENT. `nudge` is any function that gets one line to the agent.
   Two ready-made ones:

   byTmux    the agent runs in a tmux session: the line is typed there, then
             Enter. `prefix` is put before the command when tmux is not
             reached directly (a machine, a container): an argument vector.
   byCommand any program of yours: it receives the line as its last argument. */
const run = (argv) => new Promise((resolve) => { execFile(argv[0], argv.slice(1), { timeout: 30_000 }, (error) => resolve(!error)); });
export function byTmux({ target, socket, prefix = [] }) {
    const tmux = [...prefix, 'tmux', ...(socket ? ['-L', socket] : []), 'send-keys', '-t', target];
    return async (line) => (await run([...tmux, '-l', '--', line])) && run([...tmux, 'Enter']);
}
export const byCommand = (argv) => (line) => run([...argv, line]);

/* FROM THE AGENT. Calls `onMessage(message)` for each thing the agent posts
   from now on (a question to ring a phone for, a status to show somewhere).
   Resolves with a function that stops it. A file is looked at; nothing is
   pushed, so nothing is missed while nobody watches: `read()` has it all. */
export function watch(dir, onMessage, { every = 2000 } = {}) {
    const parley = new Parley(dir);
    const all = () => { const r = parley.read(); return [...r.messages.filter((m) => m.from === 'agent'), ...(r.status ? [{ from: 'agent', kind: 'status', id: `status@${r.status.at}`, at: r.status.at, state: r.status.state, text: r.status.note, choices: [] }] : [])]; };
    const seen = new Set(all().map((m) => m.id));
    const timer = setInterval(() => { for (const m of all()) if (!seen.has(m.id)) { seen.add(m.id); try { onMessage(m); } catch { /* a listener that fails does not stop the watch */ } } }, every);
    timer.unref?.();
    return () => clearInterval(timer);
}
