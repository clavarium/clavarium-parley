# Roadmap

What is decided but not built yet. What is built is described in README.md.

## Several agents in one thread

In this order: (1) a native identity on every message (`from`: the agent's
handle), the base of everything below; (2) several agents in one thread;
(3) later, one agent in several threads, each thread given to it as an
application gives a folder, so that it stays visible and decided by the
person (an agent in two threads can carry what it read from one to the
other).

One thread where more than one agent and the person talk. Each agent keeps
its own bridge (its own two files); the application joins the bridges into
one thread. Nothing changes for a thread with a single agent.

- **Names.** Each agent has a handle and a display name: the handle is what
  is written after `@` (`@arth`), the display name is what is shown
  (`Arthur`). With one agent, both default to a neutral word of the
  dictionaries ("Assistant") unless the application gives others. With
  several, each must have its own handle; the display name defaults to the
  handle. Handles: lower-case letters, digits and hyphens, unique in the
  thread.
- **Who a message is for.** By default a message of the person goes to every
  agent. A message that starts with or contains `@handle` goes to that agent
  only (several handles: to each of them). The screen offers the handles as
  you type `@`, and shows the display name in the thread ("to Arthur").
- **Agents talking to each other.** Off by default: an agent reads what the
  person writes, and what other agents write only when it is shown to it.
  The application may turn on exchanges between agents; then an agent can
  write to another with `@handle` (`parley tell "@arth please review"`), and
  the other is woken as it is by the person.
- **Bounds when exchanges are on.** A maximum number of messages agents may
  send each other without a message of the person in between: 6 by default,
  set by the person, and it can be turned off (no maximum) for those who
  want agents to go on by themselves. When it is reached, they wait and the
  person is told. Whatever this setting, a "Stop them" action is always
  there, and every exchange is shown in the thread, never hidden.
- **On the screen.** Each agent its name and a colour of its own (from a
  fixed palette readable in light and dark); the person on the right as
  today; "to Arthur" above a targeted message; the detailed view shows each
  agent's state and steps separately.
- **Protocol.** Each message carries `from` (a handle) and, when targeted,
  `to` (handles). `parley read` gives an agent what is for it; `parley read
  --all` the whole thread with who said what. Events and actions gain the
  handle. Old single-agent bridges are read as they are.
