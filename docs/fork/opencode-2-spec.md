# OpenCode 2

Plan for running OpenCode 2 in place of OpenCode 1.
Nothing here is built yet. What the fork does today is in [headless-fork-spec.md](headless-fork-spec.md).

## Why

- **OpenCode 1 is in maintenance.** The 1.x line still gets fixes, but Homebrew Core now ships 2.x,
  and new work (multiple logins, the shared service) is 2.x only.
- **More than one login per provider.** OpenCode 2 stores several credentials for one integration.

Checked against OpenCode 2.0.30 (`packages/cli/src/commands/commands.ts`,
`packages/core/src/credential.ts`, `packages/core/src/config.ts`) and its
[migration guide](https://opencode.ai/v2/docs/migrate-v1/).

## What changes in OpenCode 2

| Area | 1.x, as headless uses it | 2.x |
| --- | --- | --- |
| One-shot run | `run --format json --thinking --model M --variant V --session ID --title T --dangerously-skip-permissions` | the same flags, except `--variant`: the variant joins the model, `--model M#V`. `--dangerously-skip-permissions` is hidden; `--auto` is its documented form. `--session ID` also creates the session when it does not exist |
| Interactive run (`--tmux --wait`) | `run --interactive …` | gone. The TUI is `opencode [--session ID] [--prompt P]`, without `--model` or `--title`; `opencode mini` takes `--model` (no `#variant`) and no permission flags |
| Server | one per process | one shared background service per user, which owns sessions, configuration, credentials and permissions. `--standalone` runs a private one; `--server URL` connects to a given one |
| Per-run config | `OPENCODE_CONFIG_CONTENT`, read by the process | still read, but by the server: a client's environment reaches a running shared service no more |
| Config shape | `agent`, `permission`, `variants` object | 1.x fields are read and normalized; native 2.x shapes (`agents`, `permissions` list, `provider/model#variant`) are optional. One nested entry (an agent, a provider, a model) must be entirely one shape |
| Permissions | asks before paths outside the project | `external_directory` is allowed unless a rule says otherwise |
| Database | `~/.local/share/opencode/opencode.db` | named by the release channel; `opencode debug paths db` prints it, `OPENCODE_DB` overrides it |
| Credentials | one per provider in `auth.json` | several per integration in the database, one active per integration, for every session at once |
| LSP | runs language servers | does not |

## The port

- **One-shot runs.** `buildOpencode` drops `--variant` and passes `--model MODEL#EFFORT` when an
  effort is set. Permission flags unchanged.
- **Interactive runs.** `buildInteractiveOpencodeRun` (`--tmux --wait`) and `buildInteractiveOpencode`
  start the TUI, `opencode --session ID --prompt PROMPT`. The model and the effort reach it as config,
  the agent's `model: "MODEL#EFFORT"` for `build` and `plan`, which replaces the 1.x work-around of
  disabling every other variant (`opencodeInteractiveConfig`). A new conversation has no `--title`: its
  session id is made by headless and passed as `--session`, which creates it, so the `tag` wait tier
  becomes `id` for opencode and the lookup by title goes.
- **Per-run config goes with a private server.** Every opencode command headless builds with config of
  its own (an effort, `read-only`) passes `--standalone`, so the server that reads
  `OPENCODE_CONFIG_CONTENT` is the run's own. Commands without config may use the shared service.
- **Read-only** is written in the 2.x shape, a `permissions` list: `read`, `webfetch`, `websearch`,
  `codesearch` allowed; `edit`, `shell`, `subagent` denied; `external_directory` denied.
- **Project permissions keep asking outside the project.** Under `--allow project`, `ask` and `auto`
  the agent's own config decides, as before; the fork documents that 2.x allows
  `external_directory` by default, for the agent's config to deny or ask.
- **The database** is found as `opencode debug paths db` prints it, once per process, and
  `OPENCODE_DATA_HOME` keeps overriding it for Docker. Session queries are checked against the 2.x
  schema (`session`, `directory`, `time_updated`).
- **Session listing** (`session list --format json --max-count 20`) is unchanged in 2.x.
- **Trace events and usage.** `opencode run --format json` records are checked against 2.x
  (`trace-events.ts`, `opencode-usage.ts`, `relevant-trace.ts`) and adapted where their shape changed.
- **One version at a time.** 1.x and 2.x both install as `opencode` and are not installed side by
  side, so the port drops 1.x support rather than detecting the version.

## Tests

- **Command building**: `--model M#V` for one-shot runs, the TUI command with `--session`/`--prompt`
  and `--standalone` with config, the read-only `permissions` list.
- **A real run**, by hand, against 2.x: a one-shot run with an effort, an interactive `--tmux --wait`
  run, a resumed session, and the transcript found afterwards.

## Order

The port is released on its own and checked by a real run before anything builds on it.
