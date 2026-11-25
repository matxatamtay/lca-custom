import { z } from "zod";

export function createGitToolRegistrar(options) {
  const { reg, jsonResult, resolvePath, parsePorcelain, spawnCapture, DEFAULT_CMD_TIMEOUT, worktreeCore } = options;

  function registerGitTool(mcp) {
    reg(
      mcp,
      "git",
      {
        title: "Git",
        description: "Run a git command. Pass args as an array, e.g. [\"status\",\"--short\"].",
        inputSchema: {
          args: z.array(z.string()).min(1).describe('Git arguments, e.g. ["log","--oneline","-n","10"].'),
          cwd: z.string().optional().describe("Project-relative or absolute repository directory.")
        }
      },
      async ({ args, cwd = "." }) => {
        const workdir = resolvePath(cwd);
        const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
        return jsonResult({ cwd: workdir, args, ...result });
      }
    );

    reg(
      mcp,
      "git_status",
      {
        title: "Git status",
        description: "Parsed working-tree status (git status --porcelain) for a project-relative or absolute repository. Returns a structured list of changed files with their index/worktree codes.",
        inputSchema: {
          cwd: z.string().optional().describe("Project-relative or absolute repository directory (default the primary project).")
        }
      },
      async ({ cwd = "." }) => {
        const workdir = resolvePath(cwd);
        const result = await spawnCapture("git", ["status", "--porcelain"], workdir, DEFAULT_CMD_TIMEOUT);
        if (result.exit_code !== 0) {
          // Not a git repo (or git error) — don't pretend it's "clean".
          return jsonResult({
            cwd: workdir,
            is_git_repo: false,
            clean: null,
            error: (result.stderr || "git error").split(/\r?\n/)[0]
          });
        }
        const branchRes = await spawnCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], workdir, DEFAULT_CMD_TIMEOUT);
        const files = parsePorcelain(result.stdout || "");
        return jsonResult({
          cwd: workdir,
          is_git_repo: true,
          branch: (branchRes.stdout || "").trim() || null,
          clean: files.length === 0,
          count: files.length,
          files
        });
      }
    );

    reg(
      mcp,
      "worktree_create",
      {
        title: "Create isolated task worktree",
        description: "Create a TaskExecutionTarget for parallel work. If parallel_with_cwd resolves to a different git repository, returns the direct repo root without creating a worktree. If both tasks target the same repo, creates an LCA-managed isolated worktree.",
        inputSchema: {
          cwd: z.string().optional().describe("Repository or subdirectory for this task."),
          task_id: z.string().min(1),
          parallel_with_cwd: z.string().optional().describe("Repository/subdirectory used by the parallel task. Same repo triggers worktree isolation."),
          base_ref: z.string().optional().describe("Commit-ish to branch from. Default HEAD."),
          branch: z.string().optional().describe("Optional LCA branch name. Must start with lca/.")
        }
      },
      async ({ cwd = ".", task_id, parallel_with_cwd, base_ref = "HEAD", branch }) => {
        const workdir = resolvePath(cwd);
        const parallel = parallel_with_cwd ? resolvePath(parallel_with_cwd) : undefined;
        return jsonResult(await worktreeCore.createTarget({
          cwd: workdir,
          taskId: task_id,
          parallelWithCwd: parallel,
          baseRef: base_ref,
          branch
        }));
      }
    );

    reg(
      mcp,
      "worktree_status",
      {
        title: "LCA worktree status",
        description: "List LCA-managed worktrees for a repository, optionally filtered by task_id, including dirty state.",
        inputSchema: {
          cwd: z.string().optional(),
          task_id: z.string().optional()
        }
      },
      async ({ cwd = ".", task_id }) => jsonResult(await worktreeCore.status({ cwd: resolvePath(cwd), taskId: task_id }))
    );

    reg(
      mcp,
      "worktree_diff",
      {
        title: "LCA worktree diff",
        description: "Return working, staged, and optional branch-vs-base diffs for one LCA-managed task worktree. Does not merge.",
        inputSchema: {
          cwd: z.string().optional(),
          task_id: z.string().min(1),
          against: z.string().optional()
        }
      },
      async ({ cwd = ".", task_id, against }) => jsonResult(await worktreeCore.diff({ cwd: resolvePath(cwd), taskId: task_id, against }))
    );

    reg(
      mcp,
      "worktree_check",
      {
        title: "Check LCA worktree",
        description: "Check dirty state, whitespace errors, and optional ahead/behind divergence for one task worktree. Never performs a merge.",
        inputSchema: {
          cwd: z.string().optional(),
          task_id: z.string().min(1),
          against: z.string().optional()
        }
      },
      async ({ cwd = ".", task_id, against }) => jsonResult(await worktreeCore.check({ cwd: resolvePath(cwd), taskId: task_id, against }))
    );

    reg(
      mcp,
      "worktree_gc",
      {
        title: "Garbage-collect stale LCA worktrees",
        description: "Remove stale LCA-managed worktrees only. Clean stale worktrees may be removed; dirty stale worktrees are protected unless force=true. Never deletes branches or merges changes.",
        inputSchema: {
          cwd: z.string().optional(),
          max_age_days: z.number().int().min(1).max(3650).optional(),
          force: z.boolean().optional(),
          dry_run: z.boolean().optional()
        }
      },
      async ({ cwd = ".", max_age_days = 14, force = false, dry_run = false }) => jsonResult(await worktreeCore.gc({
        cwd: resolvePath(cwd),
        maxAgeMs: max_age_days * 24 * 60 * 60_000,
        force,
        dryRun: dry_run
      }))
    );

    reg(
      mcp,
      "worktree_cleanup",
      {
        title: "Cleanup LCA worktree",
        description: "Remove one LCA-managed task worktree. Dirty worktrees are refused unless force=true. Branch deletion is opt-in and never merges changes.",
        inputSchema: {
          cwd: z.string().optional(),
          task_id: z.string().min(1),
          force: z.boolean().optional(),
          delete_branch: z.boolean().optional()
        }
      },
      async ({ cwd = ".", task_id, force = false, delete_branch = false }) => jsonResult(await worktreeCore.cleanup({
        cwd: resolvePath(cwd),
        taskId: task_id,
        force,
        deleteBranch: delete_branch
      }))
    );

    reg(
      mcp,
      "git_diff",
      {
        title: "Git diff",
        description: "Show a git diff for a project-relative or absolute repository. Optionally limit to a path; pass staged:true to diff the index against HEAD.",
        inputSchema: {
          path: z.string().optional().describe("Limit the diff to this file or directory."),
          staged: z.boolean().optional().describe("Diff staged changes (--staged) instead of the working tree."),
          cwd: z.string().optional().describe("Project-relative or absolute repository directory (default the primary project).")
        }
      },
      async ({ path: rel, staged = false, cwd = "." }) => {
        const workdir = resolvePath(cwd);
        const args = ["diff"];
        if (staged) args.push("--staged");
        if (rel) {
          // Confine the diff path to a root as well.
          const target = resolvePath(rel);
          args.push("--", target);
        }
        const result = await spawnCapture("git", args, workdir, DEFAULT_CMD_TIMEOUT);
        if (result.exit_code !== 0) {
          return jsonResult({
            cwd: workdir,
            is_git_repo: false,
            error: (result.stderr || "git error").split(/\r?\n/)[0]
          });
        }
        return jsonResult({
          cwd: workdir,
          is_git_repo: true,
          staged,
          path: rel || null,
          diff: result.stdout || "",
          empty: !(result.stdout || "").trim()
        });
      }
    );
  }

  // Parse `git status --porcelain` into structured entries. Each line is
  // "XY <path>" (or "XY <old> -> <new>" for renames) where X is the index code
  // and Y the worktree code.

  return registerGitTool;
}
