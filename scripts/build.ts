// Bundles src/cli.ts into a single Node ESM file. Uses the Bun.build API
// instead of the CLI so there are no shell quoting differences on Windows.
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };

const result = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  outdir: join(root, "dist"),
  naming: "cli.js",
  target: "node",
  format: "esm",
  define: { __VERSION__: JSON.stringify(pkg.version) },
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

// Bun keeps the shebang from src/cli.ts. If a refactor ever drops it, npm
// would install a bin that the OS cannot execute, so fail the build here.
const outFile = join(root, "dist", "cli.js");
const firstLine = (await readFile(outFile, "utf8")).split(/\r?\n/, 1)[0];
if (firstLine !== "#!/usr/bin/env node") {
  console.error(`build: dist/cli.js must start with "#!/usr/bin/env node", got ${JSON.stringify(firstLine)}`);
  process.exit(1);
}

try {
  await chmod(outFile, 0o755);
} catch {
  // chmod is a no-op on Windows filesystems; npm sets the bit on install anyway.
}
console.log(`built dist/cli.js (v${pkg.version})`);
