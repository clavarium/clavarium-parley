# The protocol

Parley is three small things that agree on one folder.

## The folder

| File | Written by | What it holds |
|---|---|---|
| `from-agent.jsonl` | the agent's side | what the agent posted, one JSON object per line |
| `to-agent.jsonl` | the application's side | what was written to the agent, one JSON object per line |
| `read.json` | the agent's side | how many lines of `to-agent.jsonl` the agent has read |
| `server.mjs` | the application, once | the agent's side itself, put there by `install()` |

Both files only grow. Nothing is edited, nothing is deleted. There is no
address, no port and no key: whoever can read and write the folder is a side.

## What an agent can do: five verbs

| Tool | Arguments | It posts | It returns |
|---|---|---|---|
| `tell` | `text` | `{kind:"say", text}` | at once |
| `ask` | `question`, `choices?` | `{kind:"ask", text, choices}` | at once: it never waits for the answer |
| `show` | `path`, `note?` | `{kind:"show", path, text}` | at once |
| `status` | `state` (`working`, `waiting`, `done`), `note?` | `{kind:"status", state, text}` | at once |
| `read` | none | nothing | what was written since the last `read`, answers included |

Every line posted also carries `id` (unique) and `at` (the time, ISO 8601).

## What is written to an agent

`{id, at, text}`, and when it answers a question: `answers` (the id of that
question) and `question` (its words, so that the agent is reminded of them).

## Nothing waits

A tool never blocks until a person answers. The agent posts and goes on, or
stops. When something was written to it, the application gets ONE LINE to the
agent, by a way of its own (typed in its terminal, most of the time):

    A message arrived for you: call the read tool of the "parley" server and act on it.

What was written is never on that line. The agent calls `read` and finds it.
An answer may therefore come two minutes or two days later.

## The two hooks of an application

| Hook | Called | To |
|---|---|---|
| `toAgent(line)` | when something was written to the agent | get that one line to it |
| `toPerson(message)` | for each thing the agent posts | alert a person, or not |

They are plain functions. Parley knows neither how an agent is reached nor
how a person is alerted.

## What each side must not trust

- What the agent posts is text chosen by a program. The application's side
  bounds it and removes what a screen obeys rather than shows; the library
  puts it on the page as text, never as markup.
- The agent can write in its own folder: it can forge a message to itself.
  That harms nobody but itself. Nothing here gives it a right it had not.
- It all depends on the agent's good will: it uses these tools because it was
  asked to. What it asks in its terminal is not seen here.

## A mirror

The other side need not be a person. Two folders, each one's `from-agent`
copied into the other's `to-agent`, and two agents talk, whatever each one
is. Not built yet.
