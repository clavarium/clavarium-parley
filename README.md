# Clavarium Parley

A bridge between a command-line agent and a screen of its own.

A command-line agent lives in a terminal. Whoever does not read a terminal
cannot talk with it. Parley gives the agent five verbs, as a command and as
an MCP server, and gives an application a small library that shows the
exchange as a conversation, on any screen.

It is part of the Clavarium family and needs nothing of Clavarium: any
application, any agent that can run a command.

## The five verbs

| The agent runs | To |
|---|---|
| `parley tell "text"` | say where it is, what it did |
| `parley ask "question" [choice ...]` | ask, with or without choices; it does not wait |
| `parley show path ["note"]` | point to a file it made |
| `parley read` | read what was written to it, answers included |
| `parley status working\|waiting\|done ["note"]` | say where it is |

`parley --help` says all of it to the agent. The same five verbs are an MCP
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

| Action | Does |
|---|---|
| `say(text, answers)` | writes what the person said (`answers`: the question it answers) |
| `read()` | the exchange: messages, open questions, status, steps, files, unread |
| `invite(lang, { install, shared })` | the text that asks an agent to use Parley, in English, saying the person's language |

Parley types nothing anywhere. `WAKE` (`You have a new message: run
\`parley read\`.`) and the invitation are texts an application uses as they
are, changes, or does not use.

## The pieces

| Piece | File | What it is |
|---|---|---|
| The agent's side | `server/parley-mcp.mjs`, `bin/parley.mjs` | the five verbs, as an MCP server and as a command; no dependency |
| The application's side | `host/parley-host.mjs` | reads and writes the files, cleans what the agent wrote, announces events |
| The screen | `ui/parley-ui.js`, `ui/parley-ui.css` | the exchange in two views, simple and detailed; no framework |
| The words | `ui/texts/en.json`, `ui/texts/fr.json` | one dictionary per language |

## Use it

    import { install, Parley, WAKE, texts } from 'clavarium-parley/host';

    install('/path/to/work/.parley');      // the folder, once
    const parley = new Parley('/path/to/work/.parley', {
        on: (event) => { /* person-wrote: get WAKE to the agent, your way; agent-asked: alert, or not */ },
        reach: (path) => (path.startsWith('/work/') ? path : null),   // what the person can open
    });
    parley.listen();
    typeInTheAgentsTerminal(parley.invite('fr', { install: 'npm install -g /path/to/clavarium-parley-0.2.0.tgz', shared: '/work' }));

and in a page:

    import { mount } from 'clavarium-parley/ui';
    mount(element, { load, send, words: texts('fr', operatorsOwn), open, terminal, view: 'simple' });

The agent installs the command itself, from the archive `npm pack` makes:
`npm install -g clavarium-parley-0.2.0.tgz`, then `parley --help`. It finds
its folder as git finds a repository: the nearest `.parley` from where it
stands, or `--dir`, or `$PARLEY_DIR`.

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

Not tried yet with a real agent: the `parley` command installed from its
archive (version 0.2, tested here against a real `npm install -g`); any
agent but OpenCode; `show` and `status` (it did not use them unasked); an
answer coming hours later; the two views in a real page with a real agent; a
mirror between two agents.

## Licence

MIT. See `LICENSE`.
