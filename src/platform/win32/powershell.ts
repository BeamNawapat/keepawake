/** powershell.exe args that run a script without profile, prompts or window. */
export function encodedCommandArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/**
 * Single-quoted PowerShell literal. Only the quote itself is special inside
 * '...', so doubling it is enough to keep caller data out of the code path.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
