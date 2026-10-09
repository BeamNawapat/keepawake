# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-09

First release. Rewrite of `keepawake-claude` 2.1.0 (bash, macOS only).

### Added

- `--always` / `-a`: hold the lock without detecting agents.
- `--for <duration>`: stop an `--always` run after `2h`, `90m` or `45s`.
- `--display`: also block display sleep.
- `--no-apps`: do not count GUI apps as working.
- `doctor` and `doctor --fix` for stale pid files, orphan holders, stuck lid settings and broken autostart.
- `status --json` and `check --json`.
- Windows support: idle sleep, `--lid`, `--hotspot`, `-d`, `setup-auto`.
- Linux support (best effort): `systemd-inhibit`, `nmcli`, systemd user unit.
- Detection for 12 agents: Claude Code, Claude Desktop, Codex CLI, Gemini CLI, Cursor, cursor-agent, OpenCode, Aider, Copilot CLI, Kiro, kiro-cli, Amp.
- `uninstall`, `remove-auto`, `log` (works on Windows).

### Changed

- Renamed to `keepawake`. The `keepawake-claude` command remains as an alias.
- Written in TypeScript, no runtime dependencies, Node 18.17 or newer.
- `--lid` is applied once per session instead of on every poll.
- State moved from `/tmp` to `~/.keepawake/` so it survives a reboot.
- Hotspot reconnects are confirmed with an internet check, because macOS 15+ does not expose the SSID.
- The macOS holder uses `caffeinate -w <pid>` instead of a `pkill` sweep.

### Removed

- `install` command. npm handles installation.

### Fixed

- `status` read `disablesleep` from `pmset -g`, but macOS prints `SleepDisabled`, so the lid state was always wrong.
- The old internet check used `ping -W 2`, which is 2 milliseconds on macOS, and failed constantly.

[0.1.0]: https://github.com/BeamNawapat/keepawake/releases/tag/v0.1.0
