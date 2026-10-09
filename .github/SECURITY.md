# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not file a public issue for a security problem.

You should get a reply within a week. Fixes go out as a patch release with a note in the changelog.

## Supported versions

Only the latest release gets fixes.

## Where this tool runs privileged commands

`keepawake` never asks for elevated rights unless you pass `--lid`.

- **macOS, `--lid`:** runs `sudo -v` once, then `sudo pmset -a disablesleep 1` at start. On `stop` it runs `sudo pmset -a disablesleep <previous value>`. The daemon itself never runs as root.
- **Windows, `--lid`:** starts one elevated PowerShell through `Start-Process -Verb RunAs` (a UAC prompt) to run `powercfg` and change the lid action. A second prompt appears on `stop` to restore it.
- **Windows, stay awake:** a hidden, non-elevated PowerShell started with `-EncodedCommand` calls `SetThreadExecutionState`. The encoded script is fixed in the source and takes no user input.
- **Linux:** `systemd-inhibit` and `nmcli` run as your user.

Other things worth knowing:

- State is written to `~/.keepawake/` (or `$KEEPAWAKE_HOME`). It holds options, pids and the saved power settings, not credentials.
- The log records agent labels, not command lines.
- Wi-Fi names passed to `--hotspot` are handed to `networksetup`, `netsh` or `nmcli` as separate arguments, not through a shell string.
- `keepawake setup-auto` refuses `--lid`, so a root-level setting is never applied silently at login.
