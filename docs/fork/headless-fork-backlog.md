# Headless fork backlog

What the fork doesn't do yet. What it does is in [headless-fork-spec.md](headless-fork-spec.md).

## Harnesses

- **OpenCode 2.** Run OpenCode 2 in place of OpenCode 1: the effort in the model reference, the TUI in
  place of `run --interactive`, a private server for per-run config, the database where 2.x keeps it.
  The plan is in [opencode-2-spec.md](opencode-2-spec.md).

## Tests

- **Re-enable the PO-requested test skips.** Fourteen existing tests are disabled
  with individual reasons after failures in the local full suite: six native
  OAuth/keyring/config probes in `tests/billing.test.ts`; four auth, raw-stream
  and tmux fixtures in `tests/headless.test.ts`; the non-git workdir fixture in
  `tests/modal.test.ts`; stale process-group lock takeover in
  `tests/run-storage.test.ts`; and async agent startup in
  `tests/async-run-message.test.ts`; and timeout termination under backpressure
  in `tests/sdk-format.test.ts`. These skips suppress known failing checks,
  not resolved defects. Repair the fixtures or behavior and restore each check.
  The fork session-cleanup and checkpoint tests remain enabled.
