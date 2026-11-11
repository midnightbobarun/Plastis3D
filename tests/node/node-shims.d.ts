// tests/node/node-shims.d.ts — minimal ambient declarations for the
// node: builtins the Tier 2 tests use.
//
// @types/node is NOT installed in this repo, and PR4 may not add a new
// npm dependency. These declarations cover only the functions the tests
// call (readFileSync, fileURLToPath); the real implementations come
// from Node at runtime. If @types/node is ever added, delete this file.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf-8"): string;
  export function readFileSync(path: string | URL): Uint8Array;
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
declare module "node:child_process" {
 export function execFileSync(file: string, args: string[], options: { input?: string; encoding: "utf-8" }): string;
}
declare const process: { platform: string };
