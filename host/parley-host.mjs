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
 *   person-pinned {message, on, unread}                 pin(to, on)
 *   agent-pinned  {message}         (it pinned a message, or unpinned it: removed)
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
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync, openSync, readSync, closeSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARCHIVE, SETTINGS_FILE, SIDES, headOf, SETTLE_MS, keyOf, splitOf, jsonOf, writeJson, writeWhole, readIndex, writeIndex, volumePath, carryPath, movingPath, volumeName, cutsOf, spanOf, firstAt, lock } from './archive.mjs';

export { SPLIT, splitOf } from './archive.mjs';

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
const KINDS = ['say', 'ask', 'show', 'status', 'doing', 'close', 'pin'];
/* PINNED MESSAGES: a decision, a rule, a link, kept at the top of the chat and read again by the
   agent after a restart. Either side pins any message of the exchange; so many stand at most, the
   oldest leaving for a new one. */
export const PINS_MAX = 5;
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
/* The person marked it urgent while the agent works (#322): read now, before going on. */
export const URGENT = 'You have an URGENT message: run "parley read" now, before going on with your work.';
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
/* Another speaker of the person's side: { id, name, place? }, each one short line (a voice box: its room, and where it is). */
export const SPEAKERS_FILE = 'speakers.json';
/* The rooms this agent is a member of (#215): [{ id, name, members: [{ id, name, kind }] }], set by the application. */
export const ROOMS_FILE = 'rooms.json';
const ROOMS_MAX = 20;
export function roomOf(v) {
    if (!v || typeof v !== 'object') return null;
    const id = oneLine(v.id, 80); const name = oneLine(v.name, 60);
    const members = Array.isArray(v.members) ? v.members.map(byOf).filter(Boolean).slice(0, 40) : [];
    return id && name ? { id, name, members } : null;
}
export const SPEAKERS_MAX = 20;
export function byOf(v) {
    if (!v || typeof v !== 'object') return null;
    const id = oneLine(v.id, 80); const name = oneLine(v.name, 40); const place = oneLine(v.place, 40);
    /* Why it listened (a voice box: the wake word and its score, the button, a conversation going on...), and
       what it cut short: shown beside the message, never in its words (01-11). */
    const why = oneLine(v.why, 120);
    /* Which sort of speaker (#215, the rooms): a person, an AI (a conversation), a voice box. */
    const kind = ['person', 'ai', 'box'].includes(v.kind) ? v.kind : '';
    /* Its small sign (06-11): the letter and colour the application shows it by elsewhere (a conversation's card). */
    const look = v.look && typeof v.look === 'object' && Number.isInteger(v.look.hue) && v.look.hue >= 0 && v.look.hue < 360 && typeof v.look.initial === 'string' && [...v.look.initial].length === 1 ? { hue: v.look.hue, initial: v.look.initial } : null;
    return id && name ? { id, name, ...(kind ? { kind } : {}), ...(place ? { place } : {}), ...(why ? { why } : {}), ...(look ? { look } : {}) } : null;
}

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
/* A FILE THAT ONLY GREW is read from where it was left: the bytes kept of its end (TAIL) are read
   again in place, and must be the same, on the same file (inode). A file rewritten, made shorter,
   or replaced is read whole again. */
const TAIL = 64 * 1024;
/* A line changed further back, in the same write as one added, is not in that end: the whole file
   is read again at most this long after it last was (milliseconds), and the change found then. */
const WHOLE_EVERY = 60_000;
function bytesAt(file, from, length) {
    const out = Buffer.alloc(length);
    if (!length) return out;
    const fd = openSync(file, 'r');
    try { readSync(fd, out, 0, length, from); } finally { closeSync(fd); }
    return out;
}
/* `known`: { ino, end, tail, whole } of the last read (end: the byte after its last whole line;
   whole: when it was last read whole). The bytes after it, or null when the file did not only grow
   since (one of the same size changed in place), or when it is time to read it whole again. */
function grownBytes(file, st, known) {
    if (!known || known.ino !== st.ino || st.size <= known.end || !(Date.now() - known.whole < WHOLE_EVERY)) return null;
    const from = known.end - known.tail.length;
    if (!bytesAt(file, from, known.tail.length).equals(known.tail)) return null;
    return bytesAt(file, known.end, st.size - known.end);
}
/* The end of what is kept of a file read so far: the last TAIL bytes of its whole lines. */
const tailOf = (before, added) => { const all = before.length ? Buffer.concat([before, added]) : added; return Buffer.from(all.subarray(Math.max(0, all.length - TAIL))); };
/* Each list of lines read is one generation: a list that only grew keeps it, one read again whole
   gets a new one -- what the thread built from it (see #model) is then built again. */
let GEN = 0;
const NO_LINES = Object.freeze({ list: Object.freeze([]), gen: 0 });

/* THE WHOLE LINES OF A BRIDGE FILE, parsed, in place: a line that is not an object
   stays as `undefined`, so that a line keeps its place (a cursor counts places). A
   line not ended yet waits, unless it reads whole. Read again only when the file changed,
   and then only what was added to it; never through a link. */
const WHOLE = new Map();
function wholeLines(file) {
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile() || st.size > 16 * FILE_MAX) { WHOLE.delete(file); return NO_LINES; }
        const stamp = statOf(st);
        const known = WHOLE.get(file);
        if (known?.stamp === stamp) return known;
        /* Grown, and no line taken before it ended: only what is new is parsed, at the end of the same list. */
        const added = known && !known.rest ? grownBytes(file, st, known) : null;
        if (added) {
            const end = added.lastIndexOf(0x0a) + 1;
            for (const line of added.toString('utf8', 0, end).split('\n')) if (line) known.list.push(parsed(line));
            const rest = parsed(added.toString('utf8', end));
            if (rest) { known.list.push(rest); known.rest = true; }
            Object.assign(known, { stamp, end: known.end + end, tail: tailOf(known.tail, added.subarray(0, end)) });
            return known;
        }
        const buf = readFileSync(file);
        if (file.includes(`/${ARCHIVE}/`)) ARCHIVE_STATS.parsed += 1;
        const end = buf.lastIndexOf(0x0a) + 1;
        const list = buf.toString('utf8', 0, end).split('\n').filter(Boolean).map(parsed);
        /* A last line with no end yet is taken once it reads whole (a hand-written file); never in part. */
        const rest = parsed(buf.toString('utf8', end));
        if (rest) list.push(rest);
        const entry = { stamp, list, gen: (GEN += 1), ino: st.ino, end, tail: Buffer.from(buf.subarray(Math.max(0, end - TAIL), end)), whole: Date.now(), rest: Boolean(rest) };
        WHOLE.set(file, entry);
        return entry;
    } catch { WHOLE.delete(file); return NO_LINES; }
}
/* The lines kept, parsed in place: the copy only grows, so only what is new is parsed. */
const PARSED = new Map();
function parsedOf(key, raw) {
    const known = PARSED.get(key);
    if (known && raw.length >= known.n && (known.n === 0 || raw[known.n - 1] === known.last)) {
        if (raw.length > known.n) { for (let i = known.n; i < raw.length; i += 1) known.list.push(parsed(raw[i])); known.n = raw.length; known.last = raw.at(-1); }
        return known;
    }
    const entry = { n: raw.length, last: raw.at(-1), list: raw.map(parsed), gen: (GEN += 1) };
    PARSED.set(key, entry);
    return entry;
}
/* How many lines a file holds (one not ended yet too): counted again only when it changed, and
   then only in what was added to it (see grownBytes). */
const COUNTED = new Map();
const linesIn = (buf, from, to) => { let n = 0, at = from; while (at < to) { const nl = buf.indexOf(0x0a, at); const stop = nl < 0 || nl >= to ? to : nl; if (stop > at) n += 1; at = stop + 1; } return n; };
function lineCount(file) {
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink()) return 0;
        const stamp = statOf(st);
        const known = COUNTED.get(file);
        if (known?.stamp === stamp) return known.n;
        const added = grownBytes(file, st, known);
        const buf = added ?? readFileSync(file);
        const end = buf.lastIndexOf(0x0a) + 1;
        const lines = (added ? known.lines : 0) + linesIn(buf, 0, end);
        const entry = { stamp, ino: st.ino, end: (added ? known.end : 0) + end, tail: tailOf(added ? known.tail : Buffer.alloc(0), buf.subarray(0, end)), whole: added ? known.whole : Date.now(), lines };
        entry.n = lines + (buf.length > end ? 1 : 0);
        COUNTED.set(file, entry);
        return entry.n;
    } catch { return 0; }
}

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
   was when last compared ({ stamp, ino, end, tail, n, lines }), so that a bridge file that did
   not move is not read again, and one that only grew is read from where it was left. */
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
/* Lines added to a file of the keep folder, and to what is known of it: in place, its ids with
   them (a thread of thousands of lines is not copied, nor its ids read again, for one line). */
function keep(file, add, { whole = false } = {}) {
    const before = whole ? null : kept(file);
    if (whole) writeFileSync(file, add.map((l) => `${l}\n`).join(''));
    else if (add.length) appendFileSync(file, add.map((l) => `${l}\n`).join(''));
    if (before) {
        for (const l of add) before.lines.push(l);
        if (before.ids) for (const l of add) { const id = idOf(l); if (id) before.ids.add(id); }
        before.stamp = keptStat(file);
        return before;
    }
    const entry = { stamp: keptStat(file), lines: [...add], ids: null, seen: null };
    KEPT.set(file, entry);
    return entry;
}
const idsOf = (entry) => (entry.ids ??= new Set(entry.lines.map(idOf).filter(Boolean)));
/* The whole lines of a bridge file, as written (a line not ended yet waits): none when it is
   gone, or is a link (all it held is gone from there); null when too big to compare, or when
   it is as it was when last compared (`seen`). Only grown since: the lines it had (`prev()`)
   and those read after them. */
function bridgeLines(file, seen, prev) {
    const none = { lines: [], seen: { stamp: 'none' } };
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) return seen?.stamp === 'none' ? null : none;
        const stamp = statOf(st);
        if (stamp === seen?.stamp || st.size > 16 * FILE_MAX) return null;
        const added = prev ? grownBytes(file, st, seen) : null;
        if (added) {
            const end = added.lastIndexOf(0x0a) + 1;
            const lines = prev();
            for (const l of added.toString('utf8', 0, end).split('\n')) if (l) lines.push(l);
            return { lines, seen: { stamp, ino: st.ino, end: seen.end + end, tail: tailOf(seen.tail, added.subarray(0, end)), whole: seen.whole } };
        }
        const buf = readFileSync(file);
        const end = buf.lastIndexOf(0x0a) + 1;
        return { lines: buf.toString('utf8', 0, end).split('\n').filter(Boolean), seen: { stamp, ino: st.ino, end, tail: Buffer.from(buf.subarray(Math.max(0, end - TAIL), end)), whole: Date.now() } };
    } catch { return seen?.stamp === 'none' ? null : none; }
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

/* THE ARCHIVE (see archive.mjs, and "The archive" in docs/protocol.md). How many files of the
   archive were read whole by this process: for the tests, which prove a read does not go through
   all of them. */
export const ARCHIVE_STATS = { parsed: 0 };
const kindOf = (m) => (KINDS.includes(m.kind) ? m.kind : 'say');
const personMessage = (m) => typeof m.reaction !== 'string' && typeof m.pin !== 'string';
/* What the thread counts as messages in some lines (as #agentLine and #personLine take them), and
   what the agent's `parley read` counts as entries. */
const messagesIn = (from, to) => from.filter((m) => m && !['close', 'pin', 'status', 'doing'].includes(kindOf(m))).length + to.filter((m) => m && personMessage(m)).length;
const entriesIn = (from, to) => from.filter((m) => m && ['say', 'ask', 'show', 'close'].includes(m.kind)).length + to.filter(Boolean).length;
/* WHAT A VOLUME HANDS ON: a thread read from a volume onwards, without those before it, must still
   know what they left standing -- the questions still open (and the reaction on each), the pins
   standing and the messages they are on, the last state and step, the newest files, and the paths
   already shown or cited. Those lines are carried, each with its place, from the volume before
   (`prev`) and from this one: the thread takes them in as it would, without showing them. */
const CARRY_FILES = 200;
const CARRY_PATHS = 2000;
const CARRY_DANGLING = 50;
function carryOf(prev, from, to, fromBase, toBase) {
    /* `was`: open as carried. A question carried for another reason (a file it cites, a pin) was answered
       in a volume before: its answer is not carried, so it is never open again. */
    const A = [...(prev?.from ?? []).map(({ i, m, open: was }) => ({ i, m, carried: true, was: was === true })), ...from.flatMap((m, k) => (m ? [{ i: fromBase + k, m }] : []))];
    const P = [...(prev?.to ?? []).map(({ i, m }) => ({ i, m })), ...to.flatMap((m, k) => (m ? [{ i: toBase + k, m }] : []))];
    const keepA = new Map(), keepP = new Map(), open = new Set();
    /* The questions neither answered nor closed. */
    const answered = new Set(P.filter((x) => personMessage(x.m) && x.m.answers).map((x) => String(x.m.answers)));
    const closed = new Set(A.filter((x) => kindOf(x.m) === 'close').map((x) => oneLine(x.m.answers, 100)));
    for (const x of A) {
        const id = String(x.m.id ?? '');
        if (kindOf(x.m) === 'ask' && (!x.carried || x.was) && !answered.has(id) && !closed.has(id)) { keepA.set(x.i, x); open.add(x.i); }
    }
    const openIds = new Set([...open].map((i) => String(keepA.get(i).m.id ?? '')));
    const react = new Map();
    for (const x of P) {
        const m = x.m;
        if (typeof m.reaction !== 'string' || typeof m.to !== 'string') continue;
        if (m.removed !== true) react.set(m.to, x);
        else if (react.has(m.to) && oneLine(react.get(m.to).m.reaction, 30) === m.reaction) react.delete(m.to);
    }
    for (const [id, x] of react) if (openIds.has(id)) keepP.set(x.i, x);
    /* The last state, and the last step. */
    let step, state;
    for (const x of A) { const k = kindOf(x.m); if (k === 'status' || k === 'doing') { step = x; if (k === 'status') state = x; } }
    for (const x of [step, state]) if (x) keepA.set(x.i, x);
    /* The pins, replayed as pinsOf does; a pin of a message not there (yet) is carried too. */
    const byId = new Map();
    for (const x of A) if (!['close', 'pin', 'status', 'doing'].includes(kindOf(x.m))) byId.set(String(x.m.id ?? ''), { side: 'from', x });
    for (const x of P) if (personMessage(x.m)) byId.set(String(x.m.id ?? ''), { side: 'to', x });
    const puts = [
        ...P.filter((x) => typeof x.m.reaction !== 'string' && typeof x.m.pin === 'string').map((x) => ({ x, side: 'to', to: x.m.pin, at: String(x.m.at ?? ''), removed: x.m.removed === true })),
        ...A.filter((x) => kindOf(x.m) === 'pin').map((x) => ({ x, side: 'from', to: oneLine(x.m.pin, 100), at: String(x.m.at ?? ''), removed: x.m.removed === true })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    let pins = [];
    const dangling = new Map();
    for (const p of puts) {
        if (p.removed) { pins = pins.filter((q) => q.to !== p.to); dangling.delete(p.to); continue; }
        if (!byId.has(p.to)) { dangling.set(p.to, p); continue; }
        if (pins.some((q) => q.to === p.to)) continue;
        pins.push(p);
        if (pins.length > PINS_MAX) pins.shift();
    }
    for (const p of [...pins, ...[...dangling.values()].slice(-CARRY_DANGLING)]) (p.side === 'from' ? keepA : keepP).set(p.x.i, p.x);
    for (const p of pins) { const t = byId.get(p.to); (t.side === 'from' ? keepA : keepP).set(t.x.i, t.x); }
    /* The newest lines that showed or cited a file, and every path shown or cited (the newest so many). */
    const shown = new Set(prev?.shown ?? []), cites = new Set(prev?.cited ?? []);
    const files = [];
    for (const x of A) {
        const k = kindOf(x.m);
        if (k === 'show') {
            files.push(x);
            shown.add(oneLine(x.m.path, 1000));
            for (const f of Array.isArray(x.m.files) ? x.m.files : []) if (f && typeof f === 'object') shown.add(oneLine(f.path, 1000));
        } else if (k === 'say' || k === 'ask') {
            const c = cited(`${clean(x.m.text)}\n${typeof x.m.short === 'string' ? oneLine(x.m.short, SHORT_KEPT) : ''}`);
            if (c.length) { files.push(x); for (const path of c) cites.add(path); }
        }
    }
    for (const x of files.slice(-CARRY_FILES)) keepA.set(x.i, x);
    const sorted = (map, flag) => [...map.values()].sort((a, b) => a.i - b.i).map((x) => ({ i: x.i, m: x.m, ...(flag?.has(x.i) ? { open: true } : {}) }));
    return { from: sorted(keepA, open), to: sorted(keepP), shown: [...shown].slice(-CARRY_PATHS), cited: [...cites].slice(-CARRY_PATHS) };
}
/* The volumes of a split: what `src(side)` holds, cut (cutsOf), each written whole with what it
   carries, then listed in the index -- which is what makes them count. The files split are
   removed only then: what they held is in the volumes, line for line. Done again whole if it
   stopped half way (the index still says `moving`): the same names, the same files. */
function writeVolumes(root, index, src, split) {
    const raw = {}, obj = {};
    for (const name of SIDES) {
        let text = '';
        try { text = readFileSync(src(name), 'utf8'); } catch { /* none */ }
        raw[name] = text.split('\n').filter(Boolean);
        obj[name] = raw[name].map(parsed);
    }
    const [F, T] = SIDES;
    const volumes = [...index.volumes];
    if (raw[F].length || raw[T].length) {
        const taken = new Set(volumes.map((v) => v.name));
        let fromBase = 0, toBase = 0;
        for (const v of volumes) { fromBase += v.from.lines; toBase += v.to.lines; }
        let prev = volumes.length ? jsonOf(carryPath(root, volumes.at(-1))) : null;
        let a = 0, b = 0;
        for (const [fa, tb] of cutsOf(obj[F], obj[T], split || undefined)) {
            const f = obj[F].slice(a, fa), t = obj[T].slice(b, tb);
            if (!f.length && !t.length) continue;
            const span = spanOf([f, t]) ?? [Date.now(), Date.now()];
            const v = { name: volumeName(span[0], span[1], taken), from: { lines: f.length }, to: { lines: t.length }, messages: messagesIn(f, t), entries: entriesIn(f, t), first: new Date(span[0]).toISOString(), last: new Date(span[1]).toISOString(),
                /* The files it came from, by their first lines (see headOf): a reader of a mounted folder that read
                   one of them as current before it was renamed reads again. No inode: a mounted folder changes them. */
                src: { from: headOf(raw[F][0]), to: headOf(raw[T][0]) } };
            taken.add(v.name);
            writeWhole(volumePath(root, v, F), raw[F].slice(a, fa).map((l) => `${l}\n`).join(''));
            writeWhole(volumePath(root, v, T), raw[T].slice(b, tb).map((l) => `${l}\n`).join(''));
            prev = carryOf(prev, f, t, fromBase, toBase);
            writeJson(carryPath(root, v), prev);
            volumes.push(v);
            fromBase += f.length; toBase += t.length; a = fa; b = tb;
        }
    }
    writeIndex(root, { volumes });
    for (const name of SIDES) try { unlinkSync(src(name)); } catch { /* none */ }
    return { raw };
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

/* A SELECTOR OF A QUESTION (#195), as the page gets it: its kind, and plain values only --
   numbers, short words, small lists and tables -- never more than a selector needs. */
const INPUT_KINDS = new Set(['yesno', 'slider', 'number', 'range', 'scale', 'stars', 'rank', 'split', 'table', 'date', 'time', 'datetime', 'text']);
function inputKept(x) {
    if (!x || typeof x !== 'object' || !INPUT_KINDS.has(x.kind)) return null;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const w = (v, max = 60) => (typeof v === 'string' || typeof v === 'number' ? oneLine(String(v), max) : undefined);
    const words = (l, hi, max = 60) => (Array.isArray(l) ? l.slice(0, hi).map((v) => w(v, max)).filter(Boolean) : undefined);
    const out = { kind: x.kind, min: n(x.min), max: n(x.max), step: n(x.step), unit: w(x.unit, 12), total: n(x.total), lines: n(x.lines), labels: words(x.labels, 2, 40), items: words(x.items, 10), columns: words(x.columns, 6, 30), rows: words(x.rows, 8) };
    if (Array.isArray(x.value)) out.value = x.value.slice(0, 2).map(n).filter((v) => v !== undefined);
    else if (typeof x.value === 'number') out.value = n(x.value);
    else if (typeof x.value === 'string') out.value = w(x.value, 30);
    /* What the agent recommends (#198): a number, [a, b], yes or no, or (rank) true -- its items are in that order. */
    if (typeof x.recommended === 'number') out.recommended = n(x.recommended);
    else if (Array.isArray(x.recommended)) out.recommended = x.recommended.slice(0, 2).map(n).filter((v) => v !== undefined);
    else if (x.recommended === 'yes' || x.recommended === 'no' || x.recommended === true) out.recommended = x.recommended;
    if (x.kind === 'table' && Array.isArray(x.values)) out.values = x.values.slice(0, 8).map((r) => (Array.isArray(r) ? r.slice(0, 6).map((c) => w(c ?? '', 60) ?? '') : []));
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length && v !== out.values)));
}

/* THE THREADS BUILT (see #model), by folder: so many at most, the one read longest ago leaving first. */
const MODELS = new Map();
const MODELS_MAX = 64;
/* The lines of a side read from a volume on (see #view), by folder and side. */
const VIEWS = new Map();
/* The time the first line of a file says, read again only when the file changed. */
const FIRSTS = new Map();
function firstOf(file) {
    const stamp = keptStat(file);
    if (stamp === null) return null;
    const known = FIRSTS.get(file);
    if (known?.stamp === stamp) return known.t;
    const t = firstAt(file);
    FIRSTS.set(file, { stamp, t });
    if (FIRSTS.size > 4 * MODELS_MAX) FIRSTS.delete(FIRSTS.keys().next().value);
    return t;
}
/* A thread built from nothing yet: the lines of both files are taken into it from the first. */
/* A cite that stands for a path cited in a volume not read (see carryOf): never in the list of files. */
const CITED_BEFORE = Object.freeze({ path: '', cited: true });
/* `from`: where the thread is read from -- v0, the first volume read; fromBase, toBase, the lines
   of each side before it; U, the messages before it; vols, how many volumes the index had. */
function built(fromGen, toGen, look, from = { v0: 0, fromBase: 0, toBase: 0, U: 0, vols: 0 }) {
    return {
        fromGen, toGen, look, ...from, fromN: 0, toN: 0, paths: new Map(), place: new WeakMap(),
        ghostById: new Map(), missing: new Set(), looked: new Set(),
        readText: null, readCount: 0, reachTop: [], reachAt: [], B: 0,
        /* The messages in their order, each { from, m (as built), at, i (its line), e (as handed over) }. */
        order: [], messages: [], dirty: true, byId: new Map(), asks: [], persons: [], byLine: [],
        steps: [], lastStep: undefined, lastStatus: undefined, closeLines: [], closes: new Map(), answered: new Set(),
        reactions: new Map(), reactionLine: new Map(), puts: { person: [], agent: [] }, putTo: new Set(), pins: [], pinsDirty: true,
        shown: [], shownPaths: new Set(), cites: [], citeOf: new Map(), citeGone: new Set([CITED_BEFORE]), files: [],
    };
}
/* When line i of the person was read: the first read that reached it (the running highest count above i). */
function seenAtOf(s, i) {
    let lo = 0, hi = s.reachTop.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.reachTop[mid] > i) hi = mid; else lo = mid + 1; }
    return s.reachAt[lo] ?? null;
}
/* A message as handed over: made again only when what is put on it changed (a reaction, a close,
   when it was read); the same object otherwise, from one read to the next. */
function cur(s, x) {
    if (x.e) return x.e;
    let e;
    if (x.from === 'agent') {
        const r = s.reactions.get(x.m.id);
        const c = x.m.kind === 'ask' ? s.closes.get(x.m.id) : undefined;
        e = r || c ? { ...x.m, ...(r ? { reaction: r } : {}), ...(c ? { closed: c } : {}) } : x.m;
    } else e = { ...x.m, seen: x.seen, ...(x.seen && x.seenAt ? { seenAt: x.seenAt } : {}), ...x.more };
    s.place.set(e, x.i);
    x.e = e;
    return e;
}
/* The agent's messages of an id, to be made again (a reaction or a close put on them, or taken away). */
function touch(s, id) { for (const x of s.byId.get(id) ?? []) { x.e = null; s.dirty = true; } }
/* Where a new item goes in a list sorted by time (`at`, compared as the list was sorted): after
   those of the same time, unless `before(y)` says it goes before y -- what one stable sort of the
   whole list would have done. */
function insertAt(list, item, before) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const c = String(list[mid].at).localeCompare(String(item.at));
        if (c > 0 || (c === 0 && before(list[mid]))) hi = mid; else lo = mid + 1;
    }
    if (lo === list.length) list.push(item); else list.splice(lo, 0, item);
}
/* The first of the steps (in the order of their file) at line `a` or after. */
function firstFrom(steps, place, a) {
    let lo = 0, hi = steps.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (place.get(steps[mid]) >= a) hi = mid; else lo = mid + 1; }
    return lo;
}
/* A pin is no message either: both sides' pins, replayed in the order they were put. One put
   again while it stands keeps its place; a message that is not there any more is skipped. */
/* A message carried from a volume not read (ghostById) counts too; one found nowhere is noted
   (`missing`): it may be in a volume not read. */
function pinsOf(s) {
    const byId = new Map(s.order.map((x) => [x.m.id, x.m]));
    const puts = [...s.puts.person, ...s.puts.agent].sort((a, b) => a.at.localeCompare(b.at));
    let pins = [];
    s.missing = new Set();
    for (const p of puts) {
        if (p.removed) { pins = pins.filter((x) => x.id !== p.to); continue; }
        const m = byId.get(p.to) ?? s.ghostById.get(p.to);
        if (!m) s.missing.add(p.to);
        if (!m || pins.some((x) => x.id === m.id)) continue;
        pins.push({ id: m.id, at: p.at, by: p.by, from: m.from, text: oneLine(m.text || m.path || '', 200), toAt: m.at });
        if (pins.length > PINS_MAX) pins.shift();
    }
    return pins;
}

export class Parley {
    #dir; #on; #reach; #now; #reactions; #keep; #room; #settle; #onSplit;
    /* While a thread is built: its rooms and speakers, read once; and where each path it opens is noted. */
    #members = null; #paths = null;

    /* `on(event)`: told what happens (see the top of this file).
       `reach(path)`: how the person opens a file the agent showed -- a
       reference of the application's (a link, a path) or null when it
       cannot be opened from their screen. Every path, by default. */
    /* `reactions`: the set offered, [{ id, wakes }] (REACTIONS by default). */
    /* `keep`: a folder of the application's, out of the agent's reach, where
       the thread is kept as it was read (see THE APPLICATION'S OWN COPY);
       one per bridge folder. Without it, the bridge folder is all there is. */
    /* `room`: a room's thread (#215), written by the application alone: only there is an agent-side line
       signed (by), and only by relay(). In an agent's own folder a signature it writes is never believed --
       who wrote a line is where it came from, never what it says of itself (03-11). */
    /* `settle`: how long a split waits before its volumes are counted (SETTLE_MS; see archive.mjs).
       `onSplit(step)`: told each step of a split as it is made -- for the tests, which write
       between them as an agent would. */
    constructor(dir, { on, reach = (path) => path, now = () => new Date(), reactions = REACTIONS, keep, room = false, settle = SETTLE_MS, onSplit } = {}) {
        this.#room = room === true;
        this.#settle = Number.isFinite(settle) && settle >= 0 ? settle : SETTLE_MS;
        this.#onSplit = typeof onSplit === 'function' ? onSplit : null;
        this.#dir = dir; this.#on = on; this.#reach = reach; this.#now = now; this.#keep = typeof keep === 'string' && keep ? keep : null;
        this.#reactions = (Array.isArray(reactions) ? reactions : REACTIONS).filter((r) => r && REACTION_ID.test(r.id));
    }

    #tell(event) { try { this.#on?.(event); } catch { /* a hook that fails stops nothing */ } }

    /* How the person opens a file, or null. */
    #open(path) { let r; try { r = this.#reach(path); r = typeof r === 'string' && r ? r : null; } catch { r = null; } this.#paths?.set(path, r); return r; }

    /* A member of one of its rooms named in words (@{id}): by its name of the moment, either side (06-11: the id showed). */
    #named(t) { return t.includes('@{') ? t.replace(/@\{([0-9a-f-]{36})\}/g, (whole, mid) => { for (const r of this.#members?.rooms ?? this.rooms()) { const x = r.members.find((y) => y.id === mid); if (x) return `@${x.name}`; } return whole; }) : t; }
    /* One line the agent wrote, as it is handed over. */
    #fromAgent(m) {
        const kind = KINDS.includes(m.kind) ? m.kind : 'say';
        /* A member of one of its rooms named in its words (@{id}): by its name of the moment (06-11: the id showed). */
        const entry = { from: 'agent', id: String(m.id ?? ''), at: String(m.at ?? ''), kind, text: this.#named(clean(m.text)), choices: kind === 'ask' && Array.isArray(m.choices) ? m.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [] };
        if ((kind === 'say' || kind === 'ask') && typeof m.short === 'string' && oneLine(m.short, SHORT_KEPT)) entry.short = oneLine(m.short, SHORT_KEPT);
        /* Several of its choices may be ticked, sent together. */
        if (kind === 'ask' && m.many === true && entry.choices.length > 1) entry.many = true;
        /* What it recommends among its choices, and the reply it would give in their place (#198). */
        if (kind === 'ask' && Array.isArray(m.recommended)) { const r = m.recommended.map((x) => oneLine(x, 200)).filter((x) => entry.choices.includes(x)); if (r.length) entry.recommended = r; }
        if ((kind === 'say' || kind === 'ask') && typeof m.suggest === 'string' && clean(m.suggest).trim()) entry.suggest = clean(m.suggest).slice(0, 1000).trim();
        /* Whom it is for (#215): the ids of those who speak here; shown by their names of the moment. */
        if ((kind === 'say' || kind === 'ask' || kind === 'doing' || kind === 'show') && Array.isArray(m.to)) {
            /* A box by its name and place; an AI or a person of one of its rooms by its name (06-11: an id showed instead). */
            const rooms = this.#members?.rooms ?? this.rooms(), speakers = this.#members?.speakers ?? this.speakers();
            const names = new Map([...rooms.flatMap((r) => r.members.map((x) => [x.id, x.name])), ...speakers.map((x) => [x.id, x.place ? `${x.name} \u00b7 ${x.place}` : x.name])]);
            const to = m.to.slice(0, SPEAKERS_MAX).map((x) => oneLine(x, 80)).filter(Boolean);
            /* For the person (06-11): not a « → Toi » tab, a mark on the message (toYou); the others by their names. */
            const persons = new Set([...speakers, ...rooms.flatMap((r) => r.members)].filter((x) => x.kind === 'person').map((x) => x.id));
            if (to.length) { entry.to = to; entry.toNames = to.filter((id) => !persons.has(id)).map((id) => names.get(id) ?? id); if (to.some((id) => persons.has(id))) entry.toYou = true; }
        }
        /* In a room (#215): which AI wrote it (the application signs what it relays), and the message it answers. */
        if (this.#room && byOf(m.by)) entry.by = byOf(m.by);
        if (typeof m.re === 'string' && oneLine(m.re, 80)) entry.re = oneLine(m.re, 80);
        /* Where it is to go (an agent answering in a room): a request the application checks, never a signature. */
        /* Shown in a room too (07-11): a file it made, opened there through its own conversation. */
        if (!this.#room && (kind === 'say' || kind === 'ask' || kind === 'doing' || kind === 'show') && typeof m.room === 'string' && oneLine(m.room, 80)) entry.room = oneLine(m.room, 80);
        if (entry.room && typeof m.forward === 'string' && oneLine(m.forward, 80)) entry.forward = oneLine(m.forward, 80);
        /* Several questions at once, one card: each well formed, ids unique; fewer than two, none (the text says them). */
        if (kind === 'ask' && Array.isArray(m.questions)) {
            const ids = new Set();
            const list = m.questions.slice(0, GROUP_MAX).filter((q) => q && typeof q === 'object' && typeof q.id === 'string' && GROUP_ID.test(q.id) && !ids.has(q.id) && ids.add(q.id)).map((q) => {
                const choices = Array.isArray(q.choices) ? q.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [];
                const input = inputKept(q.input);
                const recommended = Array.isArray(q.recommended) ? q.recommended.map((x) => oneLine(x, 200)).filter((x) => choices.includes(x)) : [];
                return { id: q.id, label: oneLine(q.label, 40), question: clean(q.question).slice(0, 1000).trim(), choices, ...(q.many === true && choices.length > 1 ? { many: true } : {}), ...(recommended.length ? { recommended } : {}), ...(input && !choices.length ? { input } : {}) };
            }).filter((q) => q.question);
            /* Two questions or more; or one alone with its selector (#195). */
            if (list.length > 1 || (list.length === 1 && list[0].input)) { entry.questions = list; entry.choices = []; if (m.steps === true) entry.steps = true; if (typeof m.intro === 'string' && clean(m.intro).trim()) entry.intro = clean(m.intro).slice(0, 2000).trim(); }
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
        if (kind === 'pin') { entry.text = ''; entry.pin = oneLine(m.pin, 100); if (m.removed === true) entry.removed = true; }
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
        const bridge = `${this.#dir}/${name}`;
        let entry = kept(own);
        if (entry === null) {
            /* First sight: the bridge is taken as it is (a thread begun before it was kept). */
            mkdirSync(this.#keep, { recursive: true });
            const now = bridgeLines(bridge);
            entry = keep(own, now?.lines ?? [], { whole: true });
            entry.seen = now ? { ...now.seen, n: now.lines.length, lines: null } : null;
            return entry.lines;
        }
        /* The lines the bridge had when last compared: those kept, when it was the same as the copy. */
        const seen = entry.seen;
        const prev = seen?.ino !== undefined ? () => (seen.lines ? [...seen.lines] : entry.lines.slice(0, seen.n)) : null;
        const now = bridgeLines(bridge, seen, prev);
        if (now === null) return entry.lines;
        const side = name === 'from-agent.jsonl' ? 'agent' : 'person';
        const found = compare(entry, now.lines, { takes: side === 'agent' });
        if (found.fresh.length) entry = keep(own, found.fresh);
        const same = !found.lost.length && !found.added.length && entry.lines.length === now.lines.length;
        entry.seen = { ...now.seen, n: now.lines.length, lines: same ? null : now.lines };
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
    unread() { return Math.max(0, (this.#keep ? this.#sync('to-agent.jsonl').length : lineCount(`${this.#dir}/to-agent.jsonl`)) + this.#archived('to-agent.jsonl') - readCount(this.#dir)); }

    /* The lines of one side, parsed in place (see wholeLines): the copy kept, with a keep
       folder; the bridge file, without. Their places are what a cursor counts. With them, their
       generation: the same while the list only grew. */
    #lines(name) { return this.#keep ? parsedOf(`${this.#keep}/${name}`, this.#sync(name)) : wholeLines(`${this.#dir}/${name}`); }
    #raw(name) { return this.#lines(name).list; }

    /* THE WHOLE THREAD, as handed over: every message of both sides in order, every step,
       what is open, where it is. What read() gives is a part of it; nothing is left out
       of what is counted (the questions open, the status, the files, the unread).
       BUILT ONCE, THEN EXTENDED: a dense thread is read every few seconds, and grows by a line
       at a time. What was built is kept (per folder, so that a new host of the same folders finds
       it) and only the new lines are taken into it -- each as a whole rebuild would take it. It
       is built again whole when a file was read again whole (rewritten, shorter), when the names
       its messages are shown by changed (rooms, speakers), or when a path is not opened the way it
       was. */
    #model({ v0: want } = {}) {
        this.#split();
        const root = this.#keep ?? this.#dir;
        const index = readIndex(root);
        const vols = index.volumes;
        const key = `${this.#dir}\n${this.#keep ?? ''}\n${this.#room}`;
        let s = MODELS.get(key);
        /* How deep it is read: as deep as asked, never less deep than it is; once a volume is added,
           from near the end again (what a long-lived host holds does not grow with the months). */
        const v0 = want !== undefined ? Math.min(want, s && s.vols === vols.length ? s.v0 : vols.length) : s && s.vols === vols.length ? s.v0 : this.#shallow(root, index);
        const from = this.#view('from-agent.jsonl', root, index, v0);
        const to = this.#view('to-agent.jsonl', root, index, v0);
        const look = `${keptStat(`${this.#dir}/${ROOMS_FILE}`)}|${keptStat(`${this.#dir}/${SPEAKERS_FILE}`)}`;
        if (!(s && s.v0 === v0 && s.vols === vols.length && s.fromGen === from.gen && s.toGen === to.gen && s.look === look && from.list.length >= s.fromN && to.list.length >= s.toN && this.#reachSame(s))) {
            let U = 0;
            for (let q = 0; q < v0; q += 1) U += vols[q].messages;
            s = built(from.gen, to.gen, look, { v0, fromBase: from.base, toBase: to.base, U, vols: vols.length });
        }
        MODELS.delete(key); MODELS.set(key, s);
        if (MODELS.size > MODELS_MAX) MODELS.delete(MODELS.keys().next().value);
        let readText = '';
        try { readText = readFileSync(`${this.#dir}/read.json`, 'utf8'); } catch { /* not read yet */ }
        this.#members = { rooms: this.rooms(), speakers: this.speakers() };
        this.#paths = s.paths;
        try {
            const bulk = s.fromN === 0 && s.toN === 0;
            /* What the volumes not read left standing: taken in first, shown nowhere. */
            if (bulk && v0 > 0) this.#ghosts(s, jsonOf(carryPath(root, vols[v0 - 1])));
            this.#readsOf(s, readText, s.toBase + to.list.length);
            for (let i = s.fromN; i < from.list.length; i += 1) this.#agentLine(s, from.list[i], s.fromBase + i, bulk);
            for (let i = s.toN; i < to.list.length; i += 1) this.#personLine(s, to.list[i], s.toBase + i, bulk);
            s.fromN = from.list.length; s.toN = to.list.length;
            if (bulk) {
                /* A whole build sorts once, as it always did: the agent's messages, then the person's, by time. */
                s.order.sort((a, b) => a.at.localeCompare(b.at));
                s.files = [...s.shown, ...s.cites.filter((c) => !s.shownPaths.has(c.path))].sort((a, b) => String(a.at).localeCompare(String(b.at)));
                s.dirty = true; s.pinsDirty = true;
            }
        } finally { this.#members = null; this.#paths = null; }
        if (s.dirty) { s.messages = s.order.map((x) => cur(s, x)); s.dirty = false; }
        if (s.pinsDirty) { s.pins = pinsOf(s); s.pinsDirty = false; }
        /* A pin of a message in a volume not read: read down to it (once for each, found or not). */
        if (s.missing.size && s.v0 > 0) {
            const ids = [...s.missing].filter((id) => !s.looked.has(id));
            for (const id of ids) s.looked.add(id);
            const q = ids.length ? this.#locate(root, index, s.v0, ids) : null;
            if (q !== null) { const looked = s.looked; const t = this.#model({ v0: q }); for (const id of looked) MODELS.get(key)?.looked.add(id); return t; }
        }
        const last = s.lastStatus;
        const after = s.lastStep?.kind === 'doing' && last?.state !== 'working';
        const fromN = s.fromBase + s.fromN, toN = s.toBase + s.toN;
        return {
            messages: s.messages, steps: s.steps, pins: [...s.pins], place: s.place, closeLines: s.closeLines,
            read: Math.min(s.readCount, toN), unread: Math.max(0, toN - s.readCount), fromN, toN, toRaw: to.list,
            v0: s.v0, U: s.U, fromBase: s.fromBase, toBase: s.toBase, vols,
            open: s.asks.filter((x) => !s.answered.has(x.m.id) && !s.closes.has(x.m.id)).map((x) => cur(s, x)),
            status: after ? { state: 'working', note: '', at: s.lastStep.at } : last ? { state: last.state, note: last.text, at: last.at } : null,
            files: s.files.slice(-LISTED_MAX),
        };
    }
    /* What a volume not read carried (see carryOf), taken into the thread as its lines would be,
       none of them shown: the paths shown before first, those cited after. */
    #ghosts(s, carry) {
        if (!carry || typeof carry !== 'object') return;
        for (const p of Array.isArray(carry.shown) ? carry.shown : []) s.shownPaths.add(p);
        for (const x of Array.isArray(carry.from) ? carry.from : []) if (x && Number.isInteger(x.i)) this.#agentLine(s, x.m, x.i, true, x.open === true ? 'open' : true);
        for (const x of Array.isArray(carry.to) ? carry.to : []) if (x && Number.isInteger(x.i)) this.#personLine(s, x.m, x.i, true, true);
        for (const p of Array.isArray(carry.cited) ? carry.cited : []) if (!s.citeOf.has(p)) s.citeOf.set(p, CITED_BEFORE);
    }
    /* THE LINES OF ONE SIDE FROM VOLUME v0 ON: those volumes, a split not counted yet (moving), and
       the current file; `base`, the lines before them. A thread never split is its current file,
       as it always was. The list only grows while none of its parts was read again. */
    #view(name, root, index, v0) {
        const cur = this.#lines(name);
        const k = keyOf(name);
        const vols = index.volumes;
        let base = 0;
        for (let q = 0; q < v0; q += 1) base += vols[q][k].lines;
        const parts = [];
        for (let q = v0; q < vols.length; q += 1) parts.push(wholeLines(volumePath(root, vols[q], name)));
        /* The file renamed away: unless it is the one just read as current (read before it was renamed). */
        if (index.moving) { const mv = wholeLines(movingPath(root, name)); if (mv.list.length && mv.ino !== cur.ino) parts.push(mv); }
        if (!parts.length) return { list: cur.list, gen: cur.gen, base };
        const vkey = `${root}\n${name}`;
        const pk = `${v0}|${parts.map((p) => p.gen).join(',')}`;
        let v = VIEWS.get(vkey);
        if (!(v && v.pk === pk && v.curGen === cur.gen && cur.list.length >= v.curN)) {
            v = { pk, curGen: cur.gen, curN: 0, list: [], gen: (GEN += 1) };
            for (const p of parts) for (const m of p.list) v.list.push(m);
            VIEWS.delete(vkey); VIEWS.set(vkey, v);
            if (VIEWS.size > 2 * MODELS_MAX) VIEWS.delete(VIEWS.keys().next().value);
        }
        for (let i = v.curN; i < cur.list.length; i += 1) v.list.push(cur.list[i]);
        v.curN = cur.list.length;
        return { list: v.list, gen: v.gen, base };
    }
    /* Lines of one side in the archive (`root`: the keep folder, with one): the volumes, and a split
       not counted yet -- unless its file is still the current one. */
    #archived(name, root = this.#keep ?? this.#dir) {
        const index = readIndex(root);
        let n = 0;
        for (const v of index.volumes) n += v[keyOf(name)].lines;
        if (index.moving) {
            const mv = wholeLines(movingPath(root, name));
            let ino = null;
            try { ino = lstatSync(`${root}/${name}`).ino; } catch { /* none */ }
            if (mv.ino !== ino) n += mv.list.length;
        }
        return n;
    }
    /* The archived lines of one side from place `pos` on (volumes, then a split not counted yet). */
    #archivedFrom(name, pos, root = this.#keep ?? this.#dir) {
        const index = readIndex(root);
        const out = [];
        let at = 0;
        for (const v of index.volumes) {
            const n = v[keyOf(name)].lines;
            if (at + n > pos) out.push(...wholeLines(volumePath(root, v, name)).list.slice(Math.max(0, pos - at)));
            at += n;
        }
        if (index.moving) {
            const mv = wholeLines(movingPath(root, name));
            let ino = null;
            try { ino = lstatSync(`${root}/${name}`).ino; } catch { /* none */ }
            if (mv.ino !== ino) out.push(...mv.list.slice(Math.max(0, pos - at)));
        }
        return out;
    }
    /* Where to read from when nothing asks for more: the newest volumes, down to a window of messages. */
    #shallow(root, index) {
        let n = 0;
        for (const name of SIDES) {
            const side = name === 'from-agent.jsonl' ? 'agent' : 'person';
            const lists = [this.#lines(name).list, ...(index.moving ? [wholeLines(movingPath(root, name)).list] : [])];
            for (const list of lists) n += side === 'agent' ? messagesIn(list, []) : messagesIn([], list);
        }
        let q = index.volumes.length;
        while (q > 0 && n < WINDOW) { q -= 1; n += index.volumes[q].messages; }
        return q;
    }
    /* From which volume `n` more messages are read than from t.v0. */
    static #deeper(t, n) {
        let q = t.v0, got = 0;
        while (q > 0 && got < n) { q -= 1; got += t.vols[q].messages; }
        return q;
    }
    /* The newest volume below `below` that holds one of `ids` (the oldest such, for several), or null. */
    #locate(root, index, below, ids) {
        const left = new Set(ids);
        let found = null;
        for (let q = below - 1; q >= 0 && left.size; q -= 1) {
            for (const name of SIDES) for (const m of wholeLines(volumePath(root, index.volumes[q], name)).list) {
                const id = m && String(m.id ?? '');
                if (id && left.has(id)) { left.delete(id); found = q; }
            }
        }
        return found;
    }
    /* A message of the thread by its id, however old: in what is read, else read down to it. */
    #find(id, ok = () => true) {
        const hit = (t) => t.messages.find((m) => m.id === id && ok(m)) ?? t.open.find((m) => m.id === id && ok(m));
        let t = this.#model();
        let m = typeof id === 'string' && id ? hit(t) : undefined;
        if (!m && typeof id === 'string' && id && t.v0 > 0) {
            const q = this.#locate(this.#keep ?? this.#dir, readIndex(this.#keep ?? this.#dir), t.v0, [id]);
            if (q !== null) { t = this.#model({ v0: q }); m = hit(t); }
        }
        return { t, m };
    }

    /* THE SPLIT (see "The archive" in docs/protocol.md): made here only, never by the agent's side,
       when the current files pass the setting; counted for good SETTLE_MS later. */
    split() { return splitOf(this.#settings().split); }
    /* The setting, kept in the bridge folder (settings.json): { messages: N }, { days: D } or false. */
    setSplit(value) {
        const v = splitOf(value);
        mkdirSync(this.#dir, { recursive: true });
        writeJson(`${this.#dir}/${SETTINGS_FILE}`, { ...this.#settings(), split: v });
        return v;
    }
    #settings() { const v = jsonOf(`${this.#dir}/${SETTINGS_FILE}`); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    #split() {
        const dir = this.#dir;
        if (this.#keep && readIndex(this.#keep).moving) this.#settleKeep();
        const index = readIndex(dir);
        if (index.moving) { if (Date.now() - index.moving.since >= this.#settle) this.#settleSplit(); return; }
        const split = this.split();
        if (!split) return;
        const F = `${dir}/from-agent.jsonl`, T = `${dir}/to-agent.jsonl`;
        let due;
        if (split.messages) due = lineCount(F) + lineCount(T) >= split.messages;
        else {
            const t = Math.min(firstOf(F) ?? Infinity, firstOf(T) ?? Infinity);
            due = Number.isFinite(t) && this.#now().getTime() - t >= split.days * 86_400_000;
        }
        if (due) this.#begin();
    }
    #splitStep(what) { try { this.#onSplit?.(what); } catch { /* a hook that fails stops nothing */ } }
    /* A SPLIT BEGUN: the index says so first (`moving`, with what the files were), then each file is
       renamed into the archive and an empty one put in its place. The agent appends by opening the
       file each time: a line written meanwhile lands in the file renamed or in the new one, and both
       are read until the split is counted. With a keep folder, what is kept is split at once. */
    #begin() {
        const dir = this.#dir;
        const unlock = lock(dir);
        if (!unlock) return;
        try {
            const index = readIndex(dir);
            if (index.moving) return;
            if (this.#keep) for (const name of SIDES) this.#sync(name);
            const inoOf = (f) => { try { return lstatSync(f).ino; } catch { return null; } };
            const seen = this.#keep ? KEPT.get(`${this.#keep}/from-agent.jsonl`)?.seen?.n ?? null : null;
            writeIndex(dir, { volumes: index.volumes, moving: { since: Date.now(), from: inoOf(`${dir}/from-agent.jsonl`), to: inoOf(`${dir}/to-agent.jsonl`), ...(seen === null ? {} : { kept: seen }) } });
            this.#splitStep('marked');
            for (const name of ['to-agent.jsonl', 'from-agent.jsonl']) {
                const file = `${dir}/${name}`;
                if (existsSync(file)) renameSync(file, movingPath(dir, name));
                appendFileSync(file, '');
                this.#splitStep(`moved ${name}`);
            }
            if (this.#keep) this.#splitKeep();
        } finally { unlock(); }
    }
    /* THE SPLIT COUNTED: the files renamed away are cut into volumes (writeVolumes). With a keep
       folder, a line of the agent's that reached the file renamed after it was last compared has
       not been kept: it is kept now, as a new line. */
    #settleSplit() {
        const dir = this.#dir;
        const unlock = lock(dir);
        if (!unlock) return;
        try {
            const index = readIndex(dir);
            if (!index.moving) return;
            const { raw } = writeVolumes(dir, index, (name) => movingPath(dir, name), this.split());
            if (this.#keep && Number.isInteger(index.moving.kept)) {
                const late = raw['from-agent.jsonl'].slice(index.moving.kept);
                const own = `${this.#keep}/from-agent.jsonl`;
                const ids = idsOf(kept(own) ?? { lines: [] });
                const fresh = late.filter((l) => !(idOf(l) && ids.has(idOf(l))));
                if (fresh.length) keep(own, fresh);
            }
        } finally { unlock(); }
    }
    /* What is kept is split at once, the same way: nobody else writes there. */
    #splitKeep() {
        const root = this.#keep;
        const index = readIndex(root);
        writeIndex(root, { volumes: index.volumes, moving: { since: Date.now() } });
        for (const name of SIDES) {
            const own = `${root}/${name}`;
            if (existsSync(own)) renameSync(own, movingPath(root, name));
            writeFileSync(own, '');
            KEPT.delete(own);
        }
        this.#settleKeep();
    }
    #settleKeep() {
        const root = this.#keep;
        const index = readIndex(root);
        if (!index.moving) return;
        writeVolumes(root, index, (name) => movingPath(root, name), this.split());
        /* The bridge's new files are compared from their start. */
        for (const name of SIDES) { const e = kept(`${root}/${name}`); if (e) e.seen = null; }
    }
    /* Is every path opened the way it was when the thread was built? (`reach` may change its mind.) */
    #reachSame(s) { for (const [path, open] of s.paths) if (this.#open(path) !== open) return false; return true; }
    /* What the agent read (read.json): how far, and when. A message of the person is `seen` below
       that line; when the count or the reads moved, those whose `seen` or `seenAt` changed are
       made again, and the reactions whose `seen` changed. */
    #readsOf(s, text, toN) {
        const moved = text !== s.readText;
        if (moved) {
            s.readText = text;
            s.readCount = (() => { try { return Math.max(0, Number(JSON.parse(text).lines) || 0); } catch { return 0; } })();
            const reads = (() => { try { const r = JSON.parse(text).reads; return Array.isArray(r) ? r.filter((x) => x && Number.isInteger(x.lines) && typeof x.at === 'string') : []; } catch { return []; } })();
            /* The first read that reached line i is the first whose running highest count is above i. */
            let top = -Infinity;
            s.reachTop = reads.map((r) => (top = Math.max(top, r.lines)));
            s.reachAt = reads.map((r) => r.at);
        }
        const B = Math.min(s.readCount, toN);
        if (B === s.B && !moved) return;
        const [lo, hi] = [Math.min(B, s.B), Math.max(B, s.B)];
        s.B = B;
        const redo = (x) => {
            const seen = x.i < B, at = seen ? seenAtOf(s, x.i) : null;
            if (seen !== x.seen || at !== x.seenAt) { x.seen = seen; x.seenAt = at; x.e = null; s.dirty = true; }
        };
        if (moved) for (const x of s.persons) redo(x);
        else for (let i = Math.max(lo, s.toBase); i < hi && i - s.toBase < s.byLine.length; i += 1) if (s.byLine[i - s.toBase]) redo(s.byLine[i - s.toBase]);
        for (const [to, i] of s.reactionLine) {
            const r = s.reactions.get(to);
            if (r && r.seen !== i < B) { s.reactions.set(to, { ...r, seen: i < B }); touch(s, to); }
        }
    }
    /* One line of the agent, taken into the thread built. `ghost`: carried from a volume not read
       (see #ghosts): it counts, it is not shown -- a question among them is open only when
       carried as one ('open'). */
    #agentLine(s, m, i, bulk, ghost = false) {
        if (!m) return;
        const e = this.#fromAgent(m);
        s.place.set(e, i);
        if (e.kind === 'close') { if (!ghost) s.closeLines.push(e); s.closes.set(e.answers, { text: e.text, at: e.at }); touch(s, e.answers); return; }
        if (e.kind === 'pin') { s.puts.agent.push({ by: 'agent', to: e.pin, at: e.at, removed: e.removed === true }); s.putTo.add(e.pin); s.pinsDirty = true; return; }
        if (STEP.has(e.kind)) { if (!ghost) s.steps.push(e); s.lastStep = e; if (e.kind === 'status') s.lastStatus = e; return; }
        const x = { from: 'agent', m: e, at: e.at, i, e: null };
        if (!s.byId.has(e.id)) s.byId.set(e.id, []);
        s.byId.get(e.id).push(x);
        if (ghost) s.ghostById.set(e.id, e);
        else if (bulk) s.order.push(x); else { insertAt(s.order, x, (y) => y.from === 'person'); s.dirty = true; if (s.putTo.has(e.id)) s.pinsDirty = true; }
        if (e.kind === 'ask' && (!ghost || ghost === 'open')) s.asks.push(x);
        /* Every file it showed, and every one it cited that can be opened (once, and not when shown). */
        if (e.kind === 'show') {
            for (const f of e.files?.length ? e.files.map((g) => ({ path: g.path, note: g.title || e.text, at: e.at, open: g.open })) : [{ path: e.path, note: e.text, at: e.at, open: e.open }]) {
                s.shown.push(f); s.shownPaths.add(f.path);
                if (bulk) continue;
                const c = s.citeOf.get(f.path);
                if (c && !s.citeGone.has(c)) { s.citeGone.add(c); s.files.splice(s.files.indexOf(c), 1); }
                insertAt(s.files, f, (y) => y.cited === true);
            }
        }
        for (const r of e.refs ?? []) {
            if (s.shownPaths.has(r.path) || s.citeOf.has(r.path)) continue;
            const c = { path: r.path, note: '', at: e.at, open: r.open, cited: true };
            s.citeOf.set(r.path, c); s.cites.push(c);
            if (!bulk) insertAt(s.files, c, () => false);
        }
    }
    /* One line of the person, taken into the thread built: a reaction, a pin, or a message. */
    #personLine(s, m, i, bulk, ghost = false) {
        if (!m) return;
        /* A reaction is no message: it is put on the message it is about, the newest one standing. */
        if (typeof m.reaction === 'string') {
            if (typeof m.to !== 'string') return;
            if (m.removed === true) { if (s.reactions.get(m.to)?.id === m.reaction) { s.reactions.delete(m.to); s.reactionLine.delete(m.to); touch(s, m.to); } return; }
            s.reactions.set(m.to, { id: oneLine(m.reaction, 30), at: String(m.at ?? ''), seen: i < s.B });
            s.reactionLine.set(m.to, i);
            touch(s, m.to);
            return;
        }
        if (typeof m.pin === 'string') { s.puts.person.push({ by: 'person', to: m.pin, at: String(m.at ?? ''), removed: m.removed === true }); s.putTo.add(m.pin); s.pinsDirty = true; return; }
        const seen = i < s.B;
        const x = {
            from: 'person', i, e: null, seen, seenAt: seen ? seenAtOf(s, i) : null,
            m: { from: 'person', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: 'say', text: this.#named(clean(m.text)), choices: [] },
            more: { ...(m.answers ? { answers: String(m.answers), question: oneLine(m.question, 300) } : {}), ...(m.answers && Array.isArray(m.picked) ? { picked: m.picked.slice(0, 8).map((y) => oneLine(y, 200)).filter(Boolean) } : {}),
                ...(m.answers && Array.isArray(m.replies) ? { replies: m.replies.slice(0, GROUP_MAX).filter((r) => r && typeof r === 'object' && typeof r.id === 'string').map((r) => ({ id: oneLine(r.id, 30), ...(oneLine(r.label, 40) ? { label: oneLine(r.label, 40) } : {}), ...(Array.isArray(r.picked) ? { picked: r.picked.slice(0, 8).map((y) => oneLine(y, 200)).filter(Boolean) } : { text: clean(r.text).slice(0, 2000) }) })) } : {}), ...(m.re ? { re: String(m.re), quote: oneLine(m.quote, 300) } : {}), ...(Array.isArray(m.files) && m.files.length ? { files: this.#files(m.files) } : {}), ...(m.via === 'voice' ? { via: 'voice' } : {}), ...(aboutOf(m.about) ? { about: aboutOf(m.about) } : {}), ...(byOf(m.by) ? { by: byOf(m.by) } : {}), ...(m.room && typeof m.room === 'object' && oneLine(m.room.id, 80) ? { room: { id: oneLine(m.room.id, 80), name: oneLine(m.room.name, 60), ...(oneLine(m.room.message, 80) ? { message: oneLine(m.room.message, 80) } : {}) } } : {}) },
        };
        x.at = x.m.at;
        if (ghost) { s.ghostById.set(x.m.id, x.m); return; }
        s.persons.push(x); s.byLine[i - s.toBase] = x;
        if (x.more.answers) s.answered.add(x.more.answers);
        if (bulk) s.order.push(x); else { insertAt(s.order, x, () => false); s.dirty = true; if (s.putTo.has(x.m.id)) s.pinsDirty = true; }
    }
    /* A step, as handed over. */
    static #step(m) { return { id: m.id, kind: m.kind, state: m.state, note: m.text, at: m.at }; }
    /* What is the same whatever part of the thread is asked for. */
    #state(t) { return { waiting: t.open.length, status: t.status, pins: t.pins }; }

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
            const toN = this.#raw('to-agent.jsonl').length + this.#archived('to-agent.jsonl');
            const now = `${this.#raw('from-agent.jsonl').length + this.#archived('from-agent.jsonl')}.${toN}.${Math.min(readCount(this.#dir), toN)}`;
            if (String(o.since) === now) return { since: true, messages: [], steps: [], unread: Math.max(0, toN - readCount(this.#dir)), pulse: pulseOf(this.#dir, this.#now()), ...(this.#keep ? { altered: this.#altered() } : {}), cursor: now };
        }
        /* A part further back than what is read: read down to it, then answer (#part says how far). */
        let t = this.#model();
        for (let k = 0; k < 4; k += 1) {
            const r = this.#part(t, o);
            if (r.deeper === undefined || r.deeper >= t.v0) return r.answer ?? this.#part(t, o, true).answer;
            t = this.#model({ v0: r.deeper });
        }
        return this.#part(t, o, true).answer;
    }
    /* The answer of read() from the thread as read (t), or { deeper: v0 } when it needs the volumes
       from v0 on -- unless `last` (as deep as it went). Counts are the whole thread's: t.U messages
       are in the volumes not read. */
    #part(t, o, last = false) {
        const tail2 = () => ({ files: t.files, unread: t.unread, pulse: pulseOf(this.#dir, this.#now()), ...(this.#keep ? { altered: this.#altered() } : {}) });
        const deeper = (q) => (!last && t.v0 > 0 && q !== null && q < t.v0 ? { deeper: q } : null);
        if (!o) {
            const more = deeper(t.messages.length < SHOWN_MAX ? Parley.#deeper(t, SHOWN_MAX - t.messages.length) : null);
            if (more) return more;
            const messages = t.messages.slice(-SHOWN_MAX);
            /* Steps older than the first message kept would sit before a conversation that is no longer there. */
            const since = messages.length === SHOWN_MAX ? messages[0].at : '';
            return { answer: { messages, ...this.#state(t), steps: t.steps.filter((m) => m.at >= since).sort((a, b) => a.at.localeCompare(b.at)).slice(-STEPS_MAX).map(Parley.#step), ...tail2() } };
        }
        const cursor = `${t.fromN}.${t.toN}.${t.read}`;
        const was = o.since === undefined || o.since === null ? null : /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String(o.since));
        /* Only grown since: what is new, and what it changed. A file that shrank (a bridge rewritten, without a keep folder),
           or a cursor from before what is read: the window again. */
        if (was && Number(was[1]) <= t.fromN && Number(was[2]) <= t.toN && Number(was[3]) <= t.read && Number(was[1]) >= t.fromBase && Number(was[2]) >= t.toBase && Number(was[3]) >= t.toBase) {
            const [a, p, r] = [Number(was[1]), Number(was[2]), Number(was[3])];
            const touched = new Set([
                ...t.closeLines.filter((m) => t.place.get(m) >= a).map((m) => m.answers),
                ...t.toRaw.slice(p - t.toBase).filter((m) => m && typeof m.reaction === 'string' && typeof m.to === 'string').map((m) => m.to),
            ]);
            const changed = (m) => {
                const at = t.place.get(m);
                if (m.from === 'person') return at >= p || (at >= r && at < t.read);
                return at >= a || touched.has(m.id);
            };
            const tail = tail2();
            return { answer: { since: true, messages: t.messages.filter(changed), ...this.#state(t), steps: t.steps.slice(firstFrom(t.steps, t.place, a)).slice(-STEPS_MAX).map(Parley.#step),
                ...(a < t.fromN ? { files: t.files } : {}), unread: tail.unread, pulse: tail.pulse, ...(this.#keep ? { altered: tail.altered } : {}), cursor } };
        }
        const root = this.#keep ?? this.#dir;
        const list = t.messages;
        const where = (id) => list.findIndex((m) => m.id === String(id));
        const has = (k) => o[k] !== undefined && o[k] !== null;
        if (o.all === true) { const more = deeper(0); if (more) return more; }
        let end = list.length;
        let until = null;
        if (has('before')) {
            const i = where(o.before);
            if (i < 0) { const more = deeper(this.#locate(root, readIndex(root), t.v0, [String(o.before)])); if (more) return more; }
            end = i < 0 ? 0 : i;
            until = i < 0 ? null : list[i].at;
        }
        const count = (n, d) => (Number.isInteger(n) && n > 0 ? Math.min(n, PAGE_MAX) : d);
        let start;
        if (o.all === true) start = 0;
        else if (has('from') && has('before')) {
            const j = where(o.from);
            if (j < 0 && end > 0) { const more = deeper(this.#locate(root, readIndex(root), t.v0, [String(o.from)])); if (more) return more; }
            if (j >= 0 && j < CONTEXT) { const more = deeper(Parley.#deeper(t, CONTEXT - j)); if (more) return more; }
            start = j >= 0 && j < end ? Math.max(0, j - CONTEXT) : end;
        } else if (has('days') && o.last === undefined) {
            const days = Math.min(DAYS_MAX, Math.max(1, Number(o.days) || 1));
            const ref = until !== null && Number.isFinite(Date.parse(until)) ? Date.parse(until) : this.#now().getTime();
            const limit = new Date(ref - days * 86_400_000).toISOString();
            start = end;
            while (start > 0 && list[start - 1].at >= limit) start -= 1;
            if (start === 0 || end < LEAST) {
                /* The volumes whose newest line is in those days, and enough for LEAST. */
                let q = t.v0;
                while (q > 0 && t.vols[q - 1].last >= limit) q -= 1;
                const more = deeper(Math.min(q, end < LEAST ? Parley.#deeper(t, LEAST - end) : t.v0));
                if (more) return more;
            }
            start = Math.max(Math.min(start, end - LEAST), end - PAGE_MAX, 0);
        } else {
            const n = count(Number(o.last), WINDOW);
            if (end - n < 0) { const more = deeper(Parley.#deeper(t, n - end)); if (more) return more; }
            start = Math.max(0, end - n);
        }
        const page = list.slice(start, end);
        /* The newest window: the questions still open come with it, however old. */
        /* With no `before`, the page ends with the thread: a question not on it is older than it. */
        const onPage = new Set(page);
        const extra = !has('before') ? t.open.filter((q) => !onPage.has(q)) : [];
        const fromAt = page[0]?.at ?? null;
        const older = start + t.U;
        const steps = t.steps.filter((m) => (older === 0 || fromAt === null || m.at >= fromAt) && (until === null || m.at < until)).sort((a, b) => a.at.localeCompare(b.at)).slice(-STEPS_MAX).map(Parley.#step);
        return { answer: { messages: [...extra, ...page], ...this.#state(t), steps, ...tail2(),
            window: { before: older > 0 ? page[0]?.id ?? null : null, more: page.length ? older : 0, total: list.length + t.U, from: fromAt, until }, cursor } };
    }

    /* THE WHOLE THREAD SEARCHED, however little of it is shown: the messages whose words hold
       `text` (case aside; what Markdown marks aside), newest first, SEARCH_MAX at most, each
       with a few words around what was found; `count`, all of them. */
    search(text, { limit = SEARCH_MAX } = {}) {
        const q = oneLine(text, 200).toLowerCase();
        if (!q) return { matches: [], count: 0 };
        const words = (m) => [m.text, m.short, m.intro, m.kind === 'show' ? m.path : '', ...(m.files ?? []).map((f) => [f.title, f.name, f.path].filter(Boolean).join(' ')), ...(m.questions ?? []).map((x) => [x.question, ...x.choices].join(' ')), ...(m.choices ?? [])]
            .filter(Boolean).join('\n').replace(/\*\*|__|`|==/g, '');
        /* The whole thread: every volume read (the only part of Parley that reads them all). */
        const found = this.#model({ v0: 0 }).messages.map((m) => ({ m, w: words(m) })).filter((x) => x.w.toLowerCase().includes(q));
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
    /* THOSE WHO SPEAK HERE beside the person (#215): voice boxes, each { id, name }, set by the
       application. The agent addresses a message to some of them by id (tell --to); a screen
       shows their names of the moment. Kept in the folder, where the agent reads it too. */
    speakers() {
        try { const v = JSON.parse(readFileSync(`${this.#dir}/${SPEAKERS_FILE}`, 'utf8')); return Array.isArray(v) ? v.map(byOf).filter(Boolean).slice(0, SPEAKERS_MAX) : []; } catch { return []; }
    }
    setSpeakers(list) {
        const clean2 = (Array.isArray(list) ? list : []).map(byOf).filter(Boolean).slice(0, SPEAKERS_MAX);
        if (JSON.stringify(clean2) === JSON.stringify(this.speakers())) return clean2;
        writeFileSync(`${this.#dir}/${SPEAKERS_FILE}`, `${JSON.stringify(clean2)}\n`);
        return clean2;
    }

    /* THE ROOMS this agent is in (#215), set by the application, read by the agent's side to answer there. */
    rooms() {
        try { const v = JSON.parse(readFileSync(`${this.#dir}/${ROOMS_FILE}`, 'utf8')); return Array.isArray(v) ? v.map(roomOf).filter(Boolean).slice(0, ROOMS_MAX) : []; } catch { return []; }
    }
    setRooms(list) {
        const clean2 = (Array.isArray(list) ? list : []).map(roomOf).filter(Boolean).slice(0, ROOMS_MAX);
        if (JSON.stringify(clean2) === JSON.stringify(this.rooms())) return clean2;
        mkdirSync(this.#dir, { recursive: true });
        writeFileSync(`${this.#dir}/${ROOMS_FILE}`, `${JSON.stringify(clean2)}\n`);
        return clean2;
    }

    /* A ROOM'S THREAD (#215): the application writes both sides. What an AI said is put on the agent's side, signed
       by it (by: { id, name, kind: 'ai' }), for whom (to), and the message it answers (re). Never by an agent. */
    relay({ text, by, to, re, kind = 'say', path, files } = {}) {
        if (!this.#room) throw new RangeError('Only a room\'s thread is written by relay.');
        const who = byOf(by);
        const said = clean(text).trim();
        if (!who) throw new RangeError('Say who wrote it (by: id and name).');
        if (!said) throw new RangeError('Write something.');
        const entry = { id: randomUUID(), at: this.#now().toISOString(), kind: kind === 'doing' ? 'doing' : kind === 'show' ? 'show' : 'say', text: kind === 'doing' ? oneLine(said, 200) : said, by: who };
        /* A file an AI showed in the room (07-11): its paths as it gave them; the application opens them through its conversation. */
        if (entry.kind === 'show') {
            const p = oneLine(path, 1000);
            const list = Array.isArray(files) ? files.slice(0, SHOW_MAX).filter((f) => f && typeof f === 'object').map((f) => ({ path: oneLine(f.path, 1000), title: oneLine(f.title, 120) })).filter((f) => f.path) : [];
            if (!p && !list.length) throw new RangeError('Show a file (path or files).');
            entry.path = p || list[0].path;
            if (list.length) entry.files = list;
        }
        const ids = Array.isArray(to) ? to.map((x) => oneLine(x, 80)).filter(Boolean).slice(0, SPEAKERS_MAX) : [];
        if (ids.length) entry.to = ids;
        if (typeof re === 'string' && oneLine(re, 80)) entry.re = oneLine(re, 80);
        mkdirSync(this.#dir, { recursive: true });
        appendFileSync(`${this.#dir}/from-agent.jsonl`, `${JSON.stringify(entry)}\n`);
        return entry.id;
    }

    /* A ROOM'S THREAD has no agent of its own to read it (06-11: the clock stayed on every message): once the
       application has handed what was said to its AIs, it is read -- said here, as an agent's read would. */
    seen() {
        if (!this.#room) throw new RangeError('Only a room\'s thread is marked read by the application.');
        const lines = lineCount(`${this.#dir}/to-agent.jsonl`) + this.#archived('to-agent.jsonl', this.#dir);
        if (lines <= readCount(this.#dir)) return lines;
        const reads = [...readTimes(this.#dir), { lines, at: this.#now().toISOString() }].slice(-200);
        mkdirSync(this.#dir, { recursive: true });
        writeFileSync(`${this.#dir}/read.json`, JSON.stringify({ lines, reads }));
        return lines;
    }

    say(text, answers, files = [], { via, picked, replies, about, by, room } = {}) {
        const given = Array.isArray(files) ? files : [];
        if (given.length > FILES_MAX) throw new RangeError(`${FILES_MAX} files at most in one message.`);
        const attached = given.map((f) => ({ path: oneLine(f?.path, 1000), name: oneLine(f?.name, 200), size: Number.isInteger(f?.size) && f.size >= 0 ? f.size : undefined, note: oneLine(f?.note, NOTE_MAX) }));
        if (attached.some((f) => !f.path.startsWith('/'))) throw new RangeError('A file is given by its whole path.');
        /* Any message of the thread, however old: not only those a screen shows at first. */
        const asked = typeof answers === 'string' && answers ? this.#find(answers, (m) => m.from === 'agent' && ['say', 'ask', 'show'].includes(m.kind)).m : undefined;
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
        /* Said by another speaker of the person's side (a voice box, #215): its name, its id. */
        if (byOf(by)) entry.by = byOf(by);
        /* Said in a room (#215): which one, and its id there (what an answer in the room is linked to). */
        if (room && typeof room === 'object' && oneLine(room.id, 80) && oneLine(room.name, 60)) entry.room = { id: oneLine(room.id, 80), name: oneLine(room.name, 60), ...(oneLine(room.message, 80) ? { message: oneLine(room.message, 80) } : {}) };
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
        const target = this.#find(to, (m) => m.from === 'agent' && ['say', 'ask', 'show'].includes(m.kind)).m;
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

    /* THE PERSON PINS a message of the exchange, either side's (`on`: true), or
       unpins it (false): written to the agent like a reaction, with the words
       and the time of that message, so that it knows which one. PINS_MAX stand
       at most: a new one makes the oldest leave. The application is told
       (person-pinned). Resolves with read(). */
    pin(to, on = true) {
        const { t, m: target } = this.#find(to);
        if (!target) throw new RangeError('No such message.');
        const put = on !== false;
        if (put === t.pins.some((p) => p.id === target.id)) return this.read();
        const line = { id: randomUUID(), at: this.#now().toISOString(), text: '', pin: target.id, ...(put ? {} : { removed: true }), quote: oneLine(target.text || target.path || '', 200), toAt: target.at };
        this.#write([line]);
        const now = this.read();
        this.#tell({ type: 'person-pinned', message: line, on: put, unread: now.unread });
        return now;
    }

    /* The text that asks an agent to use Parley: English, in the person's
       language `lang`. The application types it, changes it, or does not. */
    invite(lang, options = {}) { return invitation({ ...options, lang }); }

    /* Starts announcing each thing the agent posts FROM NOW ON: agent-said,
       agent-asked, agent-showed, agent-status, agent-doing, agent-pinned. Resolves with a function that
       stops it. The file is looked at, nothing is pushed: what was posted
       while nobody listened is still in `read()`. Each line is announced
       once, by where it sits in the file, and only once it is whole. */
    listen({ every = 2000 } = {}) {
        const file = `${this.#dir}/from-agent.jsonl`;
        const stat = () => { try { const st = lstatSync(file); return st.isSymbolicLink() ? { size: 0, ino: null } : { size: st.size, ino: st.ino }; } catch { return { size: 0, ino: null }; } };
        const TYPES = { say: 'agent-said', ask: 'agent-asked', show: 'agent-showed', status: 'agent-status', doing: 'agent-doing', close: 'agent-closed', pin: 'agent-pinned' };
        const tell = (m) => { const message = this.#fromAgent(m); this.#tell({ type: TYPES[message.kind], message }); };
        if (this.#keep) {
            /* Kept: each line once it is kept, by its place in the copy, which only grows -- whatever the agent does to its
               file; a split of the copy moves its lines into the archive, never their places. */
            const total = () => this.#archived('from-agent.jsonl') + this.#sync('from-agent.jsonl').length;
            let known = total();
            const timer = setInterval(() => {
                let base, all;
                try { all = this.#sync('from-agent.jsonl'); base = this.#archived('from-agent.jsonl'); } catch { return; }
                if (known < base) for (const m of this.#archivedFrom('from-agent.jsonl', known)) if (m) tell(m);
                for (const line of all.slice(Math.max(0, known - base))) { const m = parsed(line); if (m) tell(m); }
                known = base + all.length;
            }, every);
            timer.unref?.();
            return () => clearInterval(timer);
        }
        let { size: offset, ino } = stat();
        let rest = Buffer.alloc(0);
        /* Whole lines read of this file, and the lines archived before it: where it stood, if it is split. */
        let lines = this.#raw('from-agent.jsonl').length, base = this.#archived('from-agent.jsonl', this.#dir);
        const look = () => {
            const st = stat();
            /* Split since (the file renamed away): what it took after the last look is in the archive. */
            if (ino !== null && st.ino !== ino) {
                for (const m of this.#archivedFrom('from-agent.jsonl', base + lines, this.#dir)) if (m) tell(m);
                offset = 0; rest = Buffer.alloc(0); lines = 0; ino = st.ino; base = this.#archived('from-agent.jsonl', this.#dir);
            }
            if (ino === null) ino = st.ino;
            const now = st.size;
            if (now < offset) { offset = 0; rest = Buffer.alloc(0); lines = 0; }        /* the file was started again */
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
                if (line) lines += 1;
                const m = line ? parsed(line) : undefined;
                if (m) tell(m);
            }
        };
        const timer = setInterval(look, every);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
