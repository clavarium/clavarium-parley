#!/usr/bin/env node
/* A BRIDGE BETWEEN A COMMAND-LINE AGENT AND AN APPLICATION WITH A SCREEN OF
 * ITS OWN. One file, no dependency, meant to be lifted out as it is.
 *
 * A command-line agent lives in a terminal: whoever does not read a terminal
 * cannot talk with it. This file gives the agent seven verbs -- TELL the
 * person it works for something, ASK something, SHOW a file, READ what was
 * written back, CLOSE a question answered another way, say its STATUS, say
 * what it is DOING now -- in two ways that
 * write the same files:
 *
 *   a command    `parley tell "..."` (bin/parley.mjs imports this file):
 *                any agent that can run a command can use it;
 *   MCP          `node parley-mcp.mjs [--dir FOLDER]`: for an agent that
 *                was given it as an MCP server, over standard input and
 *                output (JSON-RPC 2.0, one message per line).
 *
 * NOTHING HERE WAITS. A verb never blocks until a person answers: the agent
 * posts, and goes on or stops. When the person has written, the application
 * tells the agent, in one line of its own choosing, that a message arrived;
 * the agent then reads. So an answer may come two minutes or two days later.
 *
 * HOW IT REACHES THE APPLICATION: through two files in one folder, which the
 * application reads and writes from its side. No address, no port, no key.
 *   from-agent.jsonl  what the agent posted, one JSON object per line
 *   to-agent.jsonl    what was written to the agent, one JSON object per line
 *   read.json         how far the agent has read
 *   pulse.json        whether it is in a turn: written by its tool's hooks
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const VERSION = '0.17.15-next.1';
/* A message may be long: the screen folds it, and shows its short version first. */
export const TEXT_MAX = 16000;
/* Its short version: a title of one or two lines. */
export const SHORT_MAX = 200;
/* Kept whole up to this (see SHORT_KEPT in the host): the screen cuts it, never the agent's words. */
export const SHORT_KEPT = 1000;
/* A short version is a title of one or two lines; longer than this, the screen is likely to cut it,
   so the agent is told so (it would not see the cut otherwise). */
export const SHORT_LINE = 90;
/* What it is doing now is one short line: a screen shows it while it works. */
export const DOING_MAX = 200;
/* Its chat says it works and nothing new came for this long: reminded, under what a verb returns. */
export const STALE_SAID_MS = 10 * 60_000;
/* While working, this many messages (tell/ask/show) with no `doing` between them: reminded to post one.
   A count, not a timeout: the reminder is about keeping them posted step by step, and repeats each time. */
export const NUDGE_EVERY = 3;
export const CHOICES_MAX = 8;
/* Questions asked together, as one card: so many at most, each with an id the answer names. */
export const GROUP_MAX = 5;
export const LABEL_MAX = 40;
const GROUP_ID = /^[A-Za-z0-9_-]{1,30}$/;
/* Files shown at once, as one gallery; the title of each. */
export const SHOW_MAX = 12;
export const TITLE_MAX = 120;
export const STATES = ['working', 'waiting', 'done'];
export const FOLDER = '.parley';
/* A pulse that says the same is written again only after this long: a tool may pulse at every action. */
export const PULSE_EVERY_MS = 10_000;

/* A secret the host lifted out of a message (secret-scan.mjs): the agent reads WHERE to use it and how long
   it has left -- never the value. The marker carries the moment it clears, so the countdown is the parloir's,
   the same one the person sees as stars. */
const SECRET_REF_G = /⟨secret:(SECRET_[0-9A-F]{10})(?:@(\d+))?⟩/g;
const secretsForAgent = (text, now = Date.now()) => String(text ?? '').replace(SECRET_REF_G, (_m, name, at) => {
    const mins = at ? Math.round((Number(at) - now) / 60_000) : null;
    const when = mins === null ? 'it clears after a few minutes' : mins <= 0 ? 'it clears any moment now' : `it clears in about ${mins} min`;
    return `[a secret, at /run/secrets/${name} -- use it there, never print it; ${when}]`;
});
const plain = (value, max = TEXT_MAX) => secretsForAgent(String(value ?? '')).slice(0, max);
/* The agent's OWN text to send: refused whole when it is longer than the tool keeps, rather
   than cut in the middle of a sentence and sent in pieces. The agent is told the length and
   the limit so it shortens (or splits) and sends again; nothing is sent meanwhile. */
const whole = (value, max, what) => {
    const v = secretsForAgent(String(value ?? ''));
    if (v.length > max) throw new Error(`your ${what} is ${v.length} characters; this tool sends at most ${max}. Nothing was sent -- shorten it (or split it in two) and send again.`);
    return v;
};
/* THE END OF THE EXCHANGE (`read --last N`, `--days D`, `--all`): so many entries by default
   (`--all`: ALL_ENTRIES), LAST_MAX at most, and so many characters; `--days` gives LEAST at
   least. What is older is read with `--before ID`, page after page: never cut nor summarised. */
export const ALL_ENTRIES = 200;
export const ALL_CHARS = 100_000;
export const LAST_MAX = 1000;
export const DAYS_MAX = 366;
export const LEAST = 20;
/* Each line of a file that only grows, as an object, or null where it is not one: counted, and skipped. */
const lines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } }); } catch { return []; } };
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
/* The files the person attached to a message, one line each: where they are, for the agent to open. */
const attached = (m) => (Array.isArray(m.files) ? m.files.slice(0, 10).map((f) => `\n  Attached file: ${plain(f?.path, 1000)}${Number.isInteger(f?.size) ? ` (${size(f.size)})` : ''}${f?.note ? `\n    Their note on this file: ${plain(f.note, 500).replace(/\s+/g, ' ')}` : ''}`).join('') : '');
/* The short version of a message, when given: one or two lines. */
/* A message the person dictated: said so, for the words a recognizer got wrong. */
export const DICTATED = 'dictated: may hold recognition mistakes; ask when a key word seems wrong';
/* What each reaction of the default set asks of the agent. The person picks
   one on a message of the agent; the application may offer another set: an
   unknown one is given by its name. */
export const REACTION_MEANINGS = Object.freeze({
    agree: 'Agree (thumbs up): noted. It is NOT an authorization: do nothing because of it.',
    go: 'Go ahead: do what that message proposes. If it proposes several things, ask which one first.',
    disagree: 'Disagree: ask them what is wrong rather than guessing.',
    unclear: 'Not clear: explain that message more simply, without acting.',
    stop: 'STOP: stop what you are doing now, and do nothing more until they write.',
    redo: 'Do it another way: try a different approach to what that message did or proposes.',
    later: 'Later: do nothing about it for now.',
    love: 'Love it: noted, nothing to do.',
});
/* The choices they ticked, when a question let them tick several: the text says them too, for an older reader. */
const ticked = (m) => (Array.isArray(m.picked) ? m.picked.filter((c) => typeof c === 'string' && c.trim()).slice(0, CHOICES_MAX).map((c) => plain(c, 200).replace(/\s+/g, ' ').trim()) : null);
/* The answers to questions asked together: one line each, by its id and label. */
const repliesText = (m) => `\n${m.replies.slice(0, GROUP_MAX).filter((r) => r && typeof r === 'object').map((r, i) => {
    const t = ticked(r);
    const head = `  ${i + 1}. [${plain(r.id, 30)}]${r.label ? ` ${plain(r.label, LABEL_MAX)}` : ''}`;
    return t && t.length ? `${head}: ${t.length > 1 ? 'they ticked ' : ''}${t.map((c) => `"${c}"`).join(', ')}` : `${head}, in their own words: ${plain(r.text, 2000)}`;
}).join('\n')}`;
const answerText = (m) => { if (Array.isArray(m.replies)) return repliesText(m); const t = ticked(m); return t ? `they ticked ${t.length === 0 ? 'none' : t.map((c) => `"${c}"`).join(', ')}${plain(m.text).trim() && plain(m.text).trim() !== t.join('\n') ? `; they added: ${plain(m.text)}` : ''}` : plain(m.text); };
/* What they tapped to say it: a person of a family, a zone of a picture. */
const aboutText = (m) => {
    const a = m.about;
    if (!a || typeof a !== 'object' || !plain(a.label, 120).trim()) return '';
    const box = Array.isArray(a.box) && a.box.length === 4 && a.box.every((n) => typeof n === 'number') ? a.box.join(' ') : '';
    return ` (about "${plain(a.label, 120).replace(/\s+/g, ' ')}"${a.ref ? ` [${plain(a.ref, 300).replace(/\s+/g, '')}]` : ''}${box && a.picture ? `, the zone ${box} of ${plain(a.picture, 1000)}` : ''})`;
};
const reacted = (m) => {
    const name = plain(m.reaction, 30).replace(/[^a-z0-9-]/g, '');
    const target = `your message${m.toAt ? ` of ${plain(m.toAt, 40).slice(0, 16).replace('T', ' ')}` : ''}${m.quote ? ` "${plain(m.quote, 200).replace(/\s+/g, ' ')}"` : ''}`;
    if (m.removed === true) return `They took back their reaction "${name}" to ${target}.`;
    return `Reaction to ${target}: ${REACTION_MEANINGS[name] ?? `"${name}"`}`;
};
const brief = (short) => { const line = plain(short, SHORT_KEPT * 2).replace(/\s+/g, ' ').trim().slice(0, SHORT_KEPT); return line ? { short: line } : {}; };
/* The agent does not see the screen cut its short version: told when it is too long for a title of a line or two. */
const tooLong = (short) => (plain(short ?? '', SHORT_KEPT * 2).replace(/\s+/g, ' ').trim().length > SHORT_LINE
    ? ` Your short version is long (a title of one or two lines): the screen may cut it -- shorten it.` : '');
/* So many characters of a question's id are shown, and enough to close it. */
export const ID_SHOWN = 8;
/* A message's id as read shows it: what a card in a binder, or a reply, can point to. */
const shownId = (id) => (typeof id === 'string' ? id.slice(0, ID_SHOWN) : '');
/* How many reads are remembered, with their time: the screen says when each message was read. */
export const READS_KEPT = 200;
const isFolder = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/* WHICH FOLDER: the one given, else $PARLEY_DIR, else the nearest ".parley"
   from `from` up, as git finds its repository. Undefined when none is found. */
export function findFolder({ dir, env = process.env, from = process.cwd() } = {}) {
    if (dir) return resolve(from, dir);
    if (env.PARLEY_DIR) return resolve(from, env.PARLEY_DIR);
    for (let at = resolve(from); ; at = dirname(at)) {
        if (isFolder(join(at, FOLDER))) return join(at, FOLDER);
        if (dirname(at) === at) return undefined;
    }
}

/* The seven verbs on one folder. `how` is what the agent is told to do when a
   message arrives: run a command, or call a tool. */
export function bridge(dir, { how = 'run `parley read`', back = (id) => `parley read --before ${id}` } = {}) {
    const OUT = join(dir, 'from-agent.jsonl');
    const IN = join(dir, 'to-agent.jsonl');
    const READ = join(dir, 'read.json');
    const PULSE = join(dir, 'pulse.json');
    /* Requests to forget a short-lived secret, for the parloir (host) to act on: not part of the thread. */
    const FORGET = join(dir, 'forget.jsonl');
    const post = (entry) => {
        mkdirSync(dir, { recursive: true });
        const id = randomUUID();
        appendFileSync(OUT, `${JSON.stringify({ id, at: new Date().toISOString(), ...entry })}\n`);
        return id;
    };
    /* WHERE IT SAID IT IS: the newest of its states and of what it said it does -- a question it asked
       after it is waiting. { state, note, at } or null when it never said. */
    const standing = () => {
        const mine = lines(OUT).filter(Boolean);
        const last = mine.filter((m) => m.kind === 'status' || m.kind === 'doing').at(-1);
        if (!last) return null;
        const state = last.kind === 'doing' ? 'working' : STATES.includes(last.state) ? last.state : 'working';
        const asked = mine.some((m) => m.kind === 'ask' && String(m.at ?? '') >= String(last.at ?? ''));
        return { state: asked && state === 'working' ? 'waiting' : state, note: plain(last.text, DOING_MAX), at: String(last.at ?? '') };
    };
    /* Its chat still says it works, and has for a while: said under what a verb returns, so that it updates it. */
    const stale = () => {
        const s = standing();
        if (s?.state !== 'working' || Date.now() - Date.parse(s.at) < STALE_SAID_MS) return '';
        return `\nTheir screen still says you are working${s.note ? ` on "${s.note}"` : ''}, since ${Math.round((Date.now() - Date.parse(s.at)) / 60_000)} min: say what you do now or what still runs (parley doing "..."), or that you stopped with nothing still running and nothing for them to do (parley status done), or, only if you need their answer or action, parley status waiting.`;
    };
    /* KEEP THEM POSTED: while working, a short reminder when several messages have gone by with no
       `doing` between them -- decided from the use of the tools, not a timeout. It repeats every
       NUDGE_EVERY such messages, and stops as soon as a `doing` is posted. */
    const doingNudge = () => {
        const s = standing();
        if (s?.state !== 'working') return '';
        const mine = lines(OUT).filter(Boolean);
        const lastDoing = [...mine].reverse().find((m) => m.kind === 'doing');
        const since = mine.filter((m) => ['say', 'ask', 'show'].includes(m.kind) && String(m.at ?? '') > String(lastDoing?.at ?? ''));
        if (since.length < NUDGE_EVERY || since.length % NUDGE_EVERY !== 0) return '';
        const mins = lastDoing ? `, ${Math.round((Date.now() - Date.parse(lastDoing.at)) / 60_000)} min ago` : ' this turn';
        return `\nReminder: keep them posted -- post a short \`parley doing "..."\` as you move to each step (none in your last ${since.length} messages${mins}).`;
    };
    /* One reminder at most under a verb: the stale-state one when it applies, else the keep-posted one. */
    const nudge = () => stale() || doingNudge();
    /* SEVERAL QUESTIONS AT ONCE, one card: each one choice, several to tick, or free.
       The text says them all, for a screen or a reader that knows nothing of `questions`. */
    const group = (intro, questions, short) => {
        if (!Array.isArray(questions) || questions.length < 2) throw new Error('questions asked together are two at least');
        if (questions.length > GROUP_MAX) throw new Error(`${GROUP_MAX} questions at most at once`);
        const seen = new Set();
        const list = questions.map((q, i) => {
            if (!q || typeof q !== 'object') throw new Error(`question ${i + 1} is not an object`);
            const id = q.id === undefined ? `q${i + 1}` : plain(q.id, 60).trim();
            if (!GROUP_ID.test(id)) throw new Error(`question ${i + 1}: its id is letters, digits, - or _ (30 at most)`);
            if (seen.has(id)) throw new Error(`two questions have the id ${id}`);
            seen.add(id);
            const text = whole(q.question, 1000, `question ${i + 1}`).trim();
            if (!text) throw new Error(`question ${i + 1} is empty`);
            if (Array.isArray(q.choices) && q.choices.length > CHOICES_MAX) throw new Error(`question ${i + 1}: ${q.choices.length} choices; ${CHOICES_MAX} at most. Nothing was sent.`);
            const choices = Array.isArray(q.choices) ? q.choices.map((c, k) => whole(c, 200, `choice ${k + 1} of question ${i + 1}`).replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
            if (q.many === true && choices.length < 2) throw new Error(`question ${i + 1}: several choices to tick need two choices at least`);
            const label = whole(q.label ?? '', LABEL_MAX, `label of question ${i + 1}`).replace(/\s+/g, ' ').trim();
            return { id, ...(label ? { label } : {}), question: text, choices, ...(q.many === true ? { many: true } : {}) };
        });
        const lead = whole(intro ?? '', 2000, 'introduction').trim();
        if (short !== undefined) whole(short, SHORT_KEPT, 'short version');
        const text = `${lead ? `${lead}\n\n` : ''}${list.map((q, i) => `${i + 1}. ${q.question.replace(/\s+/g, ' ')}${q.choices.length ? ` (${q.many ? 'several: ' : ''}${q.choices.join(' / ')})` : ''}`).join('\n')}`;
        post({ kind: 'ask', text, choices: [], questions: list, ...(lead ? { intro: lead } : {}), ...brief(short) });
        return `Posted, ${list.length} questions as one card. Do not wait here: you will be told in the terminal when they answer; then ${how}.${tooLong(short)}${nudge()}`;
    };
    return {
        standing,
        tell(text, { short } = {}) {
            const body = whole(text, TEXT_MAX, 'message');
            if (!body.trim()) throw new Error('the text is empty');
            if (short !== undefined) whole(short, SHORT_KEPT, 'short version');
            post({ kind: 'say', text: body, ...brief(short) });
            return `Posted. They will read it on their screen.${tooLong(short)}${nudge()}`;
        },
        /* `many`: several of its choices may be ticked, sent together; a screen
           that does not know it shows them as single choices, which still answer. */
        ask(question, choices, { short, many = false, questions } = {}) {
            if (questions !== undefined) return group(question, questions, short);
            const body = whole(question, TEXT_MAX, 'question');
            if (!body.trim()) throw new Error('the question is empty');
            if (short !== undefined) whole(short, SHORT_KEPT, 'short version');
            if (Array.isArray(choices) && choices.length > CHOICES_MAX) throw new Error(`${choices.length} choices; ${CHOICES_MAX} at most. Nothing was sent.`);
            const picked = Array.isArray(choices) ? choices.map((c, k) => whole(c, 200, `choice ${k + 1}`).trim()).filter(Boolean) : [];
            if (many === true && picked.length < 2) throw new Error('several choices to tick need two choices at least');
            post({ kind: 'ask', text: body, choices: picked, ...(many === true ? { many: true } : {}), ...brief(short) });
            return `Posted. Do not wait here: you will be told in the terminal when they answer; then ${how}.${tooLong(short)}${nudge()}`;
        },
        /* A question they answered another way (a message typed later): closed
           by the agent, with the answer it understood. The screen says so; the
           person may still answer it with its buttons. `id`: the question's, or
           the first characters of it that `read` shows. */
        close(id, answer) {
            const given = plain(id, 100).trim().replace(/^\[|\]$/g, '');
            if (given.length < ID_SHOWN) throw new Error(`give the id of the question, as "read" shows it (${ID_SHOWN} characters at least)`);
            const said = whole(answer, 500, 'answer').replace(/\s+/g, ' ').trim();
            if (!said) throw new Error('say the answer you understood');
            const found = lines(OUT).filter((m) => m && m.kind === 'ask' && typeof m.id === 'string' && m.id.startsWith(given));
            if (found.length === 0) throw new Error(`no question has the id ${given}`);
            if (found.length > 1) throw new Error(`several questions start with ${given}: give more of it`);
            post({ kind: 'close', answers: found[0].id, text: said });
            return `Closed. Their screen shows the answer you understood; they may still correct it.${nudge()}`;
        },
        /* A relative path is the agent's own, from where it stands: it is
           posted whole, so that the application knows which file it is. */
        /* `target`: one path, or several files shown together as one gallery,
           each a path or { path, title }: a title says what it is ("Home page,
           before"), the name of the file is only the fallback. */
        show(target, note, { from = process.cwd() } = {}) {
            const list = (Array.isArray(target) ? target : [target]).map((f) => (f && typeof f === 'object' ? { path: plain(f.path, 1000), title: whole(f.title ?? '', TITLE_MAX, 'title').replace(/\s+/g, ' ').trim() } : { path: plain(f, 1000), title: '' }));
            if (list.length === 0 || list.some((f) => !f.path.trim())) throw new Error('the path is empty');
            if (list.length > SHOW_MAX) throw new Error(`${SHOW_MAX} files at most at once`);
            const files = list.map((f) => { const whole = resolve(from, f.path); if (!existsSync(whole)) throw new Error(`no such file: ${whole}`); return { path: whole, ...(f.title ? { title: f.title } : {}) }; });
            const several = Array.isArray(target) || files[0].title;
            post({ kind: 'show', path: files[0].path, text: whole(note ?? '', 500, 'note'), ...(several ? { files } : {}) });
            return `${files.length > 1 ? `Posted, as one gallery of ${files.length}. They can open them from their screen if they are in a folder they share with you.` : 'Posted. They can open it from their screen if it is in a folder they share with you.'}${nudge()}`;
        },
        status(state, note) {
            if (!STATES.includes(state)) throw new Error(`the state is one of: ${STATES.join(', ')}`);
            post({ kind: 'status', state, text: whole(note ?? '', 300, 'note') });
            return 'Noted.';
        },
        /* One line, said each time it moves to something new: it is shown while
           it works, and goes when its next message comes; what came before stays
           one click away. */
        doing(text) {
            const line = whole(text, DOING_MAX, 'line').replace(/\s+/g, ' ').trim();
            if (!line) throw new Error('the text is empty');
            post({ kind: 'doing', text: line });
            return 'Noted.';
        },
        /* FORGET A SHORT-LIVED SECRET given through the chat: ask the parloir (host) to drop it from its vault
           and the machine at once, before its few minutes are up. The name is the one `parley read` shows
           (/run/secrets/<name>). It is a request to the host, not part of the thread. */
        forget(name) {
            const n = String(name ?? '').trim();
            if (!/^SECRET_[0-9A-F]{10}$/.test(n)) throw new Error('give the name of a short-lived secret, as `parley read` shows it: SECRET_ then ten hex');
            mkdirSync(dir, { recursive: true });
            appendFileSync(FORGET, `${JSON.stringify({ at: new Date().toISOString(), name: n })}\n`);
            return 'Noted. The parloir will forget it.';
        },
        /* A sign of life from the agent's TOOL (its hooks), not from the agent:
           `busy` while it acts, false when its turn ended. No line, no event:
           one small file, rewritten whole. Not a verb, not an MCP tool. */
        pulse(busy = true, { now = new Date() } = {}) {
            const state = busy !== false;
            try {
                if (!lstatSync(PULSE).isSymbolicLink()) {
                    const was = JSON.parse(readFileSync(PULSE, 'utf8'));
                    if (was?.busy === state && now - new Date(was.at) >= 0 && now - new Date(was.at) < PULSE_EVERY_MS) return 'Noted.';
                }
            } catch { /* none yet */ }
            mkdirSync(dir, { recursive: true });
            const next = `${PULSE}.${process.pid}`;
            writeFileSync(next, JSON.stringify({ busy: state, at: now.toISOString() }));
            renameSync(next, PULSE);
            return 'Noted.';
        },
        /* What was written since the last read; `all`, `last`, `days`: the END of
           the exchange, both sides, oldest first -- for an agent that lost its
           memory (a restart, a new session) and must pick up the thread -- with
           how to read the part before it (`before`: the id it gives). Either way,
           everything is read afterwards. */
        read({ all = false, last, days, before } = {}) {
            const written = lines(IN);
            let seen = 0;
            try { seen = Number(JSON.parse(readFileSync(READ, 'utf8')).lines) || 0; } catch { /* nothing was read yet */ }
            if (seen > written.length) seen = 0;
            let reads = [];
            try { const r = JSON.parse(readFileSync(READ, 'utf8')).reads; if (Array.isArray(r)) reads = r.filter((x) => x && Number.isInteger(x.lines) && typeof x.at === 'string'); } catch { /* none kept yet */ }
            if (written.length > seen) reads = [...reads, { lines: written.length, at: new Date().toISOString() }].slice(-READS_KEPT);
            mkdirSync(dir, { recursive: true });
            writeFileSync(READ, JSON.stringify({ lines: written.length, reads }));
            /* The questions still open: neither answered nor closed. */
            const answered = new Set(written.map((m) => m?.answers).filter(Boolean));
            const posted = lines(OUT).filter(Boolean);
            const closed = new Set(posted.filter((m) => m.kind === 'close').map((m) => m.answers));
            const open = posted.filter((m) => m.kind === 'ask' && typeof m.id === 'string' && !answered.has(m.id) && !closed.has(m.id));
            const pending = open.length === 0 ? '' : `\nOpen questions (one they answered another way: close it with parley close ID "the answer you understood"):${open.slice(-10).map((m) => `\n  [${m.id.slice(0, ID_SHOWN)}] ${plain(m.text, 200).replace(/\s+/g, ' ')}`).join('')}`;
            const fromThem = (m) => (m.reaction ? reacted(m) : `${m.answers ? `They answered your question "${plain(m.question, 200)}": ` : m.re ? `They replied to your message "${plain(m.quote, 200)}"${m.via === 'voice' ? ` (${DICTATED})` : ''}: ` : m.via === 'voice' ? `They wrote (${DICTATED}): ` : 'They wrote: '}${m.answers ? answerText(m) : plain(m.text)}${aboutText(m)}${attached(m)}`);
            if (all || last !== undefined || days !== undefined || before !== undefined) {
                const theirs = written.flatMap((m, i) => (m ? [{ id: String(m.id ?? ''), at: String(m.at ?? ''), text: `${fromThem(m)}${i >= seen ? ' (new)' : ''}` }] : []));
                const mine = lines(OUT).filter((m) => m && ['say', 'ask', 'show', 'close'].includes(m.kind)).map((m) => ({ id: String(m.id ?? ''), at: String(m.at ?? ''),
                    text: m.kind === 'close' ? `You closed a question, the answer you understood being: ${plain(m.text, 500)}` : m.kind === 'ask' && Array.isArray(m.questions) ? `You asked them ${m.questions.length} questions at once: ${plain(m.text)}` : m.kind === 'ask' ? `You asked them: ${plain(m.text)}${Array.isArray(m.choices) && m.choices.length ? ` (${m.many === true ? 'several could be ticked' : 'choices'}: ${m.choices.map((c) => plain(c, 200)).join(', ')})` : ''}`
                        : m.kind === 'show' ? (Array.isArray(m.files) && m.files.length > 1 ? `You showed them ${m.files.length} files: ${m.files.map((f) => `${plain(f?.path, 1000)}${f?.title ? ` "${plain(f.title, 120)}"` : ''}`).join(', ')}${m.text ? ` (${plain(m.text, 500)})` : ''}` : `You showed them a file: ${plain(m.path, 1000)}${m.text ? ` (${plain(m.text, 500)})` : ''}`) : `You told them: ${plain(m.text)}` }));
                const every = [...mine, ...theirs].sort((a, b) => a.at.localeCompare(b.at));
                if (every.length === 0) return `Nothing was written yet, on either side.${pending}`;
                /* Older than the entry `before` (its id, or its first 8 characters or more). */
                let end = every.length;
                if (before !== undefined) {
                    const key = plain(before, 100).trim();
                    const i = key.length >= ID_SHOWN ? every.findIndex((e) => e.id === key || e.id.startsWith(key)) : -1;
                    if (i < 0) throw new Error(`no message has the id ${key}: give the id read shows ("parley read --before ID")`);
                    end = i;
                }
                let start;
                if (days !== undefined) {
                    const ref = end < every.length && Number.isFinite(Date.parse(every[end].at)) ? Date.parse(every[end].at) : Date.now();
                    const limit = new Date(ref - Math.min(DAYS_MAX, Math.max(1, Math.floor(Number(days)) || 1)) * 86_400_000).toISOString();
                    start = end;
                    while (start > 0 && every[start - 1].at >= limit) start -= 1;
                    start = Math.max(Math.min(start, end - LEAST), end - LAST_MAX, 0);
                } else start = Math.max(0, end - Math.min(LAST_MAX, Number.isInteger(last) && last > 0 ? last : ALL_ENTRIES));
                const page = every.slice(start, end);
                const both = page.map((e) => `[${e.at.slice(0, 16).replace('T', ' ')}${e.id ? ` ${shownId(e.id)}` : ''}] ${e.text}`);
                while (both.length > 1 && both.join('\n').length > ALL_CHARS) { both.shift(); page.shift(); start += 1; }
                if (both.length === 0) return `Nothing before that message.${pending}`;
                const older = start > 0 ? `\nOlder: ${start} more before these. To read them: ${back(page[0].id.slice(0, ID_SHOWN))}` : '\nNothing older: this is the start of the exchange.';
                const head = start === 0 && end === every.length ? `The whole exchange with the person, oldest first (${both.length}):` : end === every.length ? `The end of the exchange with the person, oldest first (the newest ${both.length} of ${every.length}):` : `An earlier part of the exchange with the person, oldest first (${both.length}, ${every.length - end} newer after them):`;
                return `${head}\n${both.join('\n')}${older}\nEnd of what was asked: everything is read now.${pending}`;
            }
            const fresh = written.slice(seen).filter(Boolean);
            if (fresh.length === 0) return `No new message.${pending}`;
            /* What they wrote is work: said, so that their screen shows it moving (or still, said so). */
            const next = stale() || (standing()?.state === 'working' ? '' : '\nWhen you start on it, say so: parley doing "what you do"; when you finish: parley status done.');
            const said = (m) => (m.reaction ? reacted(m) : `${m.answers ? `Answer to your question "${plain(m.question, 200)}": ` : m.re ? `Reply to your message "${plain(m.quote, 200)}"${m.via === 'voice' ? ` (${DICTATED})` : ''}: ` : m.via === 'voice' ? `Message (${DICTATED}): ` : 'Message: '}${m.answers ? answerText(m) : plain(m.text)}${aboutText(m)}${attached(m)}`);
            return `${fresh.map((m) => `${shownId(m.id) ? `[${shownId(m.id)}] ` : ''}${said(m)}`).join('\n')}${pending}${next}`;
        },
    };
}

/* ---- MCP ---- */
/* How an agent is asked to write, in every text it reads: the screen renders Markdown. */
export const WRITING = 'The chat renders Markdown: write as you do in your terminal -- short lists, a bold label per point, one idea per line, a heading or a short title when long, one key sentence in a "> [!IMPORTANT]" block (an action, a decision, a blocker). Tables, code blocks and mermaid diagrams are shown; ==text== is highlighted; [ok] [todo] [blocked] [warn] are small badges; a picture from a shared folder is shown where you put it, its text in brackets as its title under it, and pictures on one line side by side: ![Home page, before](/work/before.png) ![Home page, after](/work/after.png).';
/* Formulas, families, zones on pictures: drawn by the screen, and only when the topic calls for them. */
export const RICH = 'Only when the topic calls for it, never as decoration: a formula as $x^2$, or $$...$$ on lines of its own; an algorithm as short pseudo-code and, if it helps, a mermaid flowchart; a family as a ```family block -- one line per person or couple "A + B", children indented two spaces under them, "(dates)", ", note", an optional first line "# Grandparents | Parents | Children", and at most a few "A ~ B : brothers" for another kind of link; zones on a picture as a ```picture block -- first line ![title](/work/photo.jpg), then one line per zone: a label or ?, x y w h as fractions of the picture from its top left, a short line. [Label](ref) links what the application can open. Ask about one ? at a time: the answer comes back with its zone.';
export const GALLERY = 'Pictures that go together (before and after, several pages) are shown at once, as one gallery: give each a title that says what it is ("Home page, before"); the file name is not a title.';
export const SHORTER = 'For anything longer than a few lines, give a short version too (short): a title of one or two lines, shown first, the rest one tap away. Whatever asks them for an action or a decision, or says you are blocked, MUST be in the short version.';
/* Which form of question, when: one line an agent keeps. */
export const ASKING = 'Which form: one choice for a decision; several to tick when they pick which items to do, such as which batches to launch; no choices for an open question. They can always answer in their own words.';
export const GROUPING = `Several decisions you need at once: ask them together, as one card (${GROUP_MAX} questions at most, never more); each one choice, several to tick, or free.`;
export const TOOLS = [
    { name: 'tell', description: `Tell the person you work for something: where you are, what you did, what you found. They read it on their own screen, not in this terminal. It does not wait for an answer. ${WRITING} ${SHORTER} ${RICH}`,
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to tell them, in Markdown.' }, short: { type: 'string', description: 'Optional, for a long text: its title, one or two lines.' } }, required: ['text'] } },
    { name: 'ask', description: `Ask the person you work for a question, instead of asking it in the terminal. It does NOT wait: it posts the question and returns at once. Stop or go on with something else; you will be told in the terminal when a message arrives, then call read. A question they answered another way (a message typed later): close it with close. ${ASKING} Several to tick: many: true. ${GROUPING} Together: questions, instead of question and choices. ${WRITING} ${RICH}`,
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional: the answers they can pick from.' }, many: { type: 'boolean', description: 'Optional, with two choices or more: they may tick several, sent together; read lists those ticked.' },
            questions: { type: 'array', maxItems: GROUP_MAX, description: `Optional: 2 to ${GROUP_MAX} questions asked together, as one card, answered with one Send; read gives each answer by its id. question is then an optional introduction.`,
                items: { type: 'object', properties: { id: { type: 'string', description: 'Short, letters, digits, - or _: the answer names it.' }, label: { type: 'string', description: 'A word or two for its tab, in their language.' }, question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, many: { type: 'boolean' } }, required: ['question'] } }, short: { type: 'string', description: 'Optional, for a long question: its title, one or two lines.' } } } },
    { name: 'show', description: `Point the person you work for to a file you made (a report, a picture, a page), or to several at once, so that they can open them from their screen. ${GALLERY} Put them in a folder you share with them.`,
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The path of one file.' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string', description: 'What it is, in their language: "Home page, before".' } }, required: ['path'] }, description: `Several files shown together (${SHOW_MAX} at most), each with its title.` }, paths: { type: 'array', items: { type: 'string' }, description: 'Several files, without titles (prefer files, with titles).' }, note: { type: 'string', description: 'One line on what it is, common to all.' } } } },
    { name: 'read', description: 'Read what was written to you since you last read: new instructions, answers to your questions, files they attached, their reactions to your messages (only "go ahead" authorizes what a message proposes; "stop" means stop now), and the questions still open with their ids. A message they dictated is said so: it may hold recognition mistakes. Call it when you are told a message arrived, and before you finish a task. After a restart, to pick up the thread: last (the newest messages, both sides, oldest first) or days; it says how to read further back (before: the id it gives). The exchange is kept whole: read back as far as you need. Each message comes with its id: what a card or a reply can point to.',
        inputSchema: { type: 'object', properties: { last: { type: 'integer', description: `Optional: the newest so many messages of the exchange, both sides (${LAST_MAX} at most).` }, days: { type: 'integer', description: 'Optional: the messages of the last so many days.' }, before: { type: 'string', description: 'Optional, with last or days: the part before this message (the id read gave).' }, all: { type: 'boolean', description: `Optional: the newest ${ALL_ENTRIES} messages of the exchange.` } } } },
    { name: 'close', description: 'Close a question of yours that they answered another way (in a message typed later, not with its buttons), saying the answer you understood. Their screen shows it; they may still correct it. The id is the one read shows.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id of the question, as read shows it.' }, answer: { type: 'string', description: 'The answer you understood, in one line.' } }, required: ['id', 'answer'] } },
    { name: 'doing', description: 'Say in one short line what you are doing right now ("reading the 12 recordings", "running the tests"), each time you move to something new. Their screen shows it while you work, and keeps what came before. It does not wait.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'One short line, in their language.' } }, required: ['text'] } },
    { name: 'status', description: 'Say in one word where you are, so that their screen shows it: "working" when you start; "done" when you stop and they have nothing to do; "waiting" only when you need their answer or action (it puts them on alert).',
        inputSchema: { type: 'object', properties: { state: { type: 'string', enum: STATES }, note: { type: 'string', description: 'Optional: one short line.' } }, required: ['state'] } },
    { name: 'forget', description: 'Forget a short-lived secret the person pasted in the chat, once you are done with it: the parloir drops it from its store and the machine at once, before its few minutes are up. The name is the one read shows, at /run/secrets/<name>. It clears itself anyway if you do not.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The secret\'s name, as read shows it (SECRET_ then ten hex).' } }, required: ['name'] } },
];

export function serve(dir, { input = process.stdin, output = process.stdout } = {}) {
    const verbs = bridge(dir, { how: 'call read', back: (id) => `call read with before: "${id}"` });
    const call = (name, args = {}) => {
        if (name === 'tell') return verbs.tell(args.text, { short: args.short });
        if (name === 'ask') return verbs.ask(args.question, args.choices, { short: args.short, many: args.many === true, ...(args.questions !== undefined ? { questions: args.questions } : {}) });
        if (name === 'close') return verbs.close(args.id, args.answer);
        if (name === 'show') return verbs.show(Array.isArray(args.files) ? args.files : Array.isArray(args.paths) ? args.paths : args.path, args.note);
        if (name === 'read') return verbs.read({ all: args.all === true, ...(Number.isInteger(args.last) ? { last: args.last } : {}), ...(Number.isInteger(args.days) ? { days: args.days } : {}), ...(typeof args.before === 'string' ? { before: args.before } : {}) });
        if (name === 'status') return verbs.status(args.state, args.note);
        if (name === 'doing') return verbs.doing(args.text);
        if (name === 'forget') return verbs.forget(args.name);
        throw new Error(`unknown tool: ${name}`);
    };
    const send = (message) => output.write(`${JSON.stringify(message)}\n`);
    createInterface({ input }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (!m || typeof m !== 'object' || m.id === undefined) return;         /* a notification: nothing to answer */
        const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'parley', version: VERSION } });
        if (m.method === 'ping') return ok({});
        if (m.method === 'tools/list') return ok({ tools: TOOLS });
        if (m.method === 'tools/call') {
            try { return ok({ content: [{ type: 'text', text: call(m.params?.name, m.params?.arguments ?? {}) }] }); }
            catch (error) { return ok({ content: [{ type: 'text', text: `Not done: ${error.message}` }], isError: true }); }
        }
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    });
}

/* Run as a program: the MCP server. Its folder is --dir, else $PARLEY_DIR,
   else the folder it was put in by an application (install(), next to the
   two files), else the nearest .parley from where it was started. */
const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const at = process.argv.indexOf('--dir');
    const given = at > 0 ? process.argv[at + 1] : undefined;
    const beside = existsSync(join(dirname(HERE), 'from-agent.jsonl')) ? dirname(HERE) : undefined;
    serve(findFolder({ dir: given ?? (process.env.PARLEY_DIR ? undefined : beside) }) ?? beside ?? dirname(HERE));
}
