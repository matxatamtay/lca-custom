import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashBytes } from "../core/file-state.mjs";

export function createFsReadToolRegistrar(options) {
  const { reg, jsonResult, resolvePath, toRel, listEntries, ripgrepGrep, gitGrep, attachContext, findFiles, searchTree, buildTree, astGrepSearch, RG_BIN, MANIFEST_NAMES, MAX_BATCH_READ_CHARS, MAX_READ_CHARS, READ_DEFAULT } = options;

  function registerFsReadTools(mcp) {
    reg(
      mcp,
      "list_files",
      {
        title: "List files",
        description: "List files and folders from a project-relative or absolute path.",
        inputSchema: {
          path: z.string().optional().describe("Directory path. Relative paths resolve across configured workspaces; use an absolute or project-qualified path when ambiguous."),
          recursive: z.boolean().optional(),
          limit: z.number().int().min(1).max(2000).optional()
        }
      },
      async ({ path: rel = ".", recursive = false, limit = 200 }) => {
        const dir = resolvePath(rel);
        const entries = await listEntries(dir, { recursive, limit });
        return jsonResult({ path: toRel(dir), count: entries.length, entries });
      }
    );

    reg(
      mcp,
      "read_file",
      {
        title: "Read file",
        description: "Read ONE UTF-8 text file (supports line ranges). If you need several files, call read_many ONCE instead of calling this repeatedly — it is far faster over the network. For large files, pass start_line/line_count to read only the part you need.",
        inputSchema: {
          path: z.string().min(1),
          start_line: z.number().int().min(1).optional().describe("1-based first line to return."),
          line_count: z.number().int().min(1).max(20000).optional().describe("Number of lines to return from start_line."),
          max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional().describe(`Max chars to return (default ${READ_DEFAULT}).`)
        }
      },
      async ({ path: rel, start_line, line_count, max_chars = READ_DEFAULT }) => {
        const filePath = resolvePath(rel);
        const raw = await readFile(filePath);
        const content = raw.toString("utf8");
        const sha256 = hashBytes(raw);
        const allLines = content.split(/\r?\n/);
        if (start_line || line_count) {
          const from = (start_line || 1) - 1;
          const to = line_count ? from + line_count : allLines.length;
          const slice = allLines.slice(from, to).join("\n");
          return jsonResult({
            path: toRel(filePath),
            sha256,
            total_lines: allLines.length,
            start_line: from + 1,
            returned_lines: Math.min(to, allLines.length) - from,
            content: slice.length > max_chars ? slice.slice(0, max_chars) : slice,
            truncated: slice.length > max_chars
          });
        }
        const truncated = content.length > max_chars;
        return jsonResult({
          path: toRel(filePath),
          sha256,
          total_lines: allLines.length,
          chars: content.length,
          truncated,
          content: truncated ? content.slice(0, max_chars) : content
        });
      }
    );

    reg(
      mcp,
      "stat_path",
      {
        title: "Stat path",
        description: "Return metadata about a file or directory.",
        inputSchema: { path: z.string().min(1) }
      },
      async ({ path: rel }) => {
        const target = resolvePath(rel);
        const info = await stat(target);
        return jsonResult({
          path: toRel(target),
          type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
          size: info.size,
          modified: info.mtime.toISOString(),
          created: info.birthtime.toISOString()
        });
      }
    );

    reg(
      mcp,
      "search_text",
      {
        title: "Search text",
        description: "Search text under a path (ripgrep > git grep > file scan, picked automatically). Prefer this over reading many files. Use queries[] to batch several related searches into ONE round-trip. Pass context>0 to get surrounding lines so you usually do NOT need a follow-up read_file. Pass glob (e.g. \"*.ts\") to limit file types.",
        inputSchema: {
          query: z.string().min(1).optional().describe("Single search query. Use either query or queries."),
          queries: z.array(z.string().min(1)).min(1).max(12).optional().describe("Batch up to 12 related queries in one round-trip. Use either query or queries."),
          path: z.string().optional(),
          regex: z.boolean().optional(),
          glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
          context: z.number().int().min(0).max(10).optional().describe("Lines of context before/after each match."),
          limit: z.number().int().min(1).max(500).optional().describe("Max total-ish matches. For batches the budget is divided across queries.")
        }
      },
      async ({ query, queries, path: rel = ".", regex = false, glob, context = 0, limit = 100 }) => {
        if (query && queries?.length) throw new Error("Use either query or queries, not both.");
        const requested = queries?.length ? [...new Set(queries.map((item) => item.trim()).filter(Boolean))] : (query ? [query] : []);
        if (!requested.length) throw new Error("Provide query or queries.");
        const start = resolvePath(rel);
        const info = await stat(start).catch(() => null);
        const isDir = info && info.isDirectory();
        const perQueryLimit = requested.length === 1 ? limit : Math.max(1, Math.ceil(Math.min(500, limit) / requested.length));

        const runOne = async (searchQuery) => {
          let useRegex = regex;
          let regexFallback = false;
          if (regex) {
            try {
              new RegExp(searchQuery);
            } catch {
              useRegex = false;
              regexFallback = true;
            }
          }
          let engine = "scan";
          let matches = null;
          if (isDir && RG_BIN) {
            matches = await ripgrepGrep(start, searchQuery, { regex: useRegex, limit: perQueryLimit, glob });
            if (matches) engine = "ripgrep";
          }
          if (matches === null && isDir) {
            matches = await gitGrep(start, searchQuery, { regex: useRegex, limit: perQueryLimit, glob });
            if (matches) engine = "git";
          }
          if (matches === null) matches = await searchTree(start, searchQuery, { regex: useRegex, limit: perQueryLimit, glob });
          if (context > 0 && matches.length) await attachContext(matches, context);
          return {
            query: searchQuery,
            regex: useRegex,
            regex_fallback: regexFallback,
            engine,
            context,
            count: matches.length,
            matches
          };
        };

        const results = await Promise.all(requested.map(runOne));
        if (results.length === 1) return jsonResult(results[0]);
        return jsonResult({
          queries: requested,
          batch: true,
          count: results.reduce((sum, result) => sum + result.count, 0),
          per_query_limit: perQueryLimit,
          results
        });
      }
    );

    reg(
      mcp,
      "ast_search",
      {
        title: "Structural AST search",
        description: "Read-only structural search through ast-grep. Use for syntax-aware TS/JS patterns when text search is too broad. Respects normal ignore files, scopes to path, and returns bounded normalized matches. Missing ast-grep returns available=false without falling back to incorrect text semantics.",
        inputSchema: {
          pattern: z.string().min(1).max(20_000).describe("ast-grep structural pattern, e.g. Promise.all($$$A)."),
          lang: z.string().min(1).max(32).describe("ast-grep language id, e.g. ts, tsx, js, jsx."),
          path: z.string().optional().describe("File or directory to search. Defaults to the active workspace path."),
          glob: z.string().min(1).max(500).optional().describe('Optional ast-grep include/exclude glob, e.g. "*.ts".'),
          limit: z.number().int().min(1).max(500).optional().describe("Maximum matches returned. The ast-grep process is stopped once the limit is reached.")
        }
      },
      async ({ pattern, lang, path: rel = ".", glob, limit = 100 }) => {
        const start = resolvePath(rel);
        if (!astGrepSearch?.search) {
          return jsonResult({
            ok: false,
            engine: "ast-grep",
            available: false,
            reason: "ast-grep search runtime unavailable",
            pattern,
            lang,
            path: toRel(start),
            count: 0,
            truncated: false,
            matches: []
          });
        }
        return jsonResult(await astGrepSearch.search({
          start,
          pattern,
          lang,
          glob: glob || null,
          limit
        }));
      }
    );

    reg(
      mcp,
      "find_files",
      {
        title: "Find files",
        description: "List file paths matching a name glob (ripgrep > git ls-files > scan). Fast way to locate files (e.g. glob \"*.config.ts\") instead of listing directories one by one.",
        inputSchema: {
          glob: z.string().min(1).describe('Name glob, e.g. "*.ts" or "**/Dockerfile".'),
          path: z.string().optional().describe("Directory to search under."),
          limit: z.number().int().min(1).max(2000).optional()
        }
      },
      async ({ glob, path: rel = ".", limit = 300 }) => {
        const start = resolvePath(rel);
        const { files, engine } = await findFiles(start, glob, limit);
        return jsonResult({ glob, engine, count: files.length, files });
      }
    );

    reg(
      mcp,
      "read_many",
      {
        title: "Read many files",
        description: "Read up to 100 files or targeted line ranges in ONE call. Reads run concurrently with a bounded worker pool and a total output cap, cutting tunnel round-trips without flooding context.",
        inputSchema: {
          paths: z.array(z.string().min(1)).min(1).max(100).optional().describe("Simple file paths to read."),
          requests: z.array(z.object({
            path: z.string().min(1),
            start_line: z.number().int().min(1).optional(),
            line_count: z.number().int().min(1).max(10000).optional(),
            max_chars: z.number().int().min(1).max(MAX_READ_CHARS).optional()
          })).min(1).max(100).optional().describe("Structured reads with optional line ranges. Use either paths or requests."),
          max_chars_per_file: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
          concurrency: z.number().int().min(1).max(16).optional().describe("Concurrent local reads (default 8).")
        }
      },
      async ({ paths, requests, max_chars_per_file = 40_000, concurrency = 8 }) => {
        if (paths?.length && requests?.length) throw new Error("Use either paths or requests, not both.");
        const items = requests?.length ? requests : (paths || []).map((p) => ({ path: p }));
        if (!items.length) throw new Error("Provide at least one path or read request.");

        const files = new Array(items.length);
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            const request = items[index];
            try {
              const fp = resolvePath(request.path);
              const content = await readFile(fp, "utf8");
              const maxChars = request.max_chars || max_chars_per_file;
              if (request.start_line || request.line_count) {
                const lines = content.split(/\r?\n/);
                const start = request.start_line || 1;
                const count = request.line_count || lines.length;
                const selected = lines.slice(start - 1, start - 1 + count).join("\n");
                files[index] = {
                  path: toRel(fp),
                  total_lines: lines.length,
                  start_line: start,
                  returned_lines: Math.min(count, Math.max(0, lines.length - start + 1)),
                  chars: selected.length,
                  truncated: selected.length > maxChars,
                  content: selected.slice(0, maxChars)
                };
                continue;
              }
              files[index] = {
                path: toRel(fp),
                chars: content.length,
                truncated: content.length > maxChars,
                content: content.slice(0, maxChars)
              };
            } catch (err) {
              files[index] = { path: request.path, error: String(err?.message || err) };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

        let remaining = MAX_BATCH_READ_CHARS;
        let batchTruncated = false;
        for (const file of files) {
          if (typeof file.content !== "string") continue;
          if (file.content.length > remaining) {
            file.content = file.content.slice(0, Math.max(0, remaining));
            file.truncated = true;
            file.batch_truncated = true;
            batchTruncated = true;
          }
          remaining = Math.max(0, remaining - file.content.length);
        }
        return jsonResult({
          count: files.length,
          failed: files.filter((f) => f.error).length,
          chars_returned: MAX_BATCH_READ_CHARS - remaining,
          max_batch_chars: MAX_BATCH_READ_CHARS,
          batch_truncated: batchTruncated,
          files
        });
      }
    );

    reg(
      mcp,
      "repo_overview",
      {
        title: "Repo overview",
        description: "One call: a compact directory tree plus detected manifest/config files. Start here to map a repo instead of probing file-by-file.",
        inputSchema: {
          path: z.string().optional().describe("Directory to map. Defaults to the primary root."),
          depth: z.number().int().min(1).max(6).optional().describe("Tree depth (default 3)."),
          max_entries: z.number().int().min(10).max(4000).optional().describe("Max tree entries (default 800).")
        }
      },
      async ({ path: rel = ".", depth = 3, max_entries = 800 }) => {
        const start = resolvePath(rel);
        const { tree, dirs, files } = await buildTree(start, depth, max_entries);
        const manifests = files.filter((f) => MANIFEST_NAMES.has(path.basename(f).toLowerCase()));
        return jsonResult({
          root: toRel(start),
          depth,
          dirs: dirs.length,
          files: files.length,
          truncated: tree.length >= max_entries,
          manifests: manifests.map(toRel).slice(0, 100),
          tree: tree.map(toRel)
        });
      }
    );
  }


  return registerFsReadTools;
}
