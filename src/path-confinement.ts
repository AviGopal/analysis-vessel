// Confines every analysis-vessel file read to the roots it serves.
//
// PORTED, NOT INVENTED: this is local-tools-vessel's src/tool-roots.ts (the
// fleet's existing realpath confinement for in-process file tools). No shared
// package exports it and analysis-vessel does not depend on local-tools-vessel,
// so the pattern is copied with its rule intact. Keep the two in step; if it is
// ever lifted into packages/, import it from there instead.
//
// Why: this vessel serves source_code, error_log, problem_detection,
// code_quality, code_annotation and cpg_query_result on /resolve, all of which
// read a caller-supplied path inside a process that holds the fleet's
// credentials in its env. Absolute paths passed straight through, so
// /etc/substrate/env or /proc/self/environ came back as "source code".
//
// The rule is locality, not a path denylist: a path is read only if its FULLY
// RESOLVED location (symlinks followed) lies under one of the roots. Additionally,
// unlike tool-roots.ts which only prunes roots, NEVER_INSIDE_A_ROOT is also
// checked against the resolved path itself — a second, independent layer.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Locations that must never be read. A configured root that equals, contains or
 * lies inside one of these is dropped, AND a resolved path inside one is refused.
 */
export const NEVER_INSIDE_A_ROOT: readonly string[] = ["/etc", "/proc", "/workspace/.substrate-secrets"];

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a path to where it really lives: realpath when it exists; otherwise
 * realpath of the nearest existing ancestor plus the not-yet-existing tail.
 * Returns null only if nothing on the way up can be resolved.
 */
export function realLocation(p: string): string | null {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.push(cur.slice(parent.length).replace(/^\/+/, ""));
      cur = parent;
    }
  }
}

function isProtected(p: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((n) => {
    const rn = realLocation(n) ?? n;
    return within(p, rn) || within(p, n);
  });
}

/**
 * The roots, fully resolved. Unset/empty/relative entries are skipped; a root
 * that equals, contains or lies inside a protected location is dropped.
 */
export function toolRoots(
  configured: Array<string | undefined>,
  protectedPaths: readonly string[] = NEVER_INSIDE_A_ROOT,
): string[] {
  const out: string[] = [];
  for (const r of configured) {
    if (!r || !isAbsolute(r)) continue;
    const real = realLocation(r) ?? resolve(r);
    const protectedHit = protectedPaths.some((n) => {
      const rn = realLocation(n) ?? n;
      return within(rn, real) || within(n, real) || within(real, rn) || within(real, n);
    });
    if (protectedHit) continue;
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * The fully resolved path if it lies under one of `roots` and inside no
 * protected location, else null.
 */
export function confinePath(
  path: string | undefined,
  roots: readonly string[],
  protectedPaths: readonly string[] = NEVER_INSIDE_A_ROOT,
): string | null {
  if (!path) return null;
  const real = realLocation(path);
  if (!real) return null;
  if (isProtected(real, protectedPaths)) return null;
  for (const root of roots) if (within(real, root)) return real;
  return null;
}

export const OUTSIDE_ROOTS_ERROR = "path outside the analysis roots";

/**
 * Workspace data directories, as local-tools-vessel measured them, plus the
 * super-repo trees analysis reads (scripts/, docs/, packages/). The workspace
 * itself is NOT a root: it also holds .substrate-secrets, keys/ and env/.
 */
export const WORKSPACE_DATA_DIRS: readonly string[] = [
  "proposals", "observations", "patterns", "validation", "refinement", "openspec",
  "snapshots", "health-gap-closures", "findings", "gaps", "concept-ingest", "concepts",
  "repos", "scripts", "docs", "packages",
];

export interface AnalysisRootConfig {
  /** Relative-path anchor (WORKSPACE_ROOT). Only its data dirs become roots. */
  workspaceRoot: string;
  /** The running vessel tree (/vessels) that repos/<v>/… maps onto first. */
  runtimeDir: string;
  /** Vessel clones /vessels symlinks point into. */
  pushCloneDir: string;
  /** Compose worktrees. */
  composeDir: string;
  /** EXTRA_WORKSPACE_ROOTS, already split. */
  extra: string[];
}

export function analysisRoots(c: AnalysisRootConfig): string[] {
  return toolRoots(
    [
      c.runtimeDir,
      c.pushCloneDir,
      c.composeDir,
      ...c.extra,
      ...WORKSPACE_DATA_DIRS.map((d) => join(c.workspaceRoot, d)),
    ],
    [...NEVER_INSIDE_A_ROOT, join(c.workspaceRoot, ".substrate-secrets")],
  );
}

/**
 * Production roots from the settings the fleet already uses (same names and
 * defaults as local-tools-vessel's configuredToolRoots, minus its temp dir:
 * analysis only reads, and nothing it serves lives in /tmp).
 */
export function configuredAnalysisRoots(env: Record<string, string | undefined>): string[] {
  const workspaceRoot = env.WORKSPACE_ROOT ?? "/workspace";
  return analysisRoots({
    workspaceRoot,
    runtimeDir: env.MITOSIS_RUNTIME_DIR ?? "/vessels",
    pushCloneDir: env.MITOSIS_PUSH_CLONE_DIR ?? `${workspaceRoot}/git/vessels`,
    composeDir: env.COMPOSE_WS_DIR ?? `${workspaceRoot}/git/compose`,
    extra: (env.EXTRA_WORKSPACE_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
}
