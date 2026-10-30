# Headless fork backlog

What the fork doesn't do yet. What it does is in [headless-fork-spec.md](headless-fork-spec.md).

## Harnesses

- **OpenCode 2.** Run OpenCode 2 in place of OpenCode 1: the effort in the model reference, the TUI in
  place of `run --interactive`, a private server for per-run config, the database where 2.x keeps it.
  The plan is in [opencode-2-spec.md](opencode-2-spec.md).

## Sessions

- **Forked conversations.** `--fork-from <name>` resumes the conversation stored under `name` as a
  new one, leaving the original as it was, and stores the copy under `--session` if given, under no
  name otherwise. A caller can then build one base conversation, its setup read once, and start any
  number of runs from it, one after another or at once, each from the same point. Every harness
  forks natively: `opencode run --session <id> --fork`, `claude --resume <id> --fork-session`,
  `codex exec fork <id>`; Antigravity would need checking. Forking a name with no conversation
  fails, rather than starting a new one.
