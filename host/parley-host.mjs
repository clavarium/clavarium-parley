/* THE OTHER SIDE OF THE BRIDGE: for the application that shows the exchange.
 *
 * The agent's side is server/parley-mcp.mjs (the `parley` command and the
 * MCP server). This is what an application uses to read what the agent
 * posted and to write what the person says. It knows nothing of screens
 * (see ui/), nothing of how an agent is reached, nor of how a person is
 * alerted.
 *
 * PARLEY ANNOUNCES, THE APPLICATION DECIDES.
 *
 *   events, to `on(event)`          actions, called by the application
 *   person-wrote  {message, unread} say(text, answers, files)
 *   agent-said    {message}         read(options)   (a part of the thread: last, days, before, since)
 *                                   search(text)    (the whole thread searched)
 *   agent-asked   {message}         invite(lang, options)  -> a text
 *   agent-showed  {message}
 *   agent-status  {message}
 *   agent-doing   {message}
 *   agent-closed  {message}         (a question it closed, answered another way)
 *   person-reacted {message, reaction, wakes, unread}   react(to, reaction)
 *   history-changed {altered}       (with a keep folder: a line kept changed or went)
 *
 * The pulse of the agent's tool (pulse.json) is not announced: read() gives it.
 *
 * Nothing is typed anywhere from here: when the person wrote, the
 * application is told so, with how many messages the agent has not read,
 * and decides whether, when and how to tell the agent (WAKE is the line it
 * may use). The invitation is a text it may use, or replace.
 *
 * WHAT IS READ HERE WAS WRITTEN BY AN AGENT: text chosen by a program. It is
 * bounded, cleaned of what a screen obeys rather than shows, and handed over
 * as text. Showing it as text, never building it, is the application's part.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TEXT_MAX = 16000;
/* The short version of a message: a title of one or two lines, shown cut beyond SHORT_MAX
   (at a word, with "…"). Kept whole up to SHORT_KEPT: an agent that wrote more than a title
   loses none of it -- the screen shows it all once the message is opened. */
export const SHORT_MAX = 200;
export const SHORT_KEPT = 1000;
/* Paths a message cites, looked up for the screen, at most. */
export const REFS_MAX = 20;
export const SHOWN_MAX = 200;
export const LISTED_MAX = 50;
/* Steps (what it said it was doing, and its states) kept for the screen. */
export const STEPS_MAX = 500;
export const FILE_MAX = 2 * 1024 * 1024;
/* A PART OF THE THREAD (read({ last | days | before | since })): the newest WINDOW messages
   by default, PAGE_MAX at most in one answer; a window of days holds LEAST messages at least
   (a quiet week is not an empty screen), DAYS_MAX days at most; a page opened at a message
   found starts CONTEXT messages before it. SEARCH_MAX messages found at most. */
export const WINDOW = 200;
export const PAGE_MAX = 2000;
export const LEAST = 20;
export const DAYS_MAX = 366;
export const CONTEXT = 3;
export const SEARCH_MAX = 100;
export const STATES = ['working', 'waiting', 'done'];
/* Files the person attaches to one message, at most. */
export const FILES_MAX = 10;
/* What the person wrote about one file they attached. */
export const NOTE_MAX = 500;
/* Files the agent shows at once, as one gallery. */
export const SHOW_MAX = 12;
/* THE REACTIONS a person may put on a message of the agent, by default: an
   id each (its words are in the dictionaries, "react-<id>"), and whether it
   should wake the agent -- a hint for the application, which decides:
   false (noted, read with the next message), true, or 'now' (even while it
   works). The screen draws each with its icon (ui/parley-ui.js). */
export const REACTIONS = Object.freeze([
    { id: 'agree', wakes: false }, { id: 'go', wakes: true }, { id: 'disagree', wakes: true }, { id: 'unclear', wakes: true },
    { id: 'stop', wakes: 'now' }, { id: 'redo', wakes: true }, { id: 'later', wakes: false }, { id: 'love', wakes: false },
].map(Object.freeze));
const REACTION_ID = /^[a-z][a-z0-9-]{0,29}$/;
const KINDS = ['say', 'ask', 'show', 'status', 'doing', 'close'];
/* Questions asked together: so many at most, each named by an id of this shape. */
const GROUP_MAX = 5;
const GROUP_ID = /^[A-Za-z0-9_-]{1,30}$/;
const STEP = new Set(['status', 'doing']);
const SERVER = fileURLToPath(new URL('../server/parley-mcp.mjs', import.meta.url));
const TEXTS = fileURLToPath(new URL('../ui/texts/', import.meta.url));

/* THE TEXTS AN AGENT READS are English: models read it best, and one text is
   one text to check. The person's language is said in it. They are typed in
   a terminal, where a shell may be listening instead of an agent: no
   backquote, no single quote, nothing a shell would run or wait on. */
export const WAKE = 'You have a new message: run "parley read".';
/* What an application may type after the agent lost its memory (its machine
   restarted, a new session): the exchange is still there to be read whole. */
/* It reads THE END of the thread (the newest messages, or those of the last days), and is told
   there how to read further back: the thread is never cut, summarised nor compacted. */
export const REREAD_LAST = 100;
export function reread({ last, days } = {}) {
    const how = Number.isInteger(days) && days > 0 ? `--days ${Math.min(days, DAYS_MAX)}` : `--last ${Number.isInteger(last) && last > 0 ? Math.min(last, 1000) : REREAD_LAST}`;
    return `Your chat with the person is kept: run "parley read ${how}" before going on; it says how to read further back. Forgot how to work with them? parley guide`;
}
export const REREAD = reread();
const NAMES = { en: 'English', fr: 'French' };
/* The name of a language, in English, for a sentence an agent reads. */
export function languageName(lang) {
    const tag = String(lang ?? '').trim();
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(tag)) return 'English';
    const base = tag.split('-')[0].toLowerCase();
    if (NAMES[base]) return NAMES[base];
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(base) ?? 'English'; } catch { return 'English'; }
}
/* What an agent is asked once, to use Parley. `install`: how it gets the
   command, when the application has not installed it itself (a command
   line of the application's: it is put in double quotes as it is); without
   it, the agent is told Parley is installed. `shared`: the folder
   whose files the person can open. */
export function invitation({ lang = 'en', install, shared } = {}) {
    return [
        install ? `Install Parley, a small command to talk with the person you work for on their screen: run "${install}", then read "parley --help".` : 'Parley is installed: run "parley --help". It is how you talk with the person you work for, on their screen.',
        'From now on, talk with them through it, not in this terminal: "parley tell" to tell them something, "parley ask" to ask them something (with the choices when you can), "parley show" for a file you made, "parley doing" in one short line each time you start something new, "parley status" to say where you are.',
        shared ? `Put any file you show under ${shared}: it is the folder they can open.` : '',
        `Write to them in ${languageName(lang)}.`,
        'When you see "You have a new message", run "parley read".',
        'Forgot how to work with them? parley guide',
        'Start now: tell them in one line that you are ready.',
    ].filter(Boolean).join(' ');
}

/* THE WORDS A PERSON READS: one dictionary per language (ui/texts/<lang>.json);
   a word missing there is the English one; `own`, a dictionary of the
   application's or its operator's, whole or partial, replaces any word,
   whatever it says. They are always shown as text, never as markup. */
const dictionary = (lang) => { try { const d = JSON.parse(readFileSync(`${TEXTS}${lang}.json`, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
export const LANGUAGES = Object.freeze(readdirSync(TEXTS).filter((f) => /^[a-z]{2,3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort());
export function texts(lang, own) {
    const base = String(lang ?? '').toLowerCase().split('-')[0];
    const words = { ...dictionary('en'), ...(LANGUAGES.includes(base) && base !== 'en' ? dictionary(base) : {}) };
    if (own && typeof own === 'object' && !Array.isArray(own)) {
        for (const [key, value] of Object.entries(own)) if (Object.hasOwn(words, key) && typeof value === 'string') words[key] = value.slice(0, 500);
    }
    return { ...words, lang: LANGUAGES.includes(base) ? base : 'en' };
}
/* A word with its {places} filled, as text. */
export const fill = (word, values = {}) => String(word ?? '').replace(/\{([a-z]+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));

// eslint-disable-next-line no-control-regex
const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const clean = (text, max = TEXT_MAX) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').slice(0, max);
const oneLine = (text, max) => clean(text, max).replace(/\s+/g, ' ').trim();
/* What a message is about, when the person tapped it on the screen: a person
   of a family, a zone of a picture. Its label, the application's ref as it was
   written (opaque), the picture, and the zone as fractions of it. */
export function aboutOf(about) {
    if (!about || typeof about !== 'object') return undefined;
    const label = oneLine(about.label, 120);
    if (!label) return undefined;
    const ref = oneLine(about.ref, 300);
    const picture = oneLine(about.picture, 1000);
    const box = Array.isArray(about.box) && about.box.length === 4 && about.box.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) ? about.box.map((n) => Math.round(n * 1000) / 1000) : null;
    return { label, ...(ref ? { ref } : {}), ...(picture.startsWith('/') ? { picture } : {}), ...(box ? { box } : {}) };
}
const cutQ = (text) => { const line = oneLine(text, 400); return line.length > 60 ? `${line.slice(0, 59)}…` : line; };
/* THE PATHS A MESSAGE CITES: a whole path standing on its own (after a space,
   a bracket, a quote) or the target of a Markdown link or picture. Each is
   looked up by the application's `reach`: the screen makes a link (or shows a
   picture) of those it can open, and of nothing else. */
const CITED = /(?:^|[\s([<"'`*_])(\/[^\s()[\]<>"'`*]+)/g;
const TARGET = /\]\((\/[^\s()]+)(?:\s+"[^"]*")?\)/g;
export function cited(text) {
    const out = new Set();
    for (const re of [TARGET, CITED]) for (const m of String(text ?? '').matchAll(re)) {
        const path = m[1].replace(/[.,;:!?]+$/, '');
        if (path.length > 1 && path.length <= 1000 && !path.startsWith('//')) out.add(path);
        if (out.size >= REFS_MAX) return [...out];
    }
    return [...out];
}
const parsed = (line) => { try { const j = JSON.parse(line); return j && typeof j === 'object' && !Array.isArray(j) ? j : undefined; } catch { return undefined; } };

/* How many whole lines the agent has read, as it wrote it. */
function readCount(dir) { try { return Math.max(0, Number(JSON.parse(readFileSync(`${dir}/read.json`, 'utf8')).lines) || 0); } catch { return 0; } }
/* When the agent read, as it wrote it: [{ lines, at }], oldest first. */
function readTimes(dir) { try { const r = JSON.parse(readFileSync(`${dir}/read.json`, 'utf8')).reads; return Array.isArray(r) ? r.filter((x) => x && Number.isInteger(x.lines) && typeof x.at === 'string') : []; } catch { return []; } }
/* The pulse the agent's tool wrote: {busy, at}, or null. Small, never through a link; a time
   in the future is taken as now (clocks of two machines differ). */
function pulseOf(dir, now) {
    const file = `${dir}/pulse.json`;
    try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > 1024) return null;
        const p = JSON.parse(readFileSync(file, 'utf8'));
        const t = Date.parse(p?.at);
        if (!p || typeof p.busy !== 'boolean' || typeof p.at !== 'string' || !Number.isFinite(t)) return null;
        return { busy: p.busy, at: new Date(Math.min(t, now.getTime())).toISOString() };
    } catch { return null; }
}
/* THE WHOLE LINES OF A BRIDGE FILE, parsed, in place: a line that is not an object
   stays as `undefined`, so that a line keeps its place (a cursor counts places). A
   line not ended yet waits, unless it reads whole. Read again only when the file changed; never through a link. */
const WHOLE = new Map();
function wholeLines(file) {
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile() || st.size > 16 * FILE_MAX) return [];
        const stamp = statOf(st);
        const known = WHOLE.get(file);
        if (known?.stamp === stamp) return known.list;
        const text = readFileSync(file, 'utf8');
        const end = text.lastIndexOf('\n') + 1;
        const list = text.slice(0, end).split('\n').filter(Boolean).map(parsed);
        /* A last line with no end yet is taken once it reads whole (a hand-written file); never in part. */
        const rest = parsed(text.slice(end));
        if (rest) list.push(rest);
        WHOLE.set(file, { stamp, list });
        return list;
    } catch { return []; }
}
/* The lines kept, parsed in place: the copy only grows, so only what is new is parsed. */
const PARSED = new Map();
function parsedOf(key, raw) {
    const known = PARSED.get(key);
    if (known && raw.length >= known.n && (known.n === 0 || raw[known.n - 1] === known.last)) {
        if (raw.length > known.n) { known.list = [...known.list, ...raw.slice(known.n).map(parsed)]; known.n = raw.length; known.last = raw.at(-1); }
        return known.list;
    }
    const entry = { n: raw.length, last: raw.at(-1), list: raw.map(parsed) };
    PARSED.set(key, entry);
    return entry.list;
}
function lineCount(file) { try { if (lstatSync(file).isSymbolicLink()) return 0; return readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }

/* THE APPLICATION'S OWN COPY: `keep`, a folder the agent cannot reach. The
   bridge folder is the agent's own: it can rewrite any line there, the
   person's too, and a screen that reads only that folder would show the new
   words as if they had always been said. With a keep folder, each line is
   copied there once it is whole and read (the agent's), or as it is written
   (the person's: this side writes them, so a line of theirs that this side
   did not write is no line of theirs). What is kept is what is shown. A line
   kept that changed or went from the bridge folder, or one slipped in among
   lines already kept, is noted once, with when it was noticed. Nothing kept
   is rewritten: a correction is a new line. */
const KEPT = new Map();
const statOf = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
const keptStat = (file) => { try { return statOf(statSync(file)); } catch { return null; } };
/* A file of the keep folder: { lines, ids, seen }, or null when there is none yet. Read once,
   then from memory while the file is as this process left it. `seen`: how the bridge file
   was when last compared, so that a bridge file that did not move is not read again. */
function kept(file) {
    const stamp = keptStat(file);
    if (stamp === null) { KEPT.delete(file); return null; }
    const known = KEPT.get(file);
    if (known?.stamp === stamp) return known;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return null; }
    const entry = { stamp, lines: text.split('\n').filter(Boolean), ids: null, seen: null };
    KEPT.set(file, entry);
    return entry;
}
function keep(file, add, { whole = false } = {}) {
    const before = whole ? null : kept(file);
    if (whole) writeFileSync(file, add.map((l) => `${l}\n`).join(''));
    else if (add.length) appendFileSync(file, add.map((l) => `${l}\n`).join(''));
    const entry = { stamp: keptStat(file), lines: [...(before?.lines ?? []), ...add], ids: null, seen: before?.seen ?? null };
    KEPT.set(file, entry);
    return entry;
}
const idsOf = (entry) => (entry.ids ??= new Set(entry.lines.map(idOf).filter(Boolean)));
/* The whole lines of a bridge file, as written (a line not ended yet waits): none when it is
   gone, or is a link (all it held is gone from there); null when too big to compare, or when
   it is as it was when last compared (`seen`). */
function bridgeLines(file, seen) {
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) return seen === 'none' ? null : { lines: [], stamp: 'none' };
        const stamp = statOf(st);
        if (stamp === seen || st.size > 16 * FILE_MAX) return null;
        const text = readFileSync(file, 'utf8');
        return { lines: text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean), stamp };
    } catch { return seen === 'none' ? null : { lines: [], stamp: 'none' }; }
}
const idOf = (line) => { const id = parsed(line)?.id; return typeof id === 'string' ? id : ''; };
const atOf = (line) => { const at = parsed(line)?.at; return typeof at === 'string' ? at : ''; };
const hashOf = (line) => createHash('sha256').update(line).digest('hex').slice(0, 16);
/* What changed in a bridge file, against what is kept of it: the lines kept that are not
   there in their order any more (`lost`, by place; `changed` when a line of the same id
   stands there instead), the lines that are new at its end (`fresh`, taken: the agent's
   side only), and the lines that are neither (`added`: slipped in, or the person's that
   this side never wrote). A line kept is found again in order, even after a line before it
   went: what follows it is still in place. */
function compare(entry, now, { takes }) {
    const lines = entry.lines, ids = idsOf(entry);
    const out = { lost: [], changed: new Set(), fresh: [], added: [] };
    let from = lines.length;
    if (!(now.length >= lines.length && lines.every((l, i) => now[i] === l))) {
        const where = new Map();
        now.forEach((l, k) => { if (!where.has(l)) where.set(l, []); where.get(l).push(k); });
        const used = new Set();
        let j = 0;
        lines.forEach((l, i) => { const k = where.get(l)?.find((x) => x >= j); if (k === undefined) out.lost.push(i); else { used.add(k); j = k + 1; } });
        const lostIds = new Map(out.lost.map((i) => [idOf(lines[i]), i]).filter(([id]) => id));
        now.forEach((l, k) => {
            if (used.has(k) || k >= j) return;
            const id = idOf(l);
            if (lostIds.has(id)) out.changed.add(lostIds.get(id)); else out.added.push(l);
        });
        from = j;
        for (const l of now.slice(from)) { const id = idOf(l); if (lostIds.has(id)) { out.changed.add(lostIds.get(id)); continue; } (takes && !(id && ids.has(id)) ? out.fresh : out.added).push(l); }
        return out;
    }
    /* Only grown: what is new is the agent's; a line repeating the id of one kept is not new. */
    for (const l of now.slice(from)) { const id = idOf(l); (takes && !(id && ids.has(id)) ? out.fresh : out.added).push(l); }
    return out;
}

/* Puts the bridge in `dir`: the two files, and the MCP server for an agent
   that is given it that way. Resolves with how that server is declared to an
   agent. `as`: where that folder is seen FROM THE AGENT, when that is not
   the same path (a mounted folder). */
export function install(dir, { as = dir } = {}) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(SERVER, `${dir}/server.mjs`);
    for (const file of ['from-agent.jsonl', 'to-agent.jsonl']) if (!existsSync(`${dir}/${file}`)) writeFileSync(`${dir}/${file}`, '');
    return { name: 'parley', command: ['node', `${as}/server.mjs`] };
}

export class Parley {
    #dir; #on; #reach; #now; #reactions; #keep;

    /* `on(event)`: told what happens (see the top of this file).
       `reach(path)`: how the person opens a file the agent showed -- a
       reference of the application's (a link, a path) or null when it
       cannot be opened from their screen. Every path, by default. */
    /* `reactions`: the set offered, [{ id, wakes }] (REACTIONS by default). */
    /* `keep`: a folder of the application's, out of the agent's reach, where
       the thread is kept as it was read (see THE APPLICATION'S OWN COPY);
       one per bridge folder. Without it, the bridge folder is all there is. */
    constructor(dir, { on, reach = (path) => path, now = () => new Date(), reactions = REACTIONS, keep } = {}) {
        this.#dir = dir; this.#on = on; this.#reach = reach; this.#now = now; this.#keep = typeof keep === 'string' && keep ? keep : null;
        this.#reactions = (Array.isArray(reactions) ? reactions : REACTIONS).filter((r) => r && REACTION_ID.test(r.id));
    }

    #tell(event) { try { this.#on?.(event); } catch { /* a hook that fails stops nothing */ } }

    /* How the person opens a file, or null. */
    #open(path) { try { const r = this.#reach(path); return typeof r === 'string' && r ? r : null; } catch { return null; } }

    /* One line the agent wrote, as it is handed over. */
    #fromAgent(m) {
        const kind = KINDS.includes(m.kind) ? m.kind : 'say';
        const entry = { from: 'agent', id: String(m.id ?? ''), at: String(m.at ?? ''), kind, text: clean(m.text), choices: kind === 'ask' && Array.isArray(m.choices) ? m.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [] };
        if ((kind === 'say' || kind === 'ask') && typeof m.short === 'string' && oneLine(m.short, SHORT_KEPT)) entry.short = oneLine(m.short, SHORT_KEPT);
        /* Several of its choices may be ticked, sent together. */
        if (kind === 'ask' && m.many === true && entry.choices.length > 1) entry.many = true;
        /* Several questions at once, one card: each well formed, ids unique; fewer than two, none (the text says them). */
        if (kind === 'ask' && Array.isArray(m.questions)) {
            const ids = new Set();
            const list = m.questions.slice(0, GROUP_MAX).filter((q) => q && typeof q === 'object' && typeof q.id === 'string' && GROUP_ID.test(q.id) && !ids.has(q.id) && ids.add(q.id)).map((q) => {
                const choices = Array.isArray(q.choices) ? q.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [];
                return { id: q.id, label: oneLine(q.label, 40), question: clean(q.question).slice(0, 1000).trim(), choices, ...(q.many === true && choices.length > 1 ? { many: true } : {}) };
            }).filter((q) => q.question);
            if (list.length > 1) { entry.questions = list; entry.choices = []; if (typeof m.intro === 'string' && clean(m.intro).trim()) entry.intro = clean(m.intro).slice(0, 2000).trim(); }
        }
        if (kind === 'say' || kind === 'ask') {
            /* The paths it cites that the person can open: a link, or a picture, on the screen. */
            const refs = cited(`${entry.text}\n${entry.short ?? ''}`).map((path) => ({ path, open: this.#open(path) })).filter((r) => r.open !== null);
            if (refs.length) entry.refs = refs;
        }
        if (kind === 'show') {
            entry.path = oneLine(m.path, 1000); entry.open = this.#open(entry.path);
            /* Several at once: one gallery, each with its title. */
            if (Array.isArray(m.files) && m.files.length) entry.files = m.files.slice(0, SHOW_MAX).filter((f) => f && typeof f === 'object').map((f) => { const path = oneLine(f.path, 1000); return { path, title: oneLine(f.title, 120), open: this.#open(path) }; }).filter((f) => f.path);
        }
        if (kind === 'status') entry.state = STATES.includes(m.state) ? m.state : 'working';
        if (kind === 'doing') { entry.text = oneLine(m.text, 200); entry.state = 'working'; }
        if (kind === 'close') { entry.text = oneLine(m.text, 500); entry.answers = oneLine(m.answers, 100); }
        return entry;
    }

    /* The files of a message of the person, as handed over: each opened by
       the application's own way (`reach`), like a file the agent showed. */
    #files(list) {
        return list.slice(0, FILES_MAX).filter((f) => f && typeof f === 'object').map((f) => {
            const path = oneLine(f.path, 1000);
            const open = this.#open(path);
            return { path, name: oneLine(f.name, 200) || path.split('/').pop(), size: Number.isInteger(f.size) && f.size >= 0 ? f.size : null, open, ...(oneLine(f.note, NOTE_MAX) ? { note: oneLine(f.note, NOTE_MAX) } : {}) };
        });
    }

    /* With a keep folder: compares one bridge file with what is kept of it,
       keeps what is new (the agent's lines only: the person's are kept as
       they are written), notes once what changed (history-changed), and gives
       the lines kept, as written. */
    #sync(name) {
        const own = `${this.#keep}/${name}`;
        let entry = kept(own);
        if (entry === null) {
            /* First sight: the bridge is taken as it is (a thread begun before it was kept). */
            mkdirSync(this.#keep, { recursive: true });
            const now = bridgeLines(`${this.#dir}/${name}`);
            entry = keep(own, now?.lines ?? [], { whole: true });
            entry.seen = now?.stamp ?? null;
            return entry.lines;
        }
        const now = bridgeLines(`${this.#dir}/${name}`, entry.seen);
        if (now === null) return entry.lines;
        const side = name === 'from-agent.jsonl' ? 'agent' : 'person';
        const found = compare(entry, now.lines, { takes: side === 'agent' });
        if (found.fresh.length) entry = keep(own, found.fresh);
        entry.seen = now.stamp;
        const at = this.#now().toISOString();
        const notes = [
            ...found.lost.map((i) => ({ key: `${side}:${i}`, side, kind: found.changed.has(i) ? 'changed' : 'gone', line: i + 1, id: idOf(entry.lines[i]), was: atOf(entry.lines[i]), at })),
            ...found.added.map((l) => ({ key: `${side}+${hashOf(l)}`, side, kind: 'added', line: null, id: idOf(l), was: atOf(l), at })),
        ];
        if (notes.length) this.#note(notes);
        return entry.lines;
    }
    /* Each change noted once, in the keep folder: what the screen says, where it happened. */
    #note(notes) {
        const file = `${this.#keep}/altered.jsonl`;
        const known = new Set((kept(file)?.lines ?? []).map((l) => parsed(l)?.key));
        const added = notes.filter((n) => !known.has(n.key) && known.add(n.key));
        if (!added.length) return;
        keep(file, added.map((n) => JSON.stringify(n)));
        this.#tell({ type: 'history-changed', altered: added.map(({ key, ...n }) => n) });
    }
    /* What was noted: [{side, kind, line, id, was, at}], oldest first. */
    #altered() { return (kept(`${this.#keep}/altered.jsonl`)?.lines ?? []).map(parsed).filter(Boolean).map(({ key, ...n }) => n); }
    /* A line of the person's, written: kept first, so that a bridge refusing it says so. */
    #write(list) {
        const text = list.map((l) => JSON.stringify(l));
        if (this.#keep) { this.#sync('to-agent.jsonl'); keep(`${this.#keep}/to-agent.jsonl`, text); }
        mkdirSync(this.#dir, { recursive: true });
        appendFileSync(`${this.#dir}/to-agent.jsonl`, text.map((l) => `${l}\n`).join(''));
    }

    /* How many messages of the person the agent has not read. */
    unread() { return Math.max(0, (this.#keep ? this.#sync('to-agent.jsonl').length : lineCount(`${this.#dir}/to-agent.jsonl`)) - readCount(this.#dir)); }

    /* The lines of one side, parsed in place (see wholeLines): the copy kept, with a keep
       folder; the bridge file, without. Their places are what a cursor counts. */
    #raw(name) { return this.#keep ? parsedOf(`${this.#keep}/${name}`, this.#sync(name)) : wholeLines(`${this.#dir}/${name}`); }

    /* THE WHOLE THREAD, as handed over: every message of both sides in order, every step,
       what is open, where it is. What read() gives is a part of it; nothing is left out
       of what is counted (the questions open, the status, the files, the unread). */
    #model() {
        const fromRaw = this.#raw('from-agent.jsonl');
        const toRaw = this.#raw('to-agent.jsonl');
        /* Where each message stands in its file: what a cursor compares. */
        const place = new WeakMap();
        const all = [];
        fromRaw.forEach((m, i) => { if (!m) return; const e = this.#fromAgent(m); place.set(e, i); all.push(e); });
        const agent = all.filter((m) => m.kind !== 'close');
        const closes = new Map(all.filter((m) => m.kind === 'close').map((m) => [m.answers, { text: m.text, at: m.at }]));
        const read = Math.min(readCount(this.#dir), toRaw.length);
        const unread = Math.max(0, toRaw.length - readCount(this.#dir));
        /* When each of the person's messages was read: the first read that reached it. */
        const reads = readTimes(this.#dir);
        const seenAt = (i) => reads.find((r) => r.lines > i)?.at ?? null;
        /* A reaction is no message: it is put on the message it is about, the newest one standing. */
        const reactions = new Map();
        toRaw.forEach((m, i) => {
            if (!m || typeof m.reaction !== 'string' || typeof m.to !== 'string') return;
            if (m.removed === true) { if (reactions.get(m.to)?.id === m.reaction) reactions.delete(m.to); return; }
            reactions.set(m.to, { id: oneLine(m.reaction, 30), at: String(m.at ?? ''), seen: i < toRaw.length - unread });
        });
        const person = [];
        toRaw.forEach((m, i) => {
            if (!m || typeof m.reaction === 'string') return;
            const seen = i < toRaw.length - unread;
            const e = { from: 'person', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: 'say', text: clean(m.text), choices: [], seen, ...(seen && seenAt(i) ? { seenAt: seenAt(i) } : {}),
                ...(m.answers ? { answers: String(m.answers), question: oneLine(m.question, 300) } : {}), ...(m.answers && Array.isArray(m.picked) ? { picked: m.picked.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) } : {}),
                ...(m.answers && Array.isArray(m.replies) ? { replies: m.replies.slice(0, GROUP_MAX).filter((r) => r && typeof r === 'object' && typeof r.id === 'string').map((r) => ({ id: oneLine(r.id, 30), ...(oneLine(r.label, 40) ? { label: oneLine(r.label, 40) } : {}), ...(Array.isArray(r.picked) ? { picked: r.picked.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) } : { text: clean(r.text).slice(0, 2000) }) })) } : {}), ...(m.re ? { re: String(m.re), quote: oneLine(m.quote, 300) } : {}), ...(Array.isArray(m.files) && m.files.length ? { files: this.#files(m.files) } : {}), ...(m.via === 'voice' ? { via: 'voice' } : {}), ...(aboutOf(m.about) ? { about: aboutOf(m.about) } : {}) };
            place.set(e, i);
            person.push(e);
        });
        for (const m of agent) if (reactions.has(m.id)) m.reaction = reactions.get(m.id);
        const answered = new Set(person.map((m) => m.answers).filter(Boolean));
        /* A question it closed says the answer it understood; answered with its buttons after that, the answer is the person's. */
        for (const m of agent) if (m.kind === 'ask' && closes.has(m.id)) m.closed = closes.get(m.id);
        const messages = [...agent.filter((m) => !STEP.has(m.kind)), ...person].sort((a, b) => a.at.localeCompare(b.at));
        const steps = agent.filter((m) => STEP.has(m.kind));
        const last = steps.filter((m) => m.kind === 'status').at(-1);
        const after = steps.at(-1)?.kind === 'doing' && last?.state !== 'working';
        /* Every file it showed, and every one it cited that can be opened. */
        const shown = agent.filter((m) => m.kind === 'show').flatMap((m) => (m.files?.length ? m.files.map((f) => ({ path: f.path, note: f.title || m.text, at: m.at, open: f.open })) : [{ path: m.path, note: m.text, at: m.at, open: m.open }]));
        const named = new Set(shown.map((f) => f.path));
        const cites = agent.flatMap((m) => (m.refs ?? []).map((r) => ({ path: r.path, note: '', at: m.at, open: r.open, cited: true }))).filter((f) => !named.has(f.path) && named.add(f.path));
        return {
            all, messages, steps, place, read, unread, fromN: fromRaw.length, toN: toRaw.length, toRaw,
            open: agent.filter((m) => m.kind === 'ask' && !answered.has(m.id) && !closes.has(m.id)),
            status: after ? { state: 'working', note: '', at: steps.at(-1).at } : last ? { state: last.state, note: last.text, at: last.at } : null,
            files: [...shown, ...cites].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-LISTED_MAX),
        };
    }
    /* A step, as handed over. */
    static #step(m) { return { id: m.id, kind: m.kind, state: m.state, note: m.text, at: m.at }; }
    /* What is the same whatever part of the thread is asked for. */
    #state(t) { return { waiting: t.open.length, status: t.status }; }

    /* Both sides, in the order they were written; how many questions wait;
       where the agent says it is; its steps -- every state it said and every
       line of what it was doing, in order, for the screen to put between the
       messages; the files it showed; how many of the person's messages it has
       not read (each says `seen`). Saying what it does means it works: a
       `doing` after "done" or "waiting" makes the status "working" again.

       Without options: the newest SHOWN_MAX messages, as it always was. With
       them, A PART OF THE THREAD (see WINDOW in the protocol): the files on disk
       stay whole, only what is handed over changes.
         { last: N }            the newest N messages (WINDOW by default, PAGE_MAX at most)
         { days: D }            those of the last D days, LEAST at least
         { before, last|days }  the same, older than the message `before` (an earlier page)
         { before, from }       from the message `from` (and CONTEXT before it) up to `before`
         { all: true }          every message: for the application's own use, not for a screen
         { since, last|days }   what changed since `cursor` (`since: true`): new messages, those
                                whose state moved (read, reacted to, closed), new steps; a
                                cursor that does not fit any more gives the window again
       Each gives `window` ({ before, more, total, from, until }: the id that asks for the
       page before it, how many messages are older) and `cursor`. The questions still open
       come with the newest window whatever their age: they are open. */
    read(options) {
        const o = options && typeof options === 'object' && ['last', 'days', 'before', 'from', 'since', 'all'].some((k) => options[k] !== undefined && options[k] !== null && options[k] !== false) ? options : null;
        /* Nothing written on either side, nothing read since the cursor: nothing to go through. */
        if (o?.since !== undefined && o.since !== null) {
            const toN = this.#raw('to-agent.jsonl').length;
            const now = `${this.#raw('from-agent.jsonl').length}.${toN}.${Math.min(readCount(this.#dir), toN)}`;
            if (String(o.since) === now) return { since: true, messages: [], steps: [], unread: Math.max(0, toN - readCount(this.#dir)), pulse: pulseOf(this.#dir, this.#now()), ...(this.#keep ? { altered: this.#altered() } : {}), cursor: now };
        }
        const t = this.#model();
        const tail2 = { files: t.files, unread: t.unread, pulse: pulseOf(this.#dir, this.#now()), ...(this.#keep ? { altered: this.#altered() } : {}) };
        if (!o) {
            const messages = t.messages.slice(-SHOWN_MAX);
            /* Steps older than the first message kept would sit before a conversation that is no longer there. */
            const since = messages.length === SHOWN_MAX ? messages[0].at : '';
            return { messages, ...this.#state(t), steps: t.steps.filter((m) => m.at >= since).sort((a, b) => a.at.localeCompare(b.at)).slice(-STEPS_MAX).map(Parley.#step), ...tail2 };
        }
        const cursor = `${t.fromN}.${t.toN}.${t.read}`;
        const was = o.since === undefined || o.since === null ? null : /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(o.since));
        /* Only grown since: what is new, and what it changed. A file that shrank (a bridge rewritten, without a keep folder): the window again. */
        if (was && Number(was[1]) <= t.fromN && Number(was[2]) <= t.toN && Number(was[3]) <= t.read) {
            const [a, p, r] = [Number(was[1]), Number(was[2]), Number(was[3])];
            const touched = new Set([
                ...t.all.filter((m) => m.kind === 'close' && t.place.get(m) >= a).map((m) => m.answers),
                ...t.toRaw.slice(p).filter((m) => m && typeof m.reaction === 'string' && typeof m.to === 'string').map((m) => m.to),
            ]);
            const changed = (m) => {
                const at = t.place.get(m);
                if (m.from === 'person') return at >= p || (at >= r && at < t.read);
                return at >= a || touched.has(m.id);
            };
            return { since: true, messages: t.messages.filter(changed), ...this.#state(t), steps: t.steps.filter((m) => t.place.get(m) >= a).slice(-STEPS_MAX).map(Parley.#step),
                ...(a < t.fromN ? { files: t.files } : {}), unread: tail2.unread, pulse: tail2.pulse, ...(this.#keep ? { altered: tail2.altered } : {}), cursor };
        }
        const list = t.messages;
        let end = list.length;
        let until = null;
        if (o.before !== undefined && o.before !== null) {
            const i = list.findIndex((m) => m.id === String(o.before));
            end = i < 0 ? 0 : i;
            until = i < 0 ? null : list[i].at;
        }
        const count = (n, d) => (Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_MAX) : d);
        let start;
        if (o.all === true) start = 0;
        else if (o.from !== undefined && o.from !== null && o.before !== undefined && o.before !== null) {
            const j = list.findIndex((m) => m.id === String(o.from));
            start = j >= 0 && j < end ? Math.max(0, j - CONTEXT) : end;
        } else if (o.days !== undefined && o.days !== null && o.last === undefined) {
            const days = Math.min(DAYS_MAX, Math.max(1, Number(o.days) || 1));
            const ref = until !== null && Number.isFinite(Date.parse(until)) ? Date.parse(until) : this.#now().getTime();
            const limit = new Date(ref - days * 86_400_000).toISOString();
            start = end;
            while (start > 0 && list[start - 1].at >= limit) start -= 1;
            start = Math.max(Math.min(start, end - LEAST), end - PAGE_MAX, 0);
        } else start = Math.max(0, end - count(Number(o.last), WINDOW));
        const page = list.slice(start, end);
        /* The newest window: the questions still open come with it, however old. */
        const extra = o.before === undefined || o.before === null ? t.open.filter((q) => !page.includes(q) && list.indexOf(q) < start) : [];
        const fromAt = page[0]?.at ?? null;
        const steps = t.steps.filter((m) => (start === 0 || fromAt === null || m.at >= fromAt) && (until === null || m.at < until)).sort((a, b) => a.at.localeCompare(b.at)).slice(-STEPS_MAX).map(Parley.#step);
        return { messages: [...extra, ...page], ...this.#state(t), steps, ...tail2,
            window: { before: start > 0 ? page[0]?.id ?? null : null, more: page.length ? start : 0, total: list.length, from: fromAt, until }, cursor };
    }

    /* THE WHOLE THREAD SEARCHED, however little of it is shown: the messages whose words hold
       `text` (case aside; what Markdown marks aside), newest first, SEARCH_MAX at most, each
       with a few words around what was found; `count`, all of them. */
    search(text, { limit = SEARCH_MAX } = {}) {
        const q = oneLine(text, 200).toLowerCase();
        if (!q) return { matches: [], count: 0 };
        const words = (m) => [m.text, m.short, m.intro, m.kind === 'show' ? m.path : '', ...(m.files ?? []).map((f) => [f.title, f.name, f.path].filter(Boolean).join(' ')), ...(m.questions ?? []).map((x) => [x.question, ...x.choices].join(' ')), ...(m.choices ?? [])]
            .filter(Boolean).join('\n').replace(/\*\*|__|`|==/g, '');
        const found = this.#model().messages.map((m) => ({ m, w: words(m) })).filter((x) => x.w.toLowerCase().includes(q));
        const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_MAX) : SEARCH_MAX;
        return {
            matches: found.slice(-max).reverse().map(({ m, w }) => {
                const at = w.toLowerCase().indexOf(q);
                const from = Math.max(0, at - 40);
                return { id: m.id, at: m.at, from: m.from, kind: m.kind, text: `${from > 0 ? '…' : ''}${w.slice(from, at + q.length + 60).replace(/\s+/g, ' ').trim()}${at + q.length + 60 < w.length ? '…' : ''}` };
            }),
            count: found.length,
        };
    }

    /* The person writes. `answers`: the id of the question this answers.
       `files`: what they attached, put where the agent can open them by the
       application ({ path, name?, size? }: `path` as the agent sees it); a
       message may be files alone. `picked`: the choices ticked, for a question
       that lets several be ticked (`many`); the text, when empty, says them,
       one per line, for an agent that reads the text alone. `about`: what
       they tapped to say it (aboutOf). The application is told (person-wrote),
       and decides how to tell the agent. */
    say(text, answers, files = [], { via, picked, replies, about } = {}) {
        const given = Array.isArray(files) ? files : [];
        if (given.length > FILES_MAX) throw new RangeError(`${FILES_MAX} files at most in one message.`);
        const attached = given.map((f) => ({ path: oneLine(f?.path, 1000), name: oneLine(f?.name, 200), size: Number.isInteger(f?.size) && f.size >= 0 ? f.size : undefined, note: oneLine(f?.note, NOTE_MAX) }));
        if (attached.some((f) => !f.path.startsWith('/'))) throw new RangeError('A file is given by its whole path.');
        /* Any message of the thread, however old: not only those a screen shows at first. */
        const asked = typeof answers === 'string' && answers ? this.#model().messages.find((m) => m.from === 'agent' && ['say', 'ask', 'show'].includes(m.kind) && m.id === answers) : undefined;
        /* Ticked: only choices of a question that lets several be ticked, kept in its order. */
        let ticked;
        if (picked !== undefined) {
            if (asked?.kind !== 'ask' || !asked.many || !Array.isArray(picked)) throw new RangeError('Choices are ticked only for a question that lets several be ticked.');
            ticked = asked.choices.filter((c) => picked.includes(c));
            if (ticked.length === 0 || picked.some((c) => !asked.choices.includes(c))) throw new RangeError('Tick one of its choices at least, and only its choices.');
        }
        /* Questions asked together: one answer each, by its id -- choices it has (one, or several where
           it says many), or their own words; every one answered. Kept in the order asked. */
        let answered;
        if (replies !== undefined) {
            const qs = asked?.kind === 'ask' && Array.isArray(asked.questions) ? asked.questions : null;
            if (!qs || !Array.isArray(replies)) throw new RangeError('Answers by question are only for questions asked together.');
            const byId = new Map();
            for (const r of replies) {
                const q = qs.find((x) => x.id === r?.id);
                if (!q) throw new RangeError(`No question has the id ${oneLine(r?.id, 30)}.`);
                if (byId.has(q.id)) throw new RangeError(`Two answers to ${q.id}.`);
                const chosen = Array.isArray(r.picked) ? r.picked : null;
                const own = typeof r.text === 'string' ? clean(r.text).trim().slice(0, 2000) : '';
                if (chosen && own) throw new RangeError(`${q.id}: a choice or their own words, not both.`);
                if (chosen) {
                    if (chosen.length === 0 || chosen.some((c) => !q.choices.includes(c))) throw new RangeError(`${q.id}: only its choices, one at least.`);
                    if (!q.many && chosen.length > 1) throw new RangeError(`${q.id}: one choice only.`);
                    byId.set(q.id, { id: q.id, ...(q.label ? { label: q.label } : {}), picked: q.choices.filter((c) => chosen.includes(c)) });
                } else if (own) byId.set(q.id, { id: q.id, ...(q.label ? { label: q.label } : {}), text: own });
                else throw new RangeError(`${q.id}: no answer.`);
            }
            if (byId.size !== qs.length) throw new RangeError('Answer every question.');
            answered = qs.map((q) => byId.get(q.id));
        }
        const said = clean(text).trim() || (ticked ? ticked.join('\n') : '') || (answered ? answered.map((r, i) => `${i + 1}. ${r.label || cutQ(asked.questions[i].question)}: ${r.picked ? r.picked.join(', ') : r.text}`).join('\n') : '');
        if (!said && attached.length === 0) throw new RangeError('Write something.');
        const entry = { id: randomUUID(), at: this.#now().toISOString(), text: said };
        if (via === 'voice') entry.via = 'voice';
        const tapped = aboutOf(about);
        if (tapped) entry.about = tapped;
        if (attached.length) entry.files = attached.map((f) => ({ path: f.path, name: f.name || f.path.split('/').pop(), ...(f.size === undefined ? {} : { size: f.size }), ...(f.note ? { note: f.note } : {}) }));
        /* A question is answered; any other message of the agent is replied to, quoted. */
        if (asked?.kind === 'ask') {
            entry.answers = asked.id;
            entry.question = Array.isArray(asked.questions) ? oneLine(asked.intro || asked.short || `${asked.questions.length} questions`, 300) : oneLine(asked.text, 300);
            if (ticked) entry.picked = ticked;
            if (answered) entry.replies = answered;
        }
        else if (asked) { entry.re = asked.id; entry.quote = oneLine(asked.text || asked.path, 300); }
        this.#write([entry]);
        const now = this.read();
        this.#tell({ type: 'person-wrote', message: now.messages.find((m) => m.id === entry.id) ?? { from: 'person', ...entry }, unread: now.unread });
        return now;
    }

    /* THE PERSON REACTS to a message of the agent: `reaction` one id of the
       set, or null to take back the one standing. Written to the agent with
       the words and the time of that message, so that it knows which one; the
       application is told (person-reacted, with `wakes`: the set's hint) and
       decides whether to tell the agent now. Resolves with read(). */
    react(to, reaction) {
        const target = this.#model().messages.find((m) => m.from === 'agent' && m.id === to && ['say', 'ask', 'show'].includes(m.kind));
        if (!target) throw new RangeError('No such message of the agent.');
        const standing = target.reaction?.id ?? null;
        const kind = reaction === null || reaction === undefined || reaction === '' ? null : String(reaction);
        if (kind !== null && !this.#reactions.some((r) => r.id === kind)) throw new RangeError(`A reaction is one of: ${this.#reactions.map((r) => r.id).join(', ')}.`);
        if (kind === standing) return this.read();
        const base = { at: this.#now().toISOString(), text: '', to: target.id, quote: oneLine(target.text || target.path || '', 200), toAt: target.at };
        const lines2 = [];
        /* Another one replaces it: the one standing is taken back first, said so. */
        if (standing !== null && kind === null) lines2.push({ id: randomUUID(), ...base, reaction: standing, removed: true });
        if (kind !== null) lines2.push({ id: randomUUID(), ...base, reaction: kind });
        this.#write(lines2);
        const now = this.read();
        const set = this.#reactions.find((r) => r.id === (kind ?? standing));
        this.#tell({ type: 'person-reacted', message: lines2.at(-1), reaction: kind, wakes: kind === null ? false : set?.wakes ?? false, unread: now.unread });
        return now;
    }

    /* The text that asks an agent to use Parley: English, in the person's
       language `lang`. The application types it, changes it, or does not. */
    invite(lang, options = {}) { return invitation({ ...options, lang }); }

    /* Starts announcing each thing the agent posts FROM NOW ON: agent-said,
       agent-asked, agent-showed, agent-status, agent-doing. Resolves with a function that
       stops it. The file is looked at, nothing is pushed: what was posted
       while nobody listened is still in `read()`. Each line is announced
       once, by where it sits in the file, and only once it is whole. */
    listen({ every = 2000 } = {}) {
        const file = `${this.#dir}/from-agent.jsonl`;
        const size = () => { try { return lstatSync(file).isSymbolicLink() ? 0 : statSync(file).size; } catch { return 0; } };
        let offset = size();
        let rest = Buffer.alloc(0);
        const TYPES = { say: 'agent-said', ask: 'agent-asked', show: 'agent-showed', status: 'agent-status', doing: 'agent-doing', close: 'agent-closed' };
        const tell = (m) => { const message = this.#fromAgent(m); this.#tell({ type: TYPES[message.kind], message }); };
        if (this.#keep) {
            /* Kept: each line once it is kept, by its place in the copy, which only grows -- whatever the agent does to its file. */
            let known = this.#sync('from-agent.jsonl').length;
            const timer = setInterval(() => {
                let all;
                try { all = this.#sync('from-agent.jsonl'); } catch { return; }
                for (const line of all.slice(known)) { const m = parsed(line); if (m) tell(m); }
                known = all.length;
            }, every);
            timer.unref?.();
            return () => clearInterval(timer);
        }
        const look = () => {
            const now = size();
            if (now < offset) { offset = 0; rest = Buffer.alloc(0); }        /* the file was started again */
            if (now === offset) return;
            let from = offset;
            if (now - from > FILE_MAX) { from = now - FILE_MAX; rest = Buffer.alloc(0); }
            const chunk = Buffer.alloc(now - from);
            let fd;
            try { fd = openSync(file, 'r'); readSync(fd, chunk, 0, chunk.length, from); } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
            offset = now;
            const all = Buffer.concat([rest, chunk]);
            const end = all.lastIndexOf(0x0a);
            if (end < 0) { rest = all; return; }
            rest = all.subarray(end + 1);
            for (const line of all.subarray(0, end).toString('utf8').split('\n')) {
                const m = line ? parsed(line) : undefined;
                if (m) tell(m);
            }
        };
        const timer = setInterval(look, every);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
