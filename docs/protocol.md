# The protocol

Parley is three small things that agree on one folder.

## The folder

| File | Written by | What it holds |
|---|---|---|
| `from-agent.jsonl` | the agent's side | what the agent posted, one JSON object per line |
| `to-agent.jsonl` | the application's side | what was written to the agent, one JSON object per line |
| `read.json` | the agent's side | how many lines of `to-agent.jsonl` the agent has read (`lines`), and when it read (`reads`: `[{lines, at}]`, the last 200) |
| `server.mjs` | the application, once | the MCP server, for an agent given it that way (`install()`) |

Both files only grow. Nothing is edited, nothing is deleted. There is no
address, no port and no key: whoever can read and write the folder is a side.

The command finds the folder as git finds a repository: `--dir`, else
`$PARLEY_DIR`, else the nearest `.parley` from where the agent stands.

## What an agent can do: seven verbs

| Command | MCP tool | It posts | It returns |
|---|---|---|---|
| `parley tell [--short TITLE] TEXT` | `tell(text, short?)` | `{kind:"say", text, short?}` | at once |
| `parley ask [--short TITLE] QUESTION [CHOICE ...]` | `ask(question, choices?, short?)` | `{kind:"ask", text, choices, short?}` | at once: it never waits for the answer |
| `parley close ID ANSWER` | `close(id, answer)` | `{kind:"close", answers, text}` | at once; ID is the question's, or its first 8 characters or more |
| `parley show PATH [NOTE]` | `show(path, note?)` | `{kind:"show", path, text}`, the path made whole | at once; refused if there is no such file |
| `parley show A="title" B="title" [NOTE]` | `show({files: [{path, title}], note?})` (or `paths`) | `{kind:"show", path, text, files: [{path, title?}]}`, twelve at most, `path` the first | at once: one gallery, each with its title |
| `parley status STATE [NOTE]` | `status(state, note?)` | `{kind:"status", state, text}` | at once |
| `parley doing TEXT` | `doing(text)` | `{kind:"doing", text}`, one line of 200 characters at most | at once |
| `parley read` | `read()` | nothing | what was written since the last read, answers and attached files included, then the questions still open with their ids |
| `parley read --all` | `read({all: true})` | nothing | the whole exchange, both sides, oldest first (the newest 200 entries): to pick up the thread after a restart |

`TEXT` is Markdown, 16,000 characters at most; `short` is its short version, a title of one or two lines (200 characters), which a screen shows first: whatever asks the person for an action or a decision, or says the agent is blocked, belongs in it. A question is closed (`close`) when the person answered it another way (a message typed later): the screen says the answer the agent understood, and the person may still answer with the question's buttons. `STATE` is `working`, `waiting` or `done`. `doing` says what the agent is
doing now, at each new step; it means it works: a `doing` after `done` or
`waiting` makes its status `working` again. Every line posted also carries
`id` (unique) and `at` (the time, ISO 8601). A text may come from standard
input with `-`. Exit codes of the command: 0 done, 1 refused, 2 no folder,
64 not understood.

## What is written to an agent

`{id, at, text}`, and when it answers a question: `answers` (the id of that
question) and `question` (its words, so that the agent is reminded of them).
When it answers a question by text typed in reply, the same. When it replies
to another message of the agent: `re` (its id) and `quote` (its words). When
the person dictated part of it: `via: "voice"`, and `parley read` says it may
hold recognition mistakes.

A REACTION of the person to a message of the agent is a line of its own:
`{id, at, text: "", reaction, to, quote, toAt}` (`to`: the message, `quote`
and `toAt`: its words and its time, so that the agent knows which one;
`removed: true` when taken back). `parley read` gives its meaning: the
default set is `agree` (noted; it authorizes NOTHING), `go` (do what that
message proposes; several proposals: ask which), `disagree` (ask what is
wrong), `unclear` (explain more simply, without acting), `stop` (stop now,
do nothing more), `redo` (another way), `later` (nothing for now), `love`
(noted). An application may offer another set: an unknown one is given by
its name. When the person attached files: `files`, `[{path, name, size}]`, ten at most,
`path` as the agent sees it; the text may then be empty. Where the files are
put is the application's business: it puts them where the agent can open
them, and gives Parley their paths. `parley read` gives each path.

## Nothing waits

A verb never blocks until a person answers. The agent posts and goes on, or
stops. When something was written to it, the application is told
(`person-wrote`, with how many messages the agent has not read) and gets ONE
LINE to the agent, by a way of its own, when it judges right:

    You have a new message: run "parley read".

What was written is never on that line. After the agent lost its memory (its
machine restarted, a new session), the application may type, once:

    Your chat with the person is kept: run "parley read --all" before going on.
 The agent runs `parley read` and
finds it. An answer may therefore come two minutes or two days later.

## Parley announces, the application decides

| Event | When | Carries |
|---|---|---|
| `person-wrote` | `say()` wrote a message | `message`, `unread` |
| `agent-said` | the agent ran `tell` | `message` |
| `agent-asked` | the agent ran `ask` | `message` (with `choices`) |
| `agent-showed` | the agent ran `show` | `message` (with `path`, and `open`: the application's way to open it, or `null`) |
| `agent-status` | the agent ran `status` | `message` (with `state`) |
| `agent-doing` | the agent ran `doing` | `message` (its `text`: one line) |
| `agent-closed` | the agent ran `close` | `message` (`answers`: the question; `text`: the answer it understood) |
| `person-reacted` | `react()` wrote a reaction | `message` (the line), `reaction` (null: taken back), `wakes` (`false`, `true` or `'now'`: the set's hint), `unread` |

Events of the agent are announced by `listen()`, each line once, once it is
whole, from the moment it was started: what was posted before is in
`read()`.

| Action | Gives |
|---|---|
| `say(text, answers?, files?, {via?})` | what `read()` gives, after writing; `answers` may be any message of the agent (a question is answered, another replied to) |
| `react(to, reaction)` | a reaction of the set (`REACTIONS`) on a message of the agent, or `null` to take it back; what `read()` gives |
| `read()` | `messages` (each of the person's says `seen`, and `seenAt` when known, `via` when dictated; each of the agent's may carry `short`, `reaction` (`{id, at, seen}`, the one standing), `files` for a gallery (`[{path, title, open}]`), and `refs`: the paths it cites that `reach` opens; a question it closed, `closed: {text, at}`), `waiting` (questions neither answered nor closed), `status`, `steps` (every `status` and `doing`, in order: `{id, kind, state, note, at}`), `files` (every file shown, and every one cited that can be opened, `cited: true`), `unread` |
| `invite(lang, {install?, shared?})` | the invitation, a text |
| `unread()` | how many of the person's messages the agent has not read |

`reach(path)`, given by the application, says how the person opens a file
the agent showed, or one the person attached: a reference of its own, or
`null` when it is not in a folder the person can open. The screen then says
so.

## Lines of the application

What happens around the agent -- its machine short of memory, restarted --
belongs in the thread, where it happened. The application keeps such lines
itself (never in the folder: the agent writes there) and adds them to the
messages it gives the screen:

    {from: "system", id, at, text, level: "needs-you"|"news"|"trace", tone?: "warn"|"bad",
     topic?, brief?, actions: [{id, label}], links?: [{text, id}]}

The application gives each line a neutral level, and nothing else is decided
here: `needs-you` is shown in both views; `news` in both, as a compact line in
the simple one, where lines of one `topic` that follow each other are one line
(`{topic} ({count}): {briefs}`); `trace` in the detailed view only. (`warn` and
`bad` are read as needs-you, `info` as news.) The screen shows each as a grey
line across, with its time and its buttons (four at most); a button calls the
application's `act(id, line)`. `links` are words of its own text that are
buttons too (a commit it names): each, where it first stands in the text,
calls `act(id, line)`; the rest stays text. A line of
the application takes no step and does not hide that the person's last
message is not read yet.

## What the screen makes of the states

`waiting` and `done` are no steps. Each is said once, at the end of the
thread: waiting until the person writes; done ("Done: ..."), quietly, while it
is the last thing that happened -- a message of either side or a step after
it, and it is gone. The detailed view says the state at the top only when the
end does not.

## What the screen makes of the steps

The steps that came between two messages belong to the second one: folded
into it in the simple view, unfolded above it in the detailed one. Those
after the last message are the agent's turn: while the newest of them is a `doing`
(or a `working` status), it is shown as the one line of what it does now, and
it goes when the next message comes. Nothing came for 15 minutes: the line
stays, still, and says since when. The agent read the person's newest message and posted
nothing since, not even a step: the screen says "Received, thinking..." (at
once, or after a delay the application sets), and "No answer yet" after five
minutes. It says the message was received, never what the agent does; its
first status or message replaces it. See the table in the README for what each
view shows.

## The box

Under the exchange, the box the person writes in. The application may fill
four slots, and nothing of them is shown without it: `voice` (a dictation
of its own, its words go into the box), `replies` (ready answers above the
box), `enter` (what Enter does) and `attach` (files the person attaches: a
button beside the box picks them, they are shown above it, and on Send each
is given to `upload(file)`, which puts it where the agent can open it and
resolves with `{path, name, size}`; then the message goes, with them). The choices of the question the agent
asks now come first above the box when its message has scrolled away. The
page never puts the cursor in the box on a touch screen: only a finger does.
See the README for each slot.

## Words

| Read by | Language | Where |
|---|---|---|
| the agent: help, MCP descriptions, invitation, wake line | English only; the invitation names the person's language | `bin/`, `server/`, `host/` |
| the person: the screen, alerts | a dictionary per language, `en` when a word is missing; an application's own dictionary replaces any word | `ui/texts/<lang>.json`, `texts(lang, own)` |

## What the agent writes, on the screen

With `markdown: true`, the library reads the agent's Markdown into plain data
(headings, lists, tasks, emphasis, `==highlight==`, tables, quotes, the alerts
of GitHub `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`, badges `[ok] [todo]
[blocked] [warn]`, code blocks) and builds the page from that data element by
element. A link is followed only when it is http or https (a new tab,
`rel="noopener noreferrer"`), or when it is a path the application opens. A
picture is shown only from a path the application opens (`picture(file)`):
never from anywhere else. A ```mermaid block is drawn by the application's
`diagram(code)` and shown as a picture, never inserted as markup; a failure
shows its code. A code block is coloured from the token tree of the
application's `highlight(code, lang)`, spans made here. A long message is
folded in the simple view (after its short version, or after about twelve
lines), its `> [!IMPORTANT]` boxes kept in sight; a question never, nor
the newest message of the agent (nothing seems left below it). The text in
brackets of a picture is its title, under it. Files shown at once are one
gallery, each its title under it (no title: the name of the file without its
extension and dashes); the name of the file on hover and in the detailed view.

## Reactions, the media, the viewer

A message of the agent takes a reaction: a button on hover, a right click, or
a long press opens the set, each icon with its word under it and its meaning
on hover, and Reply. The icons are Lucide's (`ui/parley-icons.js`, copied with
its version and licence, nothing loaded). "Media and files", in the menu of
settings, shows every picture of the thread as a grid (the newest first) and
the other files as a list; a picture goes large among all of them; "See in
the thread" finds where it came. A picture large grows out of its thumbnail,
zooms up to eight times, goes to the previous or next (arrows, a swipe, a
strip of small pictures), and closes with a tap on it (not zoomed) or beside
it, a swipe down, or Escape. What arrives while the thread is open comes in
softly and is marked a moment; movement only for whoever did not ask for
less.

## What each side must not trust

- What the agent posts is text chosen by a program. The application's side
  bounds it and removes what a screen obeys rather than shows; the library
  puts it on the page as text, never as markup. The words of a dictionary,
  too: they are shown as text, whatever they say.
- The agent can write in its own folder: it can forge a message to itself.
  That harms nobody but itself. Nothing here gives it a right it had not.
- It all depends on the agent's good will: it uses these verbs because it
  was asked to. What it asks in its terminal is not seen here.

## A mirror

The other side need not be a person. Two folders, each one's `from-agent`
copied into the other's `to-agent`, and two agents talk, whatever each one
is. Not built yet.
