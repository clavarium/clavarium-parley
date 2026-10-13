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
| The application's side | `host/parley-host.mjs` | reads and writes the two files, cleans what the agent wrote, and takes two hooks: `toAgent`, `toPerson` |
| The screen | `ui/parley-ui.js`, `ui/parley-ui.css` | shows the exchange; no framework; profiles for different people |

## Use it

    import { install, Parley } from 'clavarium-parley/host';

    // once: put the bridge in a folder the agent can reach
    const declared = install('/path/to/folder');   // { name: 'parley', command: ['node', '.../server.mjs'] }
    // declare that to the agent as an MCP server, the way that agent wants it

    const parley = new Parley('/path/to/folder', {
        toAgent: (line) => { /* get this one line to your agent, your way */ },
        toPerson: (message) => { /* the agent posted something: alert, or not */ },
    });
    parley.listen();
    await parley.invite();                 // asks the agent to use the five verbs
    await parley.say('Blue, please.', questionId);

Two hooks, two plain functions, and nothing more specific than that: how a
line reaches your agent and how a person is alerted are yours to decide.

and in a page:

    import { mount, PROFILES } from 'clavarium-parley/ui';
    mount(element, { load: () => fetch('/talk').then((r) => r.json()), send: (text, answers) => post('/talk', { text, answers }), profile: PROFILES.simple });

A profile is the same screen for different people: `simple` (a box and an
answer), `everyday`, `coding`. It is a plain object; write your own.

## What was tried, and what was not

Tried for real, once: an agent (OpenCode, on hosted open models) in its own
machine, given the server; an application (Clavarium) showing the exchange.
Invited, the agent said it was ready through `tell` in 19 seconds; told a
message arrived, it read it, did the job, and asked a question with two
choices through `ask`; answered with one touch on the page, it read the
answer and went on. Nothing of that exchange was typed in its terminal but
the one line "a message arrived".

Not tried: any other agent; `show` and `status` with a real agent (it did
not use them unasked); an answer coming hours later; a mirror between two
agents; the profiles in a real page.

## Licence

MIT. See `LICENSE`.
