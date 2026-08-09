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
export const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";

export type FilePathPlan =
  | { kind: "direct"; path: string }
  | { kind: "candidates"; candidates: string[] };

export function resolveFilePathPlan(
  rawPath: string,
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
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
  // ORDER IS THE CONTRACT: /vessels is what actually runs, so a mirrored vessel wins
  // over its checkout. The second entry was once ${workspaceRoot}/repos/<vessel>, which
  // does not exist on the substrate — one working entry pretending to be two.
  return {
    kind: "candidates",
    candidates: [`/vessels/${vessel}/${rest}`, `${workspaceRoot}/git/vessels/${vessel}/${rest}`],
  };
}
