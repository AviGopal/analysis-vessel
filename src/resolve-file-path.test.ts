// Pins resolveFilePath's path decisions. This vessel serves problem_detection and
// code_annotation, so this function decides which tree every goal walk investigating
// code is allowed to see.
//
// THIS TEST USED TO RE-DECLARE THE LOGIC INSTEAD OF IMPORTING IT (2026-08-09).
// resolveFilePath is async and awaits Bun.file().exists(), so I mirrored its pure
// decisions here — and the old header claimed "the constants are named explicitly so
// a drift in index.ts fails loudly instead of passing against a stale copy." That is
// exactly backwards: a mirrored copy CANNOT detect drift. The suite would have stayed
// green through any change to the real function, which is the self-confirming-oracle
// class and produces false negatives in any investigation that leans on it.
//
// The pure half is now exported as resolveFilePathPlan and imported here, so a change
// to the real decision breaks this file.
import { describe, expect, it } from "bun:test";

import { resolveFilePathPlan } from "./resolve-file-path";

const WORKSPACE_ROOT = "/workspace";

describe("resolveFilePathPlan", () => {
  it("probes the live tree first, then the git checkout", () => {
    const plan = resolveFilePathPlan("repos/activity-api/src/index.ts", WORKSPACE_ROOT);
    expect(plan.kind).toBe("candidates");
    if (plan.kind !== "candidates") throw new Error("unreachable");
    // ORDER IS THE CONTRACT: /vessels is what actually runs, so a mirrored vessel
    // must win over its checkout.
    expect(plan.candidates).toEqual([
      "/vessels/activity-api/src/index.ts",
      "/workspace/git/vessels/activity-api/src/index.ts",
    ]);
  });

  it("accepts a leading slash on repos/ the same way", () => {
    const plan = resolveFilePathPlan("/repos/goal-host-vessel/src/index.ts", WORKSPACE_ROOT);
    if (plan.kind !== "candidates") throw new Error("expected candidates");
    expect(plan.candidates[0]).toBe("/vessels/goal-host-vessel/src/index.ts");
  });

  it("NEVER offers /workspace/repos — that directory does not exist", () => {
    // The second candidate used to read ${WORKSPACE_ROOT}/repos/<vessel>. Verified on
    // the hub: /workspace/repos does NOT exist, /workspace/git/vessels does. So the
    // list had one working entry pretending to be two and the fallback could never fire.
    const plan = resolveFilePathPlan("repos/concept-db/sql/001.surql", WORKSPACE_ROOT);
    if (plan.kind !== "candidates") throw new Error("expected candidates");
    for (const c of plan.candidates) expect(c.startsWith("/workspace/repos/")).toBe(false);
  });

  it("anchors a bare relative path to the workspace, NOT this vessel's cwd", () => {
    // Falling through to the process cwd is what sent five walks hollow: they searched
    // a directory holding only this vessel, then invented filenames.
    expect(resolveFilePathPlan("scripts/substrate/vessels.inventory.json", WORKSPACE_ROOT)).toEqual({
      kind: "direct",
      path: "/workspace/scripts/substrate/vessels.inventory.json",
    });
  });

  it("leaves a non-repos absolute path untouched", () => {
    expect(resolveFilePathPlan("/etc/substrate/env", WORKSPACE_ROOT)).toEqual({
      kind: "direct",
      path: "/etc/substrate/env",
    });
  });
});
