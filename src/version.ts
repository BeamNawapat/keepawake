// __VERSION__ is replaced by scripts/build.ts (--define). Under `bun test`
// it is not defined, so the typeof guard falls back to "dev".
declare const __VERSION__: string | undefined;

export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
