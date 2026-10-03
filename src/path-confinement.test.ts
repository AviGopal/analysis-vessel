// Every analysis-vessel resolver reads a caller-supplied path. Before this file
// existed, any path was read — absolute paths passed straight through, relative
// ones were string-joined onto WORKSPACE_ROOT, and five of the six resolvers
// called Bun.file() on the raw input without even that. Served unauthenticated
// on /resolve, that is "read any file the vessel's user can read", including the
// fleet's env file and /proc/self/environ.
//
// These tests pin the confinement: a path is read only if its FULLY RESOLVED
// location (symlinks followed) lies under one of the analysis roots, and never
// inside NEVER_INSIDE_A_ROOT. All fixtures live under tmpdir(); the only real
// system paths named are /etc/hostname and /proc/self/environ, which are
// expected to be REFUSED before any read.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NEVER_INSIDE_A_ROOT,
  analysisRoots,
  confinePath,
  configuredAnalysisRoots,
  toolRoots,
} from "./path-confinement";
import { readConfinedText, resolveConfinedPath, type ConfinedReadConfig } from "./resolve-file-path";

const OUTSIDE_MARKER = "OUTSIDE-THE-ROOTS-FIXTURE";

let base = "";
let ws = "";
let vessels = "";
let outside = "";
let cfg: ConfinedReadConfig;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "av-confine-")));
  ws = join(base, "ws");
  vessels = join(base, "vessels");
  outside = join(base, "outside");
  mkdirSync(join(vessels, "demo", "src"), { recursive: true });
  mkdirSync(join(ws, "scripts"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vessels, "demo", "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(ws, "scripts", "inv.json"), '{"ok":true}\n');
  writeFileSync(join(outside, "secret.txt"), OUTSIDE_MARKER + "\n");
  // A file symlink and a directory symlink, both inside a root, both pointing out.
  symlinkSync(join(outside, "secret.txt"), join(vessels, "demo", "src", "leak.ts"));
  symlinkSync(outside, join(vessels, "demo", "escape"));
  cfg = {
    workspaceRoot: ws,
    runtimeDir: vessels,
    roots: analysisRoots({
      workspaceRoot: ws,
      runtimeDir: vessels,
      pushCloneDir: join(ws, "git", "vessels"),
      composeDir: join(ws, "git", "compose"),
      extra: [],
    }),
  };
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

async function refused(raw: string): Promise<string> {
  let content: string | undefined;
  let err: Error | undefined;
  try {
    content = await readConfinedText(raw, cfg);
  } catch (e) {
    err = e as Error;
  }
  expect(content).toBeUndefined();
  expect(err).toBeDefined();
  expect(err!.message).toMatch(/outside the analysis roots/);
  expect(err!.message).not.toContain(OUTSIDE_MARKER);
  return err!.message;
}

describe("confined reads — still served", () => {
  it("reads an in-root repos/<vessel>/src file via the runtime-tree mapping", async () => {
    expect(await readConfinedText("repos/demo/src/a.ts", cfg)).toBe("export const a = 1;\nexport const b = 2;\n");
  });

  it("reads a relative in-root path anchored to the workspace", async () => {
    expect(await readConfinedText("scripts/inv.json", cfg)).toBe('{"ok":true}\n');
  });

  it("reads an absolute path whose realpath is inside a root", async () => {
    expect(await readConfinedText(join(vessels, "demo", "src", "a.ts"), cfg)).toContain("export const a");
  });

  it("returns the requested line window", async () => {
    expect(await readConfinedText("repos/demo/src/a.ts", cfg, 2, 2)).toBe("export const b = 2;");
  });
});

describe("confined reads — REFUSED with an error, never content", () => {
  it("refuses /etc/hostname", async () => {
    await refused("/etc/hostname");
  });

  it("refuses /proc/self/environ", async () => {
    await refused("/proc/self/environ");
  });

  it("refuses an absolute path to a file outside every root", async () => {
    // Positive control: the fixture really exists and is readable by this process,
    // so a refusal is the guard, not a missing file.
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toContain(OUTSIDE_MARKER);
    await refused(join(outside, "secret.txt"));
  });

  it("refuses a relative ../ escape out of the workspace", async () => {
    await refused("../outside/secret.txt");
    await refused("scripts/../../outside/secret.txt");
  });

  it("refuses a ../ escape smuggled through the repos/<vessel>/ mapping", async () => {
    await refused("repos/demo/../../outside/secret.txt");
  });

  it("refuses a FILE symlink inside a root that points outside it", async () => {
    await refused(join(vessels, "demo", "src", "leak.ts"));
    await refused("repos/demo/src/leak.ts");
  });

  it("refuses a path through a DIRECTORY symlink inside a root that points outside it", async () => {
    await refused("repos/demo/escape/secret.txt");
  });

  it("resolveConfinedPath refuses without touching the file", async () => {
    await expect(resolveConfinedPath("/etc/hostname", cfg)).rejects.toThrow(/outside the analysis roots/);
  });
});

describe("NEVER_INSIDE_A_ROOT — enforced on roots AND on resolved paths", () => {
  it("names /etc, /proc and the workspace secrets dir", () => {
    expect(NEVER_INSIDE_A_ROOT).toEqual(expect.arrayContaining(["/etc", "/proc", "/workspace/.substrate-secrets"]));
  });

  it("drops a misconfigured root that would contain a protected location", () => {
    expect(toolRoots(["/"])).toEqual([]);
    expect(toolRoots(["/etc"])).toEqual([]);
  });

  it("refuses a protected path even when a root (wrongly) covers it", () => {
    // confinePath is handed "/" directly, bypassing toolRoots' pruning: the
    // resolved-path check is the second, independent layer.
    expect(confinePath("/etc/hostname", ["/"])).toBeNull();
    expect(confinePath("/proc/self/environ", ["/"])).toBeNull();
  });

  it("the production root set never includes / , /workspace or a protected location", () => {
    const roots = configuredAnalysisRoots({});
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      expect(r).not.toBe("/");
      expect(r).not.toBe("/workspace");
      for (const n of NEVER_INSIDE_A_ROOT) expect(r === n || r.startsWith(n + "/") || n.startsWith(r + "/")).toBe(false);
    }
  });
});

describe("every resolver goes through the confined reader", () => {
  it("index.ts has no raw Bun.file() read left", () => {
    // Five of six resolvers used to call Bun.file(<caller path>) directly,
    // bypassing even the path mapping. A raw read reappearing is the same defect.
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src.match(/Bun\.file\(/g) ?? []).toEqual([]);
    expect(src).toContain("readConfinedText");
  });
});
