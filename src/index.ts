/**
 * analysis-vessel — code analysis resolver vessel.
 *
 * Replaces metabob-analysis-api as the discovery-registered resolver for
 * code analysis shapes. Uses cpg-inference-ts for structural analysis;
 * no SurrealDB dependency (stateless per-request analysis).
 *
 * Port: 8250  |  Discovery: http://127.0.0.1:8100
 * Shapes: problem_detection, error_log, source_code,
 *         code_quality, code_annotation, cpg_query_result
 */

import { ActivityExecutor, ExecutionRuntime, VesselDaemon } from "@avigopal/ias-executor-ts";
import type { ResolverHandler } from "@avigopal/ias-executor-ts";
import { GraphBuilder, CodePropertyGraph, NodeType, initParser } from "@avigopal/cpg-inference";

const PORT = Number(process.env.PORT ?? 8250);
const VESSEL_ID = process.env.VESSEL_ID ?? "analysis-vessel-local";
const DISCOVERY = process.env.DISCOVERY_VESSEL_ENDPOINT ?? process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
const ACTIVITY_API = process.env.ACTIVITY_API_URL ?? process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const API_KEY = process.env.METABOB_API_KEY ?? "";

// ── helpers ──────────────────────────────────────────────────────────────────

function str(o: unknown, ...keys: string[]): string | undefined {
  let v: unknown = o;
  for (const k of keys) {
    v = (typeof v === "object" && v !== null) ? (v as Record<string, unknown>)[k] : undefined;
  }
  return typeof v === "string" ? v : undefined;
}

function num(o: unknown, ...keys: string[]): number | undefined {
  let v: unknown = o;
  for (const k of keys) {
    v = (typeof v === "object" && v !== null) ? (v as Record<string, unknown>)[k] : undefined;
  }
  return typeof v === "number" ? v : undefined;
}

function arr(o: unknown, ...keys: string[]): unknown[] | undefined {
  let v: unknown = o;
  for (const k of keys) {
    v = (typeof v === "object" && v !== null) ? (v as Record<string, unknown>)[k] : undefined;
  }
  return Array.isArray(v) ? v : undefined;
}

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";

async function resolveFilePath(rawPath: string): Promise<string> {
  const m = rawPath.match(/^\/repos\/([^\/]+)\/(.+)$/) ?? rawPath.match(/^repos\/([^\/]+)\/(.+)$/);
  if (!m) return rawPath;
  const vessel = m[1]!;
  const rest = m[2]!;
  const candidates = [
    `/vessels/${vessel}/${rest}`,
    `${WORKSPACE_ROOT}/repos/${vessel}/${rest}`,
  ];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`ENOENT: no such file — tried: ${candidates.join(", ")}`);
}

async function readFile(path: string, lineStart?: number, lineEnd?: number): Promise<string> {
  const resolved = await resolveFilePath(path);
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

const CPG_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);

function isCPGSupported(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return ext ? CPG_EXTENSIONS.has(ext) : false;
}

function buildCPG(filePath: string, source: string): CodePropertyGraph {
  const cpg = new CodePropertyGraph();
  const builder = new GraphBuilder(cpg);
  builder.addFile(filePath, source);
  return cpg;
}

// ── resolvers ─────────────────────────────────────────────────────────────────

const sourceCode: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const filePath = str(pointer, "filePath") ?? str(pointer, "path") ?? str(pointer, "file_path");
  if (!filePath) return { error: "filePath is required" };
  const lineStart = num(pointer, "options", "line_start");
  const lineEnd = num(pointer, "options", "line_end");
  try {
    const content = await readFile(filePath, lineStart, lineEnd);
    return { shape: "source_code", filePath, content, lines: content.split("\n").length };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const errorLog: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const logFilePath = str(pointer, "logFilePath") ?? str(pointer, "path") ?? str(pointer, "file_path");
  if (!logFilePath) return { error: "logFilePath is required" };
  const maxLines = num(pointer, "options", "max_lines") ?? 100;
  try {
    const text = await Bun.file(logFilePath).text();
    const lines = text.split("\n").filter(l => l.trim());
    const limited = lines.slice(-maxLines);
    return {
      shape: "error_log",
      logFilePath,
      lines: limited,
      total_lines: lines.length,
      truncated: lines.length > maxLines,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const problemDetection: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const filePaths = arr(pointer, "filePaths") ?? arr(pointer, "file_paths");
  if (!filePaths || filePaths.length === 0) return { error: "filePaths is required" };
  const maxProblems = num(pointer, "options", "max_problems") ?? 100;

  const problems: Array<Record<string, unknown>> = [];
  for (const fp of filePaths as string[]) {
    try {
      const source = await Bun.file(fp).text();
      if (isCPGSupported(fp)) {
        const cpg = buildCPG(fp, source);
        const nodes = Array.from(cpg.nodes.values());

        for (const node of nodes) {
          if (problems.length >= maxProblems) break;
          if (node.type === NodeType.FUNCTION && node.endLine && node.startLine &&
              node.endLine - node.startLine > 80) {
            problems.push({
              file: fp,
              line: node.startLine ?? 0,
              column: 0,
              severity: "low",
              category: "complexity",
              message: `Function '${node.name}' is ${node.endLine - node.startLine} lines long (>80)`,
            });
          }
        }

        const fileNode = nodes.find(n => n.type === NodeType.FILE);
        if (!fileNode) {
          problems.push({
            file: fp,
            line: 0,
            column: 0,
            severity: "high",
            category: "parse_error",
            message: "CPG could not build a file node — possible syntax error",
          });
        }
      }
    } catch (e) {
      problems.push({
        file: fp,
        line: 0,
        column: 0,
        severity: "high",
        category: "read_error",
        message: (e as Error).message,
      });
    }
  }

  // ERROR-AS-CONTENT GUARD (2026-08-03). When EVERY requested path failed to read,
  // this resolver used to return a SUCCESS-shaped envelope whose problems[] carried the
  // ENOENT text. goal-host's rawResolve rejection guard only fires on `success:false` or a
  // top-level `error`, so it could not see this: the filesystem error survived as legitimate
  // produced content, was bound as a composed note body, and an LLM narrated it into a
  // confident "Failure Analysis / Root Cause / Lessons Learned" report about a file that
  // never existed (memoryNote gap-route-edit-1ac09d4f-failure-analysis-*).
  // The error key is added ONLY on this path: VesselDaemon computes success as the ABSENCE
  // of the key (`"error" in result`), so an always-present `error: ""` would mark every
  // healthy call failed. Partial results are preserved — if any file read, the normal
  // envelope is returned. Matches the bare-{error} idiom every sibling resolver here uses.
  if (problems.length > 0 && problems.every((p) => String((p as Record<string, unknown>)["category"]) === "read_error")) {
    return { error: "no analyzable file: " + problems.map((p) => String((p as Record<string, unknown>)["message"])).join("; ") };
  }
  return {
    shape: "problem_detection",
    problems,
    files_analyzed: filePaths.length,
    problems_found: problems.length,
  };
};

const codeQuality: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const filePath = str(pointer, "filePath") ?? str(pointer, "path") ?? str(pointer, "file_path");
  if (!filePath) return { error: "filePath is required" };
  try {
    const source = await Bun.file(filePath).text();
    const lines = source.split("\n");
    const base = {
      total_lines: lines.length,
      non_empty_lines: lines.filter(l => l.trim()).length,
    };
    if (!isCPGSupported(filePath)) {
      return { shape: "code_quality", filePath, metrics: { ...base, cpg_supported: false } };
    }
    const cpg = buildCPG(filePath, source);
    const nodes = Array.from(cpg.nodes.values());
    const functionCount = nodes.filter(n => n.type === NodeType.FUNCTION || n.type === NodeType.METHOD).length;
    const classCount = nodes.filter(n => n.type === NodeType.CLASS).length;
    const statementCount = nodes.filter(n => n.type === NodeType.STATEMENT).length;
    return {
      shape: "code_quality",
      filePath,
      metrics: {
        ...base,
        function_count: functionCount,
        class_count: classCount,
        statement_count: statementCount,
        node_count: nodes.length,
        cpg_supported: true,
      },
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const codeAnnotation: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const filePath = str(pointer, "filePath") ?? str(pointer, "path") ?? str(pointer, "file_path");
  if (!filePath) return { error: "filePath is required" };
  try {
    const source = await Bun.file(filePath).text();
    if (!isCPGSupported(filePath)) {
      return { shape: "code_annotation", filePath, annotations: [], total: 0, cpg_supported: false };
    }
    const cpg = buildCPG(filePath, source);
    const nodes = Array.from(cpg.nodes.values()).slice(0, 200); // cap for budget
    const annotations = nodes
      .filter(n => n.type !== NodeType.FILE)
      .map(n => ({
        line: n.startLine,
        end_line: n.endLine,
        type: n.type,
        name: n.name,
        id: n.id,
      }));
    return { shape: "code_annotation", filePath, annotations, total: annotations.length };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const cpgQueryResult: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const pointer = (body?.impulse as Record<string, unknown>)?.pointer ?? body;
  const filePaths = arr(pointer, "filePaths") ?? arr(pointer, "file_paths");
  const nodeType = str(pointer, "node_type");
  if (!filePaths || filePaths.length === 0) return { error: "filePaths is required" };
  try {
    const cpg = new CodePropertyGraph();
    const builder = new GraphBuilder(cpg);
    for (const fp of filePaths as string[]) {
      const source = await Bun.file(fp).text();
      builder.addFile(fp, source);
    }
    const allNodes = Array.from(cpg.nodes.values());
    const filtered = nodeType
      ? allNodes.filter(n => n.type === nodeType)
      : allNodes;
    return {
      shape: "cpg_query_result",
      files: filePaths,
      node_type_filter: nodeType ?? null,
      results: filtered.slice(0, 500).map(n => ({
        id: n.id, type: n.type, name: n.name, start_line: n.startLine, end_line: n.endLine,
      })),
      total: filtered.length,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

// ── daemon ────────────────────────────────────────────────────────────────────

const resolvers = new Map<string, ResolverHandler>([
  ["source_code", sourceCode],
  ["error_log", errorLog],
  ["problem_detection", problemDetection],
  ["code_quality", codeQuality],
  ["code_annotation", codeAnnotation],
  ["cpg_query_result", cpgQueryResult],
]);

// Warm up the WASM tree-sitter runtime + grammars once before serving. The
// CPG resolvers drive GraphBuilder/SourceParser synchronously inside request
// handlers; web-tree-sitter init is async, so it must complete here first.
await initParser();

const runtime = new ExecutionRuntime({
  attachedVessels: [{
    id: VESSEL_ID,
    kind: "analysis" as never,
    resolverIds: Array.from(resolvers.keys()),
  }],
});

await new VesselDaemon({
  port: PORT,
  vesselId: VESSEL_ID,
  vesselName: "Analysis Vessel",
  shapes: [
    "source_code",
    "error_log",
    "problem_detection",
    "code_quality",
    "code_annotation",
    "cpg_query_result",
  ],
  executor: new ActivityExecutor(runtime),
  resolvers,
  discoveryEndpoint: DISCOVERY,
  activityApiEndpoint: ACTIVITY_API,
  apiKey: API_KEY || undefined,
  version: "0.1.0",
  enforceCompositionChain: false,
}).start();

console.log(`[analysis-vessel] listening on http://127.0.0.1:${PORT}`);

// ─────────────────────────────────────────────────────────────────────────────
// Iteration 9 of the cross-vessel OOM hunt — periodic Bun.gc(true) workaround.
// See: concept_T-CTTOEl97IM (description), concept_s9ye5GKLw2L8 (signature),
//      concept_9ldsmRgqSTd5 (iter-6 derivation in goal-host-vessel).
//
// Hypothesis: Bun 1.3.14 retains heap-arena pages after free; affected vessels
// show RSS growth disconnected from heapUsed. goal-host hit OOM first because
// of its event volume; per iter-9 we apply the same workaround substrate-wide.
// A periodic forced full GC bounds RSS without changing semantics.
//
// .unref() so the timer doesn't prevent process exit.
// ─────────────────────────────────────────────────────────────────────────────
const GC_INTERVAL_MS = parseInt(process.env.ANALYSIS_VESSEL_GC_INTERVAL_MS ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] vessel=analysis-vessel freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
}, GC_INTERVAL_MS).unref();
