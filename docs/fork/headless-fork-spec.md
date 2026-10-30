# The Headless fork

Fork of [RobertTLange/headless-cli](https://github.com/RobertTLange/headless-cli), worked on in the
`max` branch.

## What is in it

| Area | Contents |
| --- | --- |
| [Permission modes](#permission-modes) | `--allow project`, `ask` and `auto`, which keep the agent's own permission config, and a `[general] allow` config default |
| [Attach](#attach) | `--attach`, which launches a tmux session (or reuses a live one) and attaches the terminal to it |
| [Sessions](#sessions) | `--tmux --session <name>` resumes the agent's conversation when the tmux session is gone |
| [Clean sessions](#clean-sessions) | `--clean-before` and `--clean-after`, which let one session name start a new conversation |
| [Structured output](#structured-output) | `--json-schema`, which holds the agent's reply to a JSON Schema |
| [Visible thinking](#visible-thinking) | `--progress` shows the agent's thinking with 💭 and its reply with 💬, and asks Codex for its thinking |
| [Progress file](#progress-file) | `--progress-file <path>` appends the run's events, timed and uncut, as JSON lines, and edit events list their `paths` |

What it doesn't do yet is in [headless-fork-backlog.md](headless-fork-backlog.md).

## Where fork code goes

To keep rebases onto upstream cheap, new fork code lives in files upstream does not have:

- Feature code in `src/fork/`.
- Tests in `tests/fork-*.test.ts`.
- Documentation in `docs/fork/`.

An upstream file is edited only for a one-line hook, a small option it cannot do without, or an
entry in a shared list. Each such edit is listed under its area below. Upstream logic a fork file
needs is wrapped or copied rather than refactored.

## Verifying a change

```bash
npm run build && HOME="$(mktemp -d)" npm test
```

Run the suite with an empty `HOME`. Many upstream tests read the real `~/.headless/config.toml`, and a
`[general] allow` default there makes about two dozen of them fail.

Seven upstream tests fail on this machine with or without the fork. They cover Claude credential
lookup, `--json` trace streaming and a process-group lock, and they depend on the local
environment. When the suite runs from inside the Unify checkout, a few more tests that depend on
timing (keychain/keyring probes, SDK backpressure, async run messages) fail at random. Compare
against a run of `git archive HEAD` copied to a temporary directory, not against zero.

## Permission modes

Upstream's `read-only` and `yolo` override the agent's permissions. The fork modes keep the agent's
project or user permission config (sandbox, writable and read-only paths, allow/ask/deny lists). They
differ only in who reviews a request to leave the sandbox:

| Mode | Reviewer | Claude | Codex | Gemini | Antigravity, Cursor, OpenCode |
| --- | --- | --- | --- | --- | --- |
| `project` | whatever the config says | no flags | no flags | no flags | no flags |
| `ask` | the user | `--permission-mode acceptEdits` | `-c approvals_reviewer="user"` | `--approval-mode auto_edit` | no flags |
| `auto` | the agent's AI reviewer | `--permission-mode auto` | `-c approvals_reviewer="auto_review"` | rejected | rejected |

Pi has no permission system, and the ACP client approves every request itself, so all three modes
are rejected for them.

In one-shot runs nobody can answer a prompt. Under `project` and `ask` a sandbox escape is denied,
while under `auto` the reviewer decides. `codex exec` does consult the reviewer. This was checked
against Codex 0.144.1 with a write outside the workspace: `project` denied it and `auto` approved it.

`buildWithForkAllow` in `src/fork/allow.ts` wraps an upstream command builder. For a fork mode it
lets the builder run with an allow value it does not recognize. Most builders then add no
permission flags. It strips the two bypass flags that some builders add anyway: Codex exec's
`--dangerously-bypass-approvals-and-sandbox` and Gemini's `--approval-mode yolo`. Then it puts the
fork's flags first, ahead of any subcommand or prompt.

`[general] allow` in `~/.headless/config.toml` sets the default mode. Precedence, from highest:
`--allow`, `[roles.<role>] allow`, the built-in role default (`read-only` for explorer and
reviewer), `[general] allow`, then upstream's `yolo`.

Upstream edits:

- `src/types.ts`: `AllowMode` includes `ForkAllowMode`.
- `src/agents.ts`: `buildAgentCommand` and `buildInteractiveAgentCommand` call through `buildWithForkAllow`.
- `src/cli.ts`: `parseAllowMode` accepts fork modes; the `--allow` help line; the `opencode --tmux --wait`
  builder call goes through `buildWithForkAllow`.
- `src/config.ts`: `parseConfigAllow` accepts fork modes; `GeneralDefaults.allow` and its `allow` key in
  `parseGeneralConfigValue`; `resolveInvocationDefaults` applies the role default and then `general.allow`.

Test: `fork-allow`.

## Attach

`--attach` implies `--tmux`. The session is still created detached, and every post-launch step runs
first: prompt paste for OpenCode and Antigravity, session store, run registration. Only then does
`src/fork/attach.ts` attach the terminal. It runs `tmux attach-session`, or `tmux switch-client`
when `$TMUX` is set, so the terminal is not nested inside a second tmux client. `--print-command`
prints the attach command after the launch commands.

It is rejected with `--wait`, which would also take over the terminal, and when stdin is not a
terminal.

Upstream edits, all in `src/cli.ts`:

- `ParsedArgs.forkAttach`, and the `--attach` case in `parseArgs`.
- The `--attach` help line.
- A `validateForkAttach` call after the tmux flag checks.
- One line in the tmux `--print-command` output.
- One line before the tmux success output, which attaches instead of printing the session name.
  It is there for both a new tmux session and a live one that the prompt is sent to.

Test: `fork-attach`.

## Sessions

Upstream's `--tmux --session <name>` only names the tmux session. A live session gets the prompt typed
into it. A dead one starts a new conversation, and upstream records its id only under `--wait`. The
fork records the native conversation id of every tmux launch with `--session` in
`~/.headless/sessions.json`, the store that one-shot `--session` uses. When the tmux session is gone,
the next launch with that name resumes the conversation:

| Agent | New launch | Resume |
| --- | --- | --- |
| Claude | `--session-id <uuid>`, generated up front | `claude --resume <id>` |
| Codex | id claimed from the rollout that appears after launch | `codex resume <id>` |
| Antigravity | id claimed from the `brain/<id>` folder that appears after launch | `agy --conversation <id>` |
| OpenCode | id claimed from the session row that appears in `opencode.db` for the work dir | `opencode --session <id>` |

Codex, Antigravity and OpenCode cannot be given an id, so `src/fork/sessions.ts` claims it. It holds the
same launch lock upstream's `--wait` claim tier uses, snapshots the existing transcripts, launches, and
then polls for a new one until the tmux session exits or 30 seconds pass
(`HEADLESS_FORK_CLAIM_TIMEOUT_MS`). If none appears it warns, and the session will not be resumable.
OpenCode writes its session row only with the first message, so a session launched without a prompt is
claimed only if a message is sent within the timeout.

One-shot and tmux runs share the store, so a conversation started with `headless claude --session x`
can be continued with `headless claude --attach --session x`, and the other way round.

Under `--wait` the fork does not set an identity. Upstream's wait plan chooses it, so a new
conversation starts, and the fork records the id from upstream's wait strategy (`pin` or `claim`).
Other agents are unchanged.

Upstream edits:

- `src/agents.ts`: `buildInteractiveAgentCommand` goes through `withForkInteractiveResume`, because
  upstream's interactive Claude and OpenCode commands have no resume case.
- `src/cli.ts`, in the new tmux session path: `planForkTmuxSession` and its identity in the command
  options; `beginForkTmuxClaim` before the launch and `claimForkTmuxSession` after it; `release` in
  the `finally`; `recordForkTmuxSession` after a successful launch.

Test: `fork-sessions`.

## Clean sessions

A session name can be used forever and still start a new conversation when a task needs one.
Forgetting a session removes its conversation id and tmux wait strategy from `~/.headless/sessions.json`.
It keeps the rest of the entry (Codex profile, work dir), and the next launch under the name starts a new
conversation. The conversation itself is not deleted and can still be reached with the agent's own
resume picker.

An id is only ever forgotten while the name's tmux session (`headless-<agent>-<name>`) is not running;
`--clean-before` closes a running one first:

| Flag | Tmux session running | Tmux session stopped, or one-shot |
| --- | --- | --- |
| `--clean-before` | closes it, forgets the id, then launches a new conversation | forgets the id, then launches a new conversation |
| `--clean-after` | runs the task; the name stays marked | runs the task in the stored conversation; the name stays marked |
| none, name marked | runs the task in the live session | forgets the id and clears the mark, then launches a new conversation |

`--clean-after` does not watch the session. It records a mark in the fork's own
`~/.headless/fork-sessions.json`, and the first launch under that name to find the tmux session
stopped forgets the id. So every way a session ends counts: exiting the agent while attached,
detaching and exiting later, a crash, a reboot. A one-shot run has always ended by the next launch.

Both flags need `--session` and are rejected with `--docker`, whose session store lives inside the
container home. `--print-command` changes nothing, so it prints the command without the cleaning.

`src/fork/clean.ts` edits `sessions.json` directly instead of adding a writer to upstream's
`src/sessions.ts`, and writes it the same way (temporary file, then rename).

Upstream edits, all in `src/cli.ts`:

- `ParsedArgs.forkCleanBefore` and `forkCleanAfter`, and their cases in `parseArgs`.
- Two help lines.
- A `validateForkClean` call after `validateSessionAlias`.
- An `applyForkClean` call before the tmux session check, so the store is cleaned before anything reads it.

Test: `fork-clean`.

## Structured output

`--json-schema <schema>` says what the agent's final reply must look like. The schema is JSON as
written on the command line, or a path to a file holding it; either way it is parsed before an agent
is launched, so a schema that is not one is a refusal rather than an error halfway through a run.

Three harnesses can enforce a schema themselves, each spelling it differently, and the rest cannot
enforce anything at all. Both routes are taken silently by nobody: a run says on stderr which one it
took.

| Agent | Route |
| --- | --- |
| Claude, Antigravity | `--json-schema <text>` |
| Codex | `--output-schema <file>`, written under the system temporary directory |
| Cursor, Gemini, OpenCode, Pi | appended to the prompt: "End your reply with one JSON object..." |

Codex's flag goes before the trailing `-` that says the prompt comes on stdin, which is a positional
rather than a flag's value.

The caller is expected to check the reply as well. A prompted schema is a request rather than a
guarantee, and even an enforced one says nothing about whether the values make sense.

`--json-schema` is rejected with `--attach` and `--tmux`, which answer to a person rather than to a
caller reading a reply, and with `--docker` and `--modal`, which run the agent where this process's
files are not. With `--prompt-file` it is rejected only on the agents that have no flag, since there
the prompt is not this process's to rewrite.

Upstream edits, all in `src/cli.ts`:

- `ParsedArgs.forkJsonSchema` and its case in `parseArgs`.
- One help line.
- A `validateForkSchema` call after `validateForkClean`.
- In the one-shot path: `loadForkSchema` and the stderr note, `withForkSchemaPrompt` around the
  prompt in the native options, and `withForkSchemaArgs` around the built command.

Test: `fork-schema`.

## Visible thinking

`--progress` shows the agent's thinking where upstream drops it, as a block of its own with a blank line
before and after and `💭` in front, its later lines indented under the first:

```
🔧 Bash(git diff --cached --stat)

💭 Confirming the change is in shared code

💭 The change is in commonMain; checking the platform modules next.

🔧 Bash(ls syncthing/app/frontend/form-factor)

💬 The change is in commonMain, so it affects every platform.

```

- **The reply** is set apart the same way, with `💬`. Only the last message is the reply: a message
  with more work after it is the agent saying what it is about to do, and is shown as a thought.
  Codex writes those as the same kind of item as its answer, with nothing to tell them apart, so each
  message is held until the next event, or the end of the run, says which it was.
- **Blank lines** are shared: two blocks in a row have one blank line between them, not two.
- **Codex's summaries** head each part of a thought in `**bold**`, which is shown without the
  asterisks, and repeat a part already sent, which is not shown again.

- **Hidden thinking.** OpenCode sends each block of thought even when its text is withheld, as an
  OpenAI model's encrypted reasoning is. Such a block is shown as one line, `💭 (thought for 22s)`,
  so that a long stretch without tool calls reads as thinking rather than a hang.

- **Working line.** On a terminal, the last line is `⏳ Working… 12s`, redrawn each second with the
  time since the last line progress wrote (`3m 05s` past a minute). It is cleared before each new
  line and drawn again under it, so it never stays in the output, and a silent agent is told from a
  hung one by whether its lines keep coming. Off a terminal it is not drawn.

- **A resumed Antigravity conversation.** Antigravity's progress comes from its transcript, which a
  run resuming a `--session` goes on writing rather than starting. That transcript is followed from
  its size at launch, so the run's own steps show and the conversation's history does not.

A harness shows only the thinking its event stream carries. Codex carries none unless asked, so with
`--progress` it is given `-c model_reasoning_summary="detailed"`, before the trailing `-`. A run
without `--progress` is not, since nobody reads the summaries and they are billed output.

Upstream edits:

- `src/trace-events.ts`: the `thinking` and `message` cases of `renderTraceEvent`, the first of
  which rendered nothing, and `ProgressRenderer`'s holding of messages, repeated parts and blank lines.
- `src/trace-events.ts`: the `hidden_thinking` event, from OpenCode's `reasoning` part without text.
- `src/cli.ts`: the import and `withForkProgressArgs` around the built command, beside
  `withForkSchemaArgs`; the `WorkingLine` (`src/fork/working.ts`) that progress and the agent's
  stderr write through, started and stopped beside the transcript follower.

Tests: `fork-progress`, `fork-working`, and the thinking cases in `trace-events`.

## Progress file

`--progress` writes for a person, on stderr: a tool call's subject cut to one line, nothing timed, and
gone once the terminal scrolls past it. What watches or audits a run from outside would otherwise
read each harness's own session store, one format per harness. `--progress-file <path>` appends the
events `traceEvents` yields to a file instead, for every harness `--progress` renders, with or
without `--progress`. The caller gives one file per run, so it knows the run from the file.

- **JSON Lines**, one event a line, each written whole with one append, so a reader following the
  file mid-run only ever sees whole lines.
- **Each line** is the event as `data.events` has it under `--sdk-format ndjson`, plus `time`, ISO
  8601 in UTC. Nothing is cut, and paths stay as the harness gave them, not made relative to the
  work directory. Messages are written as they come: the file does not hold one back to tell what
  the agent says on the way from its reply, as `--progress` does; the last message is the reply.
- **A first line** `{"kind":"start","agent","model","session","workDir"}`, `session` only with
  `--session`, and **a last line** `{"kind":"end","exitCode"}`, written once the harness has exited,
  so a reader knows which harness ran, and whether the run ended or died partway, without its caller.
- **Appended, never truncated.** A second run given the same path adds its own `start` line, so a
  caller running one step several times can keep them in one file.
- **`paths`** on a `tool` event that edits files lists them, since `summary` joins them with `, `,
  which a path holding a comma makes ambiguous. It is in `data.events` too, the one change outside
  the file, and `--progress` lists the files from it.
- **Codex's thinking** is asked for as with `--progress`.
- **Not with `--tmux` or `--attach`**, which capture no trace; with `--json`, `--debug` or
  `--sdk-format` it works as without them.

A file that cannot be written costs the file, never the run: the first failure is reported once on
stderr and the rest of the run writes nothing more to it.

Upstream edits:

- `src/cli.ts`: `ParsedArgs.progressFile`, its case in `parseArgs`, one help line, the `--tmux`
  refusal beside `--progress`'s; in the one-shot path, the `ProgressFile` (`src/fork/progress-file.ts`)
  started with the run, fed beside the renderer, and ended with the harness's exit code; the
  Antigravity transcript follower started for it as for `--progress`; and `withForkProgressArgs`
  given either flag.
- `src/trace-events.ts`: `paths` on the `tool` event and where each harness's edits set it; the
  renderer's edit case reading it; `TranscriptFollower` taking any `feed`/`flush` sink.

Tests: `fork-progress-file`, and the `paths` cases in `trace-events`.
