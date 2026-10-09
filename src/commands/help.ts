/** Mirrored verbatim in the README between the <!-- help --> markers. Plain text, so the two can be diffed. */
export const HELP = `keepawake start [flags]      foreground (or -d)
keepawake stop               kill daemon, restore everything, clear state
keepawake restart [flags]    stop + start (no flags = reuse flags from state.json)
keepawake status [--json]    daemon / mode / lid / hotspot / holder / agents / internet / system sleep
keepawake check [--json]     detect once; exit 0 if an agent is found, 1 if not
keepawake log                tail the log (pure Node, works on Windows)
keepawake doctor [--fix]     find stale pid, orphan holder, stuck lid setting, broken autostart; --fix repairs
keepawake setup-auto [flags] start on login (LaunchAgent / HKCU Run key / systemd --user); rejects --lid
keepawake remove-auto
keepawake uninstall          stop + remove-auto + delete ~/.keepawake + print \`npm rm -g <name>\`
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
`;
