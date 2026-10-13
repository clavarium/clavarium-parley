# Clavarium Parley

A bridge between a command-line agent and a screen of its own.

A command-line agent lives in a terminal. Whoever does not read a terminal
cannot talk with it. Parley gives the agent five verbs, through MCP, and
gives an application a small library that shows the exchange as a
conversation, on any screen.

It is part of the Clavarium family and needs nothing of Clavarium: any
application, any agent that accepts MCP servers.

## The five verbs

| The agent calls | To |
|---|---|
| `tell` | say where it is, what it did |
| `ask` | ask a question, with or without choices; it does not wait |
| `show` | point to a file it made |
| `read` | read what was written to it, answers included |
| `status` | say `working`, `waiting` or `done` |

Nothing waits: the agent posts, and is told in one line when a message
arrived. See [docs/protocol.md](docs/protocol.md).

## The three pieces

| Piece | File | What it is |
|---|---|---|
| The agent's side | `server/parley-mcp.mjs` | an MCP server over standard input and output; one file, no dependency |
| The application's side | `host/parley-host.mjs` | reads and writes the two files, cleans what the agent wrote, and has two hooks |
| The screen | `ui/parley-ui.js`, `ui/parley-ui.css` | shows the exchange; no framework; profiles for different people |

## Use it

    import { install, Parley, byTmux, watch } from 'clavarium-parley/host';

    // once: put the bridge in a folder the agent can reach
    const declared = install('/path/to/folder');   // { name: 'parley', command: ['node', '.../server.mjs'] }
    // declare that to the agent as an MCP server, the way that agent wants it

    // towards the agent: one function that gets a line to it
    const parley = new Parley('/path/to/folder', { nudge: byTmux({ target: 'main' }) });
    await parley.invite();                 // asks the agent to use the five verbs
    await parley.say('Blue, please.', questionId);

    // from the agent: called for each thing it posts
    const stop = watch('/path/to/folder', (message) => { /* ring a phone, light a lamp */ });

and in a page:

    import { mount, PROFILES } from 'clavarium-parley/ui';
    mount(element, { load: () => fetch('/talk').then((r) => r.json()), send: (text, answers) => post('/talk', { text, answers }), profile: PROFILES.simple });

A profile is the same screen for different people: `simple` (a box and an
answer), `everyday`, `coding`. It is a plain object; write your own.

## What was tried, and what was not

Tested as far as tests go: the five verbs, the two files, the cleaning, the
hooks, what the library decides to show. Not yet tried against a real agent,
nor in a real page of this repository: see CONVENTIONS.md, section 7.

## Licence

MIT. See `LICENSE`.
