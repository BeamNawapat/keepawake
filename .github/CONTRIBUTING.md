# Contributing

Thanks for helping. This is a small project, so the process is short.

## Setup

You need [Bun](https://bun.sh) for development and Node 18.17 or newer to run the built CLI.

```sh
bun install
bun test
bun run typecheck
bun run build
node dist/cli.js --version
```

The published package has no runtime dependencies. Do not add one. Code in `src/` must only use Node 18.17 APIs, not Bun-only ones.

## Layout

- `src/core/`: pure logic (detector, monitor state machine, state file, logger).
- `src/ports/`: interfaces for everything that touches the OS.
- `src/platform/{darwin,win32,linux}/`: the real implementations.
- `test/`: tests and fixtures.

Every OS call goes through the `Exec` port. Tests pass in `fakeExec` from `test/fake-exec.ts`. Do not call `child_process` directly from anywhere else.

## Adding an agent

You need three things:

1. One entry in `src/core/agents.ts` with `id`, `label`, `kind` (`cli` or `app`) and at least one of `comm`, `argv`, `exePath`.
2. A fixture in `test/fixtures/` with real process lines from a machine where the agent is running. Mark guesses with a `// inferred` comment.
3. A case in `test/detector.test.ts`. A meta-test fails if an id has no fixture.

Rules for matching:

- Never match a bare `node`, `python`, `bun` or `sh`. Add an `argv` pattern that names the package.
- `comm` is compared by basename, case-insensitive on Windows, without `.exe`.
- Log agent labels only. Never log a full command line, since it can hold secrets.

To get a real fixture, run `ps -axo pid=,comm=,args=` on macOS or Linux, or `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json` on Windows. Remove tokens and personal paths first.

## Commits

Conventional commits, imperative, 72 characters or fewer on the first line:

```
feat(detector): add Amp agent
fix(darwin): parse SleepDisabled from pmset
```

Types: `feat fix refactor perf docs test build ci chore revert`. Explain why in the body, not what the diff shows.

## Pull request checklist

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun run build` passes and `dist/cli.js` starts with `#!/usr/bin/env node`
- [ ] New behavior has a test
- [ ] README or CHANGELOG updated if users will notice
- [ ] No new runtime dependency
- [ ] You say which OS you ran it on

## Testing by OS

CI runs on Ubuntu, macOS and Windows, but CI cannot close a lid or hit Modern Standby. If your change touches `--lid`, `--hotspot` or autostart, run it by hand on a real machine and say what you did in the PR. Windows lid behavior currently has no hardware tester, so reports there are very welcome.

## Conduct and security

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
