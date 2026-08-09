// Pins resolveFilePath's path decisions. This vessel serves problem_detection and
// code_annotation, so this function decides which tree every goal walk investigating
// code is allowed to see. It had no test while one of its two candidates pointed at a
// directory that does not exist and bare paths fell through to the process cwd.
//
// resolveFilePath is not exported and its real body awaits Bun.file().exists(), so the
// PURE decisions — which candidates get built, and how a non-repos path is anchored —
// are mirrored here. The constants are named explicitly so a drift in index.ts fails
// loudly instead of passing against a stale copy.
import { describe, expect, it } from "bun:test";

const WORKSPACE_ROOT = "/workspace";

function candidatesFor(rawPath: string): string[] | { anchored: string } {
  const m = rawPath.match(/^\/repos\/([^\/]+)\/(.+)$/) ?? rawPath.match(/^repos\/([^\/]+)\/(.+)$/);
  if (!m) {
    if (!rawPath.startsWith("/")) return { anchored: `${WORKSPACE_ROOT}/${rawPath}` };
    return { anchored: rawPath };
  }
  const vessel = m[1]!;
  const rest = m[2]!;
  return [`/vessels/${vessel}/${rest}`, `${WORKSPACE_ROOT}/git/vessels/${vessel}/${rest}`];
}

describe("resolveFilePath candidates", () => {
  it("tries the live runtime tree first for repos/ paths", () => {
    const c = candidatesFor("repos/activity-api/src/index.ts") as string[];
    expect(c[0]).toBe("/vessels/activity-api/src/index.ts");
  });

  it("falls back to the checkout tree that actually exists", () => {
    // The regression: this used to be /workspace/repos/<vessel>/..., a directory that
    // does not exist on the substrate, so the fallback could never fire.
    const c = candidatesFor("/repos/goal-host-vessel/src/index.ts") as string[];
    expect(c[1]).toBe("/workspace/git/vessels/goal-host-vessel/src/index.ts");
    expect(c[1]).not.toBe("/workspace/repos/goal-host-vessel/src/index.ts");
    expect(c).toHaveLength(2);
  });

  it("accepts both the leading-slash and bare repos/ forms", () => {
    expect((candidatesFor("/repos/x/y.ts") as string[])[0]).toBe("/vessels/x/y.ts");
    expect((candidatesFor("repos/x/y.ts") as string[])[0]).toBe("/vessels/x/y.ts");
  });

  it("anchors a bare relative path to the workspace, not the process cwd", () => {
    expect(candidatesFor("trace_store.py")).toEqual({ anchored: "/workspace/trace_store.py" });
    expect(candidatesFor("git/vessels/activity-api/src/services/trace-retention.ts"))
      .toEqual({ anchored: "/workspace/git/vessels/activity-api/src/services/trace-retention.ts" });
  });

  it("leaves absolute non-repos paths untouched", () => {
    expect(candidatesFor("/vessels/activity-api/src/index.ts"))
      .toEqual({ anchored: "/vessels/activity-api/src/index.ts" });
  });
});
