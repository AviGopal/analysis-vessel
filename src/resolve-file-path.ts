/**
 * The PURE half of resolveFilePath: which path a raw input maps to, or which
 * candidates must be probed, with no filesystem access.
 *
 * ITS OWN MODULE, DELIBERATELY (2026-08-09). The previous test re-declared this
 * logic rather than importing it, and its header claimed "a drift in index.ts
 * fails loudly instead of passing against a stale copy" — exactly backwards, since
 * a mirrored copy cannot detect drift at all.
 *
 * The reason for the mirroring was real, though: index.ts boots an HTTP server on
 * import and pulls in @avigopal/cpg-inference, so a test that imports it fails to
 * load before running a single assertion. Exporting from index.ts therefore does
 * NOT make this testable — the logic has to leave index.ts, which is what
 * goal-host-vessel did for the same reason.
 */
import { OUTSIDE_ROOTS_ERROR, confinePath } from "./path-confinement";

export const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";

export type FilePathPlan =
  | { kind: "direct"; path: string }
  | { kind: "candidates"; candidates: string[] };

export function resolveFilePathPlan(
  rawPath: string,
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
  runtimeDir: string = "/vessels",
): FilePathPlan {
  const m =
    rawPath.match(/^\/repos\/([^\/]+)\/(.+)$/) ?? rawPath.match(/^repos\/([^\/]+)\/(.+)$/);
  if (!m) {
    // A bare relative name used to fall through to this vessel's own cwd, which holds
    // only this vessel — every such read failed ENOENT and the walk then invented
    // filenames. Anchoring to the workspace makes a legitimately-discovered path
    // resolve; absolute paths are untouched so working callers are unaffected.
    if (!rawPath.startsWith("/")) return { kind: "direct", path: `${workspaceRoot}/${rawPath}` };
    return { kind: "direct", path: rawPath };
  }
  const vessel = m[1]!;
  const rest = m[2]!;
  // ORDER IS THE CONTRACT: /vessels (runtimeDir) is what actually runs, so a mirrored vessel wins
  // over its checkout. The second entry was once ${workspaceRoot}/repos/<vessel>, which
  // does not exist on the substrate — one working entry pretending to be two.
  return {
    kind: "candidates",
    candidates: [`${runtimeDir}/${vessel}/${rest}`, `${workspaceRoot}/git/vessels/${vessel}/${rest}`],
  };
}

// ── the confined half ────────────────────────────────────────────────────────
// The plan above only decides WHICH path a raw input names; it refuses nothing.
// Every read this vessel performs goes through resolveConfinedPath, which maps
// the input with the plan and then refuses anything whose realpath is outside
// the analysis roots (see ./path-confinement). A refused path is never stat'ed
// as a candidate and never read.

export interface ConfinedReadConfig {
  workspaceRoot: string;
  runtimeDir: string;
  roots: readonly string[];
}

export class PathRefusedError extends Error {
  constructor(rawPath: string) {
    super(`${OUTSIDE_ROOTS_ERROR}: ${rawPath}`);
    this.name = "PathRefusedError";
  }
}

export async function resolveConfinedPath(rawPath: string, cfg: ConfinedReadConfig): Promise<string> {
  const plan = resolveFilePathPlan(rawPath, cfg.workspaceRoot, cfg.runtimeDir);
  if (plan.kind === "direct") {
    const real = confinePath(plan.path, cfg.roots);
    if (!real) throw new PathRefusedError(rawPath);
    return real;
  }
  // ANY refused candidate refuses the request. Skipping it and probing the next
  // would still answer — as ENOENT — for a path that escapes the roots, and would
  // stat locations the caller has no business naming.
  const confined: string[] = [];
  for (const candidate of plan.candidates) {
    const real = confinePath(candidate, cfg.roots);
    if (!real) throw new PathRefusedError(rawPath);
    confined.push(real);
  }
  for (const real of confined) {
    if (await Bun.file(real).exists()) return real;
  }
  throw new Error(`ENOENT: no such file — tried: ${plan.candidates.join(", ")}`);
}

/**
 * Read a caller-supplied path, confined. Reads the RESOLVED location, not the
 * raw input, so the symlink chain that was checked is the one that is read.
 * A transient ENOENT (a tree being swapped under /vessels) is retried briefly.
 */
export async function readConfinedText(
  rawPath: string,
  cfg: ConfinedReadConfig,
  lineStart?: number,
  lineEnd?: number,
): Promise<string> {
  const resolved = await resolveConfinedPath(rawPath, cfg);
  let text = "";
  for (let attempt = 0; ; attempt++) {
    try { text = await Bun.file(resolved).text(); break; }
    catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (attempt < 5 && /ENOENT|no such file/i.test(msg)) { await new Promise((r) => setTimeout(r, 80)); continue; }
      throw e;
    }
  }
  if (lineStart === undefined && lineEnd === undefined) return text;
  const lines = text.split("\n");
  const start = Math.max(0, (lineStart ?? 1) - 1);
  const end = lineEnd ? Math.min(lines.length, lineEnd) : lines.length;
  return lines.slice(start, end).join("\n");
}
