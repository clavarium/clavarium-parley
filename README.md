# Clavarium Parley

A bridge between a command-line agent and a screen of its own.

A command-line agent lives in a terminal. Whoever does not read a terminal
cannot talk with it. Parley gives the agent seven verbs, as a command and as
an MCP server, and gives an application a small library that shows the
exchange as a conversation, on any screen.

It is part of the Clavarium family and needs nothing of Clavarium: any
application, any agent that can run a command.

## The seven verbs

| The agent runs | To |
|---|---|
| `parley tell [--short "title"] "text"` | say where it is, what it did, in Markdown; a long text with its short version |
| `parley ask "question" [choice ...]` | ask, with or without choices; it does not wait |
| `parley show path ["note"]` | point to a file it made; several at once, each with its title: `parley show a.png="Home, before" b.png="Home, after"`, one gallery |
| `parley doing "text"` | say in one line what it is doing now, at each new step |
| `parley read` | read what was written to it, answers and attached files included, and its questions still open |
| `parley close ID "answer"` | close a question the person answered another way |
| `parley read --all` | the whole exchange, both sides: to pick up the thread after a restart |
| `parley status working\|waiting\|done ["note"]` | say where it is |

`parley --help` says all of it to the agent. The same seven verbs are an MCP
server (`parley-mcp`, or `node server/parley-mcp.mjs --dir FOLDER`) for an
agent that is given it that way; both write the same files.

Nothing waits: the agent posts, and is told in one line when a message
arrived. See [docs/protocol.md](docs/protocol.md).

## Parley announces, the application decides

| Event, to `on(event)` | Carries | An application may |
|---|---|---|
| `person-wrote` | the message, how many the agent has not read | type `WAKE` in the agent's terminal, now or later |
| `agent-said` | the message | show it |
| `agent-asked` | the question and its choices | show buttons, ring a phone |
| `agent-showed` | the path, and how to open it (`open`, or `null`) | show a link, or say it is not in a shared folder |
| `agent-status` | `working`, `waiting` or `done`, and a note | show it; ring a phone on `waiting` |
| `agent-doing` | one line: what it is doing now | show it while it works; nothing more |
| `person-reacted` | the reaction, and whether the set says it wakes (`false`, `true`, `'now'`) | tell the agent now, later, or with the next message |

| Action | Does |
|---|---|
| `say(text, answers, files, {via})` | writes what the person said (`answers`: the message it answers or replies to; `via: 'voice'`: dictated) |
| `react(to, reaction)` | puts a reaction of the set on a message of the agent, or takes it back (`null`) |
| `read()` | the exchange: messages, open questions, status, steps (states and what it did, in order), files, unread |
| `invite(lang, { install, shared })` | the text that asks an agent to use Parley, in English, saying the person's language |

Parley types nothing anywhere. `WAKE` (`You have a new message: run "parley
read".`) and the invitation are texts an application uses as they
are, changes, or does not use.

## The pieces

| Piece | File | What it is |
|---|---|---|
| The agent's side | `server/parley-mcp.mjs`, `bin/parley.mjs` | the seven verbs, as an MCP server and as a command; no dependency |
| The application's side | `host/parley-host.mjs` | reads and writes the files, cleans what the agent wrote, announces events |
| The screen | `ui/parley-ui.js`, `ui/parley-ui.css` | the exchange in two views, simple and detailed; no framework |
| The words | `ui/texts/en.json`, `ui/texts/fr.json` | one dictionary per language |
| The icons | `ui/parley-icons.js` | the Lucide icons used, as data, with their version and licence (ISC; MIT for those of Feather); `icon(name)`, `fileIcon(name)` for an application's own buttons too |

## Use it

    import { install, Parley, WAKE, texts } from 'clavarium-parley/host';

    install('/path/to/work/.parley');      // the folder, once
    const parley = new Parley('/path/to/work/.parley', {
        on: (event) => { /* person-wrote: get WAKE to the agent, your way; agent-asked: alert, or not */ },
        reach: (path) => (path.startsWith('/work/') ? path : null),   // what the person can open
    });
    parley.listen();
    typeInTheAgentsTerminal(parley.invite('fr', { install: 'npm install -g /path/to/clavarium-parley-0.8.0.tgz', shared: '/work' }));

and in a page:

    import { mount } from 'clavarium-parley/ui';
    mount(element, { load, send, words: texts('fr', operatorsOwn), open, terminal, view: 'simple',
        voice: yourDictation, replies: yourReadyAnswers });

The command is installed from the archive `npm pack` makes, by the
application or by the agent: `npm install -g clavarium-parley-0.8.0.tgz`,
then `parley --help`. Installing it runs no script of its own. It finds
its folder as git finds a repository: the nearest `.parley` from where it
stands, or `--dir`, or `$PARLEY_DIR`.

## The screen

Two views of one exchange, and a person picks one:

| | Simple | Detailed |
|---|---|---|
| Messages | the agent's across a reading column, rendered from Markdown; the person's in bubbles on the right, each with a sign of where it is (sent, read, worked on; handled: no sign); the time on hover, or a long press | the same, each with its time, every sign |
| Long messages | the short version first, or folded after about twelve lines; its IMPORTANT box in sight | unfolded |
| While it works | one line, moving: what it does now; gone when its next message comes; what came before it one click away | the same line, and every step of this turn above it |
| Steps it went through | folded into the message they led to: a click on it opens them ("5 steps" is said with its time) | unfolded between the messages, each with its time and state |
| Where it is | when it waits for the person: once, at the end of the thread, until they write; done: once, quietly, while it is the last thing that happened | the same; at the top, what it does now, or the state it said when the end does not say it; on the side, what it does now and its machine (`about`, given by the application) |
| Its newest message | never folded nor cut: nothing seems left below it | unfolded |
| Reactions | on its messages: a button on hover, a right click or a long press; eight, each with its word | the same |
| Pictures | in their place, their title under them; several shown at once, one gallery; large: grown out of the thumbnail, zoomed, a strip of the others, closed with a tap; "Media and files" in the menu | the same, with each file's name |
| Files | the ones the person can open, by name | every one, with its path; one that cannot be opened is said so |
| Its terminal | | a way to it |

In both, the day is said when it changes, and the time when long passed
between two messages, as a chat does.

## The box, and the slots an application fills

Parley draws the box; what it holds that Parley cannot know, the application
gives it. Without a slot, nothing of it is shown.

| Slot | The application gives | The box shows |
|---|---|---|
| `react` | `(to, reaction)`: puts a reaction on a message of the agent (`null`: taken back); `reactions` replaces the set (`[{ id, icon }]`) | the reactions on its messages |
| `agentName`, `agentTool` | the name said above its messages (default: the dictionary's neutral word), the tool, small, in the detailed view | |
| `voice` | `{ listen(on) }`: opens a microphone, calls `on.phrase(text)`, `on.state(word)`, `on.speech()`, `on.error(message)`; resolves with a function that closes it | a button beside Send; what is said goes into the box; while it listens, the box itself says what it does (its placeholder, and a small label on its frame), so that nothing on the screen moves; Send pressed while a phrase is still being written sends it once written |
| `autoSend`, `onAutoSend(on)` | the device's choice, kept by the application | "send by itself when I stop talking", in the small menu of settings beside the view (only with `voice`); while it is on, the microphone button wears a dot |
| `replies` | `[{ label, text, send }]`, or later `handle.replies = [...]` | ready answers above the box: `send` sends at once, else the text is put in the box; one line, the rest behind "N more" |
| `enter` | `'auto'`, `'send'` or `'newline'` | Enter sends with a keyboard (`auto`), is a new line on a touch screen; Shift+Enter a new line and Ctrl+Enter sends, always |
| `touch` | true on a touch screen (default: any coarse pointer) | the box is never focused by the page, only by a finger: the keyboard never comes up by itself, and a tap on a button of the box leaves it open |
| `attach` | `{ upload(file, name) }`, resolving with `{ path, name, size }`: where the agent finds the file | a button beside the box picks files; they are shown above it until sent; on Send each is uploaded, then the message goes with them (files alone are a message); in the thread, by name in the person's bubble |

Lines of the application -- what happened around the agent, such as its
machine short of memory -- are given with the messages (`from: "system"`) and
shown as grey lines across the thread with their time and buttons, which call
the application's `act(id, line)`. See the protocol.

When the agent asks with choices, they are answered in its message; once
that message has scrolled away (or a keyboard took the room), the same
choices come first above the box, never twice on the screen. Every size is
in `em` and `rem`: the page's text size is the box's.

## Words

What an agent reads (the help, the MCP descriptions, the invitation, the
wake line) is English only; the invitation tells it the person's language.
What a person reads comes from a dictionary per language, chosen by `lang`;
a missing word is the English one. An application may pass its own
dictionary, whole or partial, which replaces any word whatever it says:
`texts(lang, own)`. Every word is put on the page as text, never as markup.
A language is added with one file.

## What was tried, and what was not

Tried for real, once, with the MCP server (version 0.1): an agent (OpenCode,
on hosted open models) in its own machine; an application (Clavarium)
showing the exchange. Invited, the agent said it was ready through `tell` in
19 seconds; told a message arrived, it read it, did the job, and asked a
question with two choices through `ask`; answered with one touch on the
page, it read the answer and went on.

Tried for real with version 0.2 (OpenCode, on hosted open models): the
`parley` command installed by the agent from its archive, `tell`, `ask`,
`show` and `status`, an answer given ten minutes later, and the two views in
a real page.

Not tried yet with a real agent: version 0.8 -- several files shown at once with their titles, reactions, dictated messages, done said once, the media of a thread, the viewer, the side of the detailed view (tested here and in an application's own end-to-end runs, the screen checked on a real thread replayed); Markdown, short versions, `close` and the signs of each message (version 0.7, tested here and in an application's own end-to-end runs, the screen checked on a real thread replayed); `doing` and the line of what it does now
(version 0.3, tested here with stand-ins); the box's slots (version 0.4:
dictation, ready answers, the keyboard of a phone), tested in an
application's own end-to-end runs with a recorded voice and an emulated
phone, not yet by a person on a real phone; files attached by the person,
lines of the application and `read --all` (version 0.5), tested here and in an
application's own end-to-end runs, not yet with a real agent; any agent but OpenCode; an answer
coming hours later; a mirror between two agents.

## Licence

MIT. See `LICENSE`.

## Working on Parley

After cloning, wire the repository's hooks once: `npm run hooks` (it sets
`core.hooksPath` to `hooks` in this clone). It is a script of its own, never
run by an install: installing the package changes no git configuration.
`npm run check` fails while the hooks are not wired.
