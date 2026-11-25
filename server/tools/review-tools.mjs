import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export function createReviewToolRegistrar(options) {
  const {
    reg, jsonResult, analyzeDiff, buildSessionReport, buildTree, resolvePath,
    ripgrepGrep, searchTree, spawnCapture, toRel, DEFAULT_CMD_TIMEOUT, RG_BIN
  } = options;

  function registerReviewTools(mcp) {
    reg(
      mcp,
      "session_report",
      {
        title: "Session report Pro",
        description: "PRO end-of-session report: git state, doctor summary, mode, policy, root, and version.",
        inputSchema: {
          cwd: z.string().optional().describe("Project-relative or absolute repository directory (default primary project).")
        }
      },
      async ({ cwd = "." }) => {
        const rootDir = resolvePath(cwd);
        return jsonResult(await buildSessionReport(rootDir));
      }
    );

    reg(
      mcp,
      "review_diff",
      {
        title: "Review diff",
        description: "Run heuristic code-review checks on git diff (working tree). Returns findings as P1/P2/P3 file:line items + verdict.",
        inputSchema: {
          staged: z.boolean().optional().describe("Review staged changes instead of working tree."),
          cwd: z.string().optional()
        }
      },
      async ({ staged = false, cwd = "." }) => {
        const rootDir = resolvePath(cwd);
        const args = ["diff"];
        if (staged) args.push("--staged");
        const result = await spawnCapture("git", args, rootDir, DEFAULT_CMD_TIMEOUT);
        if (result.exit_code !== 0) {
          return jsonResult({ ok: false, error: "Not a git repo or git error.", diff: "" });
        }
        const diff = result.stdout || "";
        if (!diff.trim()) return jsonResult({ ok: true, verdict: "CLEAN", summary: { changed_files: 0, source_files: 0, test_files: 0, config_files: 0, added_lines: 0, deleted_lines: 0, files: [] }, findings: [], message: "No changes in working tree." });

        const { summary, findings } = analyzeDiff(diff);
        const p1 = findings.filter((f) => f.priority === "P1").length;
        const verdict = p1 > 0 ? "BLOCK" : findings.length > 0 ? "WARN" : "PASS";
        return jsonResult({ ok: verdict !== "BLOCK", verdict, summary, findings_count: findings.length, findings: findings.slice(0, 100), p1, p2: findings.filter((f) => f.priority === "P2").length, p3: findings.filter((f) => f.priority === "P3").length });
      }
    );

    reg(
      mcp,
      "security_scan",
      {
        title: "Security scan",
        description: "Scan changed (or all, capped) files for secret patterns (AWS keys, private keys, API tokens, etc.) and unsafe usage. Reports file:line — never echoes the secret value.",
        inputSchema: {
          path: z.string().optional().describe("Dir to scan (default primary root)."),
          changed_only: z.boolean().optional().describe("Only scan files changed in git diff (default false)."),
          cwd: z.string().optional()
        }
      },
      async ({ path: rel = ".", changed_only = false, cwd = "." }) => {
        const rootDir = resolvePath(rel);
        const SECRET_PATTERNS = [
          { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
          { name: "Private Key", re: /-----BEGIN [A-Z ]* PRIVATE KEY-----/ },
          { name: "Generic API key", re: /['"](api[_-]?key|apikey|api_secret)['"]\s*[:=]\s*['"][^'"]{10,}['"]/i },
          { name: "Password assignment", re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
          { name: "Token assignment", re: /\b(token|access_token|auth_token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/i },
          { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z]{10,}/ },
          { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
          { name: "Generic secret", re: /\bsecret\s*[:=]\s*['"][^'"]{10,}['"]/i }
        ];

        let filesToScan = [];
        if (changed_only) {
          const diffRes = await spawnCapture("git", ["diff", "--name-only"], rootDir, DEFAULT_CMD_TIMEOUT);
          filesToScan = (diffRes.stdout || "").split(/\r?\n/).filter(Boolean).map((f) => path.join(rootDir, f));
        } else {
          const { files } = await buildTree(rootDir, 4, 500);
          filesToScan = files.filter((f) => {
            const ext = path.extname(f).toLowerCase();
            return [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".json", ".env", ".sh", ".yml", ".yaml"].includes(ext);
          });
        }

        const hits = [];
        for (const fp of filesToScan.slice(0, 300)) {
          let content;
          try { content = await readFile(fp, "utf8"); } catch { continue; }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            for (const pat of SECRET_PATTERNS) {
              if (pat.re.test(lines[i])) {
                hits.push({ file: toRel(fp), line: i + 1, pattern: pat.name });
                break;
              }
            }
            if (hits.length >= 100) break;
          }
          if (hits.length >= 100) break;
        }

        return jsonResult({ ok: hits.length === 0, scanned_files: filesToScan.length, hits_count: hits.length, hits });
      }
    );

    reg(
      mcp,
      "todo_scan",
      {
        title: "TODO scan",
        description: "Find all TODO/FIXME/HACK/XXX comments in the workspace. Returns file:line locations.",
        inputSchema: {
          path: z.string().optional(),
          limit: z.number().int().min(1).max(500).optional()
        }
      },
      async ({ path: rel = ".", limit = 200 }) => {
        const start = resolvePath(rel);
        let matches;
        if (RG_BIN) {
          matches = await ripgrepGrep(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
        }
        if (!matches) {
          matches = await searchTree(start, "TODO|FIXME|HACK|XXX", { regex: true, limit, glob: null });
        }
        const categorized = (matches || []).map((m) => {
          const kind = m.text.match(/\b(TODO|FIXME|HACK|XXX)\b/i)?.[1]?.toUpperCase() || "TODO";
          return { ...m, kind };
        });
        return jsonResult({ count: categorized.length, items: categorized });
      }
    );

    reg(
      mcp,
      "change_summary",
      {
        title: "Change summary",
        description: "Summarize git diff --stat and list changed files with a bullet summary.",
        inputSchema: {
          cwd: z.string().optional(),
          staged: z.boolean().optional()
        }
      },
      async ({ cwd = ".", staged = false }) => {
        const rootDir = resolvePath(cwd);
        const statArgs = ["diff", "--stat"];
        if (staged) statArgs.push("--staged");
        const statRes = await spawnCapture("git", statArgs, rootDir, DEFAULT_CMD_TIMEOUT);

        const nameArgs = ["diff", "--name-status"];
        if (staged) nameArgs.push("--staged");
        const nameRes = await spawnCapture("git", nameArgs, rootDir, DEFAULT_CMD_TIMEOUT);

        if (statRes.exit_code !== 0) {
          return jsonResult({ ok: false, error: "Not a git repo." });
        }

        const stat_output = (statRes.stdout || "").trim();
        const files = (nameRes.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
          const [status, ...parts] = line.split(/\t/);
          return { status: status.trim(), path: parts.join("\t").trim() };
        });

        return jsonResult({ ok: true, stat: stat_output, files_changed: files.length, files: files.slice(0, 100) });
      }
    );
  }


  return registerReviewTools;
}
