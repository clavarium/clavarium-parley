/* THE ARCHIVE OF A THREAD: split, never cut.
 *
 * A thread of months is two files of hundreds of thousands of lines. Only the host splits them
 * (see docs/protocol.md, "The archive"): the agent's side only appends, and only reads what was
 * split. These are the small parts both host paths share: the setting, the index, the names of
 * the volumes, where a thread is cut, and a lock so that two hosts never split at once.
 * Nothing here parses a message: what a line means stays in parley-host.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync, openSync, closeSync, writeSync, readSync } from 'node:fs';

export const SETTINGS_FILE = 'settings.json';
export const ARCHIVE = 'archive';
export const INDEX = 'index.json';
export const SIDES = Object.freeze(['from-agent.jsonl', 'to-agent.jsonl']);
/* The side's key in an entry of the index. */
/* What tells a file of lines from another, on any folder (a mounted one changes inodes): a hash of
   its first line, which says its own id and time. The agent's side computes it the same way
   (server/parley-mcp.mjs, headOf). */
export const headOf = (line) => (line ? createHash('sha256').update(line).digest('hex').slice(0, 16) : null);
export const keyOf = (name) => (name === 'from-agent.jsonl' ? 'from' : 'to');
/* BY DEFAULT a thread is split once both files hold so many lines together. A thread below it is
   never touched, and reads exactly as it always did. */
export const SPLIT = Object.freeze({ messages: 5000 });
export const SPLIT_LEAST = 10;
export const SPLIT_DAYS_MAX = 3660;
/* A file renamed away may still take a line from a writer that opened it just before: the volume
   is counted and written for good only this long after (milliseconds). */
export const SETTLE_MS = 2000;
const LOCK_STALE_MS = 30_000;

/* The setting, as kept in settings.json ({ split }): { messages: N } (lines of both files, steps
   included), { days: D } (a volume spans D days at most; 1 is a day, 0.5 half of one), or false
   (never split). Anything else is the default. */
export function splitOf(v) {
    if (v === false) return false;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (Number.isInteger(v.messages) && v.messages >= SPLIT_LEAST && v.messages <= 10_000_000) return { messages: v.messages };
        if (typeof v.days === 'number' && Number.isFinite(v.days) && v.days > 0 && v.days <= SPLIT_DAYS_MAX) return { days: v.days };
    }
    return { ...SPLIT };
}
export const jsonOf = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
/* Written whole, through a file beside it renamed over it: a reader sees the old one or the new one. */
export function writeWhole(file, text) {
    const next = `${file}.${process.pid}.next`;
    writeFileSync(next, text);
    renameSync(next, file);
}
export const writeJson = (file, value) => writeWhole(file, `${JSON.stringify(value)}\n`);

/* THE INDEX of a folder's archive: { volumes: [{ name, from: { lines }, to: { lines }, messages,
   entries, first, last, src? }], moving? }, oldest first. `moving`: a split begun, its files
   renamed to archive/moving.<side>, not yet counted. */
const NAME = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ--\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ(\.\d{1,6})?$/;
const sideOk = (x) => x && typeof x === 'object' && Number.isInteger(x.lines) && x.lines >= 0;
const volumeOk = (v) => v && typeof v === 'object' && NAME.test(String(v.name)) && sideOk(v.from) && sideOk(v.to) && Number.isInteger(v.messages);
export function indexOf(text) {
    let v = null;
    try { v = JSON.parse(text); } catch { /* no archive yet */ }
    const volumes = Array.isArray(v?.volumes) ? v.volumes.filter(volumeOk) : [];
    return { volumes, ...(v?.moving && typeof v.moving === 'object' && Number.isFinite(v.moving.since) ? { moving: v.moving } : {}) };
}
const INDEXES = new Map();
/* The index of a folder, read again only when it changed. */
export function readIndex(root) {
    const file = `${root}/${ARCHIVE}/${INDEX}`;
    let stamp = null;
    try { const st = statSync(file); stamp = `${st.size}:${st.mtimeMs}:${st.ino}`; } catch { INDEXES.delete(file); return { volumes: [], stamp: 'none' }; }
    const known = INDEXES.get(file);
    if (known?.stamp === stamp) return known;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* gone meanwhile */ }
    const entry = { ...indexOf(text), stamp };
    INDEXES.set(file, entry);
    return entry;
}
export function writeIndex(root, index) {
    mkdirSync(`${root}/${ARCHIVE}`, { recursive: true });
    const { stamp, ...kept } = index;
    writeJson(`${root}/${ARCHIVE}/${INDEX}`, kept);
}
export const volumePath = (root, v, name) => `${root}/${ARCHIVE}/${v.name}.${name}`;
export const carryPath = (root, v) => `${root}/${ARCHIVE}/${v.name}.carry.json`;
export const movingPath = (root, name) => `${root}/${ARCHIVE}/moving.${name}`;

/* A time as a volume is named by: to the second, sortable, with no colon (a file name anywhere). */
export const stampOf = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
/* The name of a volume spanning `first` to `last` (times), not one of `taken`. */
export function volumeName(first, last, taken) {
    const base = `${stampOf(first)}--${stampOf(last)}`;
    if (!taken.has(base)) return base;
    for (let k = 2; ; k += 1) if (!taken.has(`${base}.${k}`)) return `${base}.${k}`;
}

/* WHERE A THREAD IS CUT: both sides walked together, the earlier line first (the agent's on a
   tie), each side kept in the order of its file -- a volume holds a run of lines of each, so a
   line's place never moves. By count: volumes of about the same size, `messages` lines each at
   least. By time: a new volume once a line is `days` after the first of the one it is in.
   Gives the end of each volume on each side, [fromEnd, toEnd], the last one the end of both. */
export function cutsOf(from, to, split) {
    const atOf = (m) => (m && typeof m.at === 'string' ? m.at : '');
    const total = from.length + to.length;
    const per = split?.messages ? Math.ceil(total / Math.max(1, Math.floor(total / split.messages))) : 0;
    const span = split?.days ? split.days * 86_400_000 : 0;
    const ends = [];
    let i = 0, j = 0, n = 0, start = null;
    while (i < from.length || j < to.length) {
        const fromFirst = j >= to.length || (i < from.length && atOf(from[i]) <= atOf(to[j]));
        const t = Date.parse(atOf(fromFirst ? from[i] : to[j]));
        if (span && Number.isFinite(t)) {
            if (start === null) start = t;
            else if (t - start >= span && n > 0) { ends.push([i, j]); n = 0; start = t; }
        }
        if (fromFirst) i += 1; else j += 1;
        n += 1;
        if (per && n >= per && (i < from.length || j < to.length)) { ends.push([i, j]); n = 0; }
    }
    ends.push([from.length, to.length]);
    return ends;
}
/* The first and last times the lines say (null when none does). */
export function spanOf(lists) {
    let lo = Infinity, hi = -Infinity;
    for (const list of lists) for (const m of list) { const t = Date.parse(m?.at); if (Number.isFinite(t)) { if (t < lo) lo = t; if (t > hi) hi = t; } }
    return Number.isFinite(lo) ? [lo, hi] : null;
}

/* The time the first line of a file says, read from its first bytes only. */
export function firstAt(file) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const buf = Buffer.alloc(8192);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const nl = buf.subarray(0, n).indexOf(0x0a);
        if (nl < 0) return null;
        const t = Date.parse(JSON.parse(buf.toString('utf8', 0, nl))?.at);
        return Number.isFinite(t) ? t : null;
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/* One split at a time, whatever the number of hosts on the folder: a file made only if absent.
   One left by a host that stopped half way is taken back after LOCK_STALE_MS. */
export function lock(root) {
    const file = `${root}/${ARCHIVE}/lock`;
    for (let k = 0; k < 2; k += 1) {
        try {
            mkdirSync(`${root}/${ARCHIVE}`, { recursive: true });
            const fd = openSync(file, 'wx');
            writeSync(fd, String(Date.now()));
            closeSync(fd);
            return () => { try { unlinkSync(file); } catch { /* gone already */ } };
        } catch {
            try { if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) unlinkSync(file); else return null; } catch { return null; }
        }
    }
    return null;
}
