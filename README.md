# keepawake

[![npm](https://img.shields.io/npm/v/keepawake)](https://www.npmjs.com/package/keepawake)
[![CI](https://github.com/BeamNawapat/keepawake/actions/workflows/ci.yml/badge.svg)](https://github.com/BeamNawapat/keepawake/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Keeps your computer awake while an AI coding agent is running. When the agent exits, the lock is released and the machine can sleep again.

Works on macOS and Windows. Linux is best effort.

## Why

A long Claude Code or Codex session often runs after you walk away. The laptop goes idle, sleeps, and the agent dies mid-task. `keepawake` polls the process list every 15 seconds. If it sees a known agent, it holds a sleep lock. If none are left, it lets go.

It grew out of `keepawake-claude`, a 729-line bash script for macOS. This is a rewrite in TypeScript with no runtime dependencies.

## Install

```sh
npm i -g keepawake
# or run once without installing
npx keepawake start
```

Needs Node 18.17 or newer. Both `keepawake` and `keepawake-claude` are installed as commands.

## Usage

Start in the foreground. Ctrl+C stops it and releases everything:

```sh
keepawake start
```

Run in the background, stay awake no matter what, stop after two hours:

```sh
keepawake start --always --for 2h -d
keepawake status
keepawake stop
```

Keep the machine running with the lid closed, and reconnect to a phone hotspot if the network drops:

```sh
keepawake start --lid --hotspot "My Phone" -d
```

Full command list:

<!-- help -->
```
keepawake start [flags]      foreground (or -d)
keepawake stop               kill daemon, restore everything, clear state
keepawake restart [flags]    stop + start (no flags = reuse flags from state.json)
keepawake status [--json]    daemon / mode / lid / hotspot / holder / agents / internet / system sleep
keepawake check [--json]     detect once; exit 0 if an agent is found, 1 if not
keepawake log                tail the log (pure Node, works on Windows)
keepawake doctor [--fix]     find stale pid, orphan holder, stuck lid setting, broken autostart; --fix repairs
keepawake setup-auto [flags] start on login (LaunchAgent / HKCU Run key / systemd --user); rejects --lid
keepawake remove-auto
keepawake uninstall          stop + remove-auto + delete ~/.keepawake + print `npm rm -g <name>`
keepawake help|-h  version|-v

flags (start/restart/setup-auto):
  -a, --always        stay awake all the time, skip detection
  --for <duration>    with --always: stop by itself after 2h / 90m / 45s
  --lid               keep running with the lid closed
  --display           also keep the screen on
  --hotspot <ssid>    if the network drops while awake, reconnect to this saved Wi-Fi profile
  --interval <sec>    poll interval, default 15 (env KEEPAWAKE_INTERVAL)
  --no-apps           do not count GUI apps (Claude Desktop, Cursor, Kiro) as "working"
  -d, --daemon, --background

env: KEEPAWAKE_HOME, KEEPAWAKE_INTERVAL, KEEPAWAKE_IGNORE=<id,id>, NO_COLOR
```
<!-- /help -->

## Options

| Flag | What it does |
|---|---|
| `-a`, `--always` | Hold the lock without looking for agents. `check` and `status` still report what they see. |
| `--for <duration>` | Only with `--always`. Release and exit after `2h`, `90m` or `45s`. Use it so a laptop does not run all night in a bag. |
| `--lid` | Closing the lid does not sleep the machine. macOS runs `sudo pmset`, Windows asks for UAC and edits the power plan, Linux uses `systemd-inhibit`. |
| `--display` | Also block display sleep. |
| `--hotspot <ssid>` | When the internet check fails while awake, join this saved Wi-Fi network. |
| `--interval <sec>` | Seconds between polls. Default 15. |
| `--no-apps` | Ignore desktop apps. Only CLI agents count. |
| `-d`, `--daemon`, `--background` | Detach and run in the background. |

`KEEPAWAKE_IGNORE=cursor,aider` skips those agent ids during detection.

State lives in `~/.keepawake/` (or `$KEEPAWAKE_HOME`): `daemon.pid`, `state.json`, `keepawake.log`.

## Supported agents

"Verified" means the process name was checked on a real machine. "Inferred" means it comes from the agent's docs or package name, and nobody has confirmed it yet. If one is wrong on your system, open a bug report with the output of `ps -axo pid=,comm=,args=`.

| Agent | id | Type | Status |
|---|---|---|---|
| Claude Code | `claude-code` | CLI | verified |
| Claude Desktop | `claude-desktop` | app | verified |
| OpenCode | `opencode` | CLI | verified |
| Cursor (app) | `cursor` | app | verified |
| Codex CLI | `codex` | CLI | inferred |
| Gemini CLI | `gemini` | CLI | inferred |
| cursor-agent | `cursor-agent` | CLI | inferred |
| Aider | `aider` | CLI | inferred |
| Copilot CLI | `copilot` | CLI | inferred |
| Kiro | `kiro` | app | inferred |
| kiro-cli | `kiro-cli` | CLI | inferred |
| Amp | `amp` | CLI | inferred |

Generic names like `node`, `python` and `bun` never match on their own. They only count when the command line also names the agent's package.

## Platforms

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Stay awake | `caffeinate -i -m -s` | `SetThreadExecutionState` via a hidden PowerShell | `systemd-inhibit` |
| `--lid` | `sudo pmset -a disablesleep 1` | `powercfg` lid action, UAC prompt | `systemd-inhibit handle-lid-switch` |
| `--hotspot` | `networksetup` | `netsh wlan connect` | `nmcli` |
| Auto-start | LaunchAgent | HKCU Run key | systemd user unit |
| Status | tested by the author | CI only, not on real hardware | CI only (`--always`) |

Windows lid handling and Modern Standby are not tested on a physical laptop. If you can test them, please say so in an issue.

## How it works

A small state machine decides what to do on each poll: acquire the lock, release it, try the hotspot, or expire. Platform code does the actual work and every OS call goes through one `Exec` interface, so tests run against fakes.

- **macOS:** `caffeinate -w <daemon pid>` means the lock disappears if the daemon is killed. There is no `pkill` sweep, so it cannot hit someone else's `caffeinate`.
- **Windows:** the holder is a hidden PowerShell that blocks reading stdin. When the daemon dies the pipe closes and PowerShell exits.
- **`--lid`:** the previous setting is saved to `state.json` before any change and restored on `stop`. If the daemon crashes, `keepawake doctor --fix` restores it.
- **Internet check:** a TCP connect to 1.1.1.1:443, then 8.8.8.8:53, with a 2 second timeout. No `ping`.
- The log records agent labels only, never full command lines.

## Troubleshooting

- **Antivirus flags PowerShell on Windows.** The holder runs `powershell -EncodedCommand`. Some AV and EDR products flag that pattern. Allow-list `powershell.exe` when it is launched by `node.exe`.
- **"Constrained Language Mode" error.** Group policy blocks `Add-Type`, which the Windows holder needs. Stay-awake will not work on that machine.
- **`--lid` on Windows shows UAC twice.** Once on `start` and once on `stop`. Windows has no sudo-style ticket cache.
- **macOS shows no SSID.** macOS 15 and later hide the Wi-Fi name from command-line tools. `--hotspot` confirms the connection with an internet check instead of comparing names.
- **Windows 11 24H2 and `--hotspot`.** `netsh wlan` may need Location services turned on, and the profile must already be saved.
- **Laptop still sleeps on Windows.** Modern Standby can drop power regardless of the lid action. Check `powercfg /requests`.
- **Auto-start stopped working after switching Node.** The startup entry stores the path to `node`. After changing nvm, Volta or fnm versions, run `keepawake setup-auto` again.
- **Linux: `Failed to inhibit: Access denied`.** polkit refused the `sleep` inhibitor for your session. This happens on headless or CI machines and with some polkit policies. Check `systemd-inhibit --what=idle:sleep --who=test --why=test true`.
- **Something looks stuck.** Run `keepawake doctor`. Add `--fix` to clean up.

## Migration from keepawake-claude

1. Stop the old daemon: `keepawake-claude stop`. Check with `pmset -g | grep SleepDisabled`; it should print `0`.
2. If you installed the old LaunchAgent, unload it: `launchctl unload ~/Library/LaunchAgents/com.local.keepawake-claude.plist`.
3. Remove the old script: `sudo rm /usr/local/bin/keepawake-claude`.
4. Install the new one: `npm i -g keepawake`. The `keepawake-claude` command still exists and points to the new CLI.

Differences from v2.1:

- `install` is gone. npm installs it.
- State moved from `/tmp` to `~/.keepawake/`.
- The old `status` read `disablesleep` from `pmset -g`, but macOS prints `SleepDisabled`, so it always reported the wrong lid state. Fixed.
- The old hotspot check compared SSIDs, which macOS 15+ no longer exposes. The new one checks internet access.
- `--lid` asks for sudo once at start, not on every poll.

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). Adding an agent is one registry entry, one fixture and one test.

## License

MIT. See [LICENSE](LICENSE).
