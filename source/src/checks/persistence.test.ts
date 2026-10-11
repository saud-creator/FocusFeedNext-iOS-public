// @vitest-environment node
//
// Repository invariants, checked by reading the source tree rather than by
// rendering anything. These live outside `tsconfig.app.json` (see
// `tsconfig.checks.json`) so that Node types stay out of the renderer.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function offendersMatching(files: string[], pattern: RegExp): string[] {
  return files
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(SRC.length).replace(/\\/g, "/"));
}

/**
 * The web layer must not persist anything.
 *
 * Everything a reader accumulates — search terms, scroll position, filters,
 * read state — belongs to the run that produced it, and the Rust side deletes
 * that run's storage on exit. Browser storage would quietly reintroduce
 * durability the backend cannot see and the user cannot clear: `localStorage`
 * survives a restart outright, and while `sessionStorage` dies with the
 * WebView, it still sits in the user's WebView2 profile on disk during the run,
 * well outside the session directory that cleanup removes.
 *
 * A whole-tree scan rather than a per-component test on purpose: a page added
 * later cannot slip past it.
 */
describe("browser persistence", () => {
  const files = sourceFiles(SRC).filter((f) => !f.includes("checks"));

  it("finds source files to scan", () => {
    // Guards the guard: a broken path would otherwise pass vacuously.
    expect(files.length).toBeGreaterThan(20);
  });

  it("never uses localStorage or sessionStorage", () => {
    expect(
      offendersMatching(files, /\b(localStorage|sessionStorage)\b/),
    ).toEqual([]);
  });

  it("never uses document.cookie or IndexedDB", () => {
    expect(
      offendersMatching(files, /\b(document\.cookie|indexedDB)\b/),
    ).toEqual([]);
  });
});
