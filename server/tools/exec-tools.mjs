import { z } from "zod";
import { isReusableDeterministicCommand, runCommandDag } from "../core/exec-accelerator.mjs";

export function createExecToolRegistrar(options) {
  const {
    reg, jsonResult, resolvePath, defaultShell, runShellCommand, execAccelerator,
    trimOutput, secretVault, CMD_OUTPUT_DEFAULT, DEFAULT_CMD_TIMEOUT, MAX_COMMAND_OUTPUT
  } = options;

  const secretRefSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/);
  const secretEnvSchema = z.record(secretRefSchema).optional().describe(
    "Map ENV_VAR -> secret ref loaded by secret_prompt. Raw secret values must not be placed in the command."
  );

  const commandSchema = z.object({
    id: z.string().min(1).max(80).optional().describe("Optional DAG node id. Defaults to cmd-N."),
    depends_on: z.array(z.string().min(1).max(80)).max(12).optional().describe("Optional DAG dependencies by id."),
    command: z.string().min(1),
    cwd: z.string().optional(),
    shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
    timeout_ms: z.number().int().min(1000).max(600000).optional(),
    max_output_chars: z.number().int().min(500).max(50_000).optional(),
    secret_env: secretEnvSchema,
    secret_stdin_ref: secretRefSchema.optional().describe("Optional secret ref written to stdin. The secret is never returned in tool output."),
    reuse: z.enum(["auto", "never"]).optional().describe("Auto only reuses allowlisted analysis-only commands for an identical repo revision.")
  });

  async function executeOne(item, index, { tail_lines, head_lines, defaultMaxChars = 10_000 } = {}) {
    const workdir = resolvePath(item.cwd || ".");
    const startedMs = performance.now();
    const secretEnv = {};
    const secretValues = [];
    for (const [envName, ref] of Object.entries(item.secret_env || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(`Invalid secret env name: ${envName}`);
      const value = secretVault.resolve(ref);
      secretEnv[envName] = value;
      secretValues.push(value);
    }
    const secretStdin = item.secret_stdin_ref ? secretVault.resolve(item.secret_stdin_ref) : undefined;
    if (secretStdin !== undefined) secretValues.push(secretStdin);
    const result = await runShellCommand(
      item.command,
      workdir,
      item.shell,
      item.timeout_ms || DEFAULT_CMD_TIMEOUT,
      {
        reuse: item.reuse || "auto",
        env: secretEnv,
        stdin: secretStdin,
        redactValues: secretValues
      }
    );
    const maxChars = item.max_output_chars || defaultMaxChars;
    const stdout = trimOutput(result.stdout || "", { tail_lines, head_lines, max_chars: maxChars });
    const stderr = trimOutput(result.stderr || "", { tail_lines, head_lines, max_chars: maxChars });
    return {
      index,
      ...(item.id ? { id: item.id } : {}),
      cwd: workdir,
      command: item.command,
      shell: item.shell || defaultShell(),
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: Math.round((performance.now() - startedMs) * 10) / 10,
      stdout_truncated: stdout.length < String(result.stdout || "").length,
      stderr_truncated: stderr.length < String(result.stderr || "").length,
      stdout,
      stderr,
      secret_refs_used: {
        env: Object.entries(item.secret_env || {}).map(([name, ref]) => ({ name, ref })),
        stdin: item.secret_stdin_ref || null
      },
      ...(result.acceleration ? { acceleration: result.acceleration } : {})
    };
  }

  async function warmEligible(commands) {
    if (!execAccelerator?.warm) return;
    const roots = new Set();
    for (const item of commands) {
      if (Object.keys(item.secret_env || {}).length || item.secret_stdin_ref) continue;
      if ((item.reuse || "auto") === "never" || !isReusableDeterministicCommand(item.command)) continue;
      try { roots.add(resolvePath(item.cwd || ".")); } catch { /* execution will report routing failure later */ }
    }
    await Promise.allSettled([...roots].map((root) => execAccelerator.warm(root)));
  }

  function registerExecTools(mcp) {
    reg(
      mcp,
      "secret_prompt",
      {
        title: "Prompt for local secret",
        description: "Open a local hidden-input prompt and keep the secret only in LCA process memory. Returns only a reference; the secret is never returned to ChatGPT, audit logs, or shell history.",
        inputSchema: {
          ref: secretRefSchema,
          label: z.string().min(1).max(200).optional(),
          ttl_ms: z.number().int().min(60_000).max(86_400_000).optional()
        }
      },
      async (input) => jsonResult(await secretVault.prompt(input))
    );

    reg(
      mcp,
      "secret_status",
      {
        title: "List loaded secret refs",
        description: "List only secret references and metadata; never secret values.",
        inputSchema: {}
      },
      async () => jsonResult(secretVault.status())
    );

    reg(
      mcp,
      "secret_forget",
      {
        title: "Forget local secret",
        description: "Remove one in-memory secret reference.",
        inputSchema: { ref: secretRefSchema }
      },
      async ({ ref }) => jsonResult(secretVault.forget(ref))
    );

    reg(
      mcp,
      "run_command",
      {
        title: "Run command",
        description: "Run a command and wait for it to finish. Analysis-only deterministic commands may reuse a successful result for the identical Git revision; pass reuse=never to force execution. Setup/install commands only dedupe while concurrently in flight.",
        inputSchema: {
          command: z.string().min(1),
          cwd: z.string().optional().describe("Project-relative or absolute working directory."),
          shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional().describe("Shell to use (default cmd on Windows, bash/sh on macOS/Linux)."),
          timeout_ms: z.number().int().min(1000).max(600000).optional(),
          tail_lines: z.number().int().min(1).max(5000).optional().describe("Return only the last N lines of output."),
          head_lines: z.number().int().min(1).max(5000).optional().describe("Return only the first N lines of output."),
          max_output_chars: z.number().int().min(500).max(MAX_COMMAND_OUTPUT).optional().describe(`Cap stdout/stderr chars (default ${CMD_OUTPUT_DEFAULT}).`),
          secret_env: secretEnvSchema,
          secret_stdin_ref: secretRefSchema.optional().describe("Optional secret ref written to stdin."),
          reuse: z.enum(["auto", "never"]).optional().describe("Default auto. Only allowlisted analysis-only commands can be reused; arbitrary shell commands always execute.")
        }
      },
      async ({ command, cwd = ".", shell, timeout_ms = DEFAULT_CMD_TIMEOUT, tail_lines, head_lines, max_output_chars = CMD_OUTPUT_DEFAULT, secret_env, secret_stdin_ref, reuse = "auto" }) => {
        await warmEligible([{ command, cwd, reuse, secret_env, secret_stdin_ref }]);
        const result = await executeOne(
          { command, cwd, shell, timeout_ms, max_output_chars, secret_env, secret_stdin_ref, reuse },
          0,
          { tail_lines, head_lines, defaultMaxChars: max_output_chars }
        );
        const { index: _index, ...single } = result;
        return jsonResult(single);
      }
    );

    reg(
      mcp,
      "run_commands",
      {
        title: "Run command batch / DAG",
        description: "Run up to 12 bounded commands in one MCP call. Use parallel=true for independent checks, or id+depends_on for a dependency DAG. Analysis-only deterministic commands can safely reuse identical-revision successes; arbitrary test/build/shell commands never do.",
        inputSchema: {
          commands: z.array(commandSchema).min(1).max(12),
          parallel: z.boolean().optional().describe("Run independent commands concurrently when no DAG dependencies are present."),
          max_concurrency: z.number().int().min(1).max(4).optional(),
          stop_on_failure: z.boolean().optional().describe("Sequential/DAG mode only; default true.")
        }
      },
      async ({ commands, parallel = false, max_concurrency = 4, stop_on_failure = true }) => {
        await warmEligible(commands);
        const hasDag = commands.some((item) => (item.depends_on || []).length > 0);
        let results;

        if (hasDag) {
          const nodes = commands.map((item, index) => ({ ...item, id: item.id || `cmd-${index}`, depends_on: item.depends_on || [] }));
          const dagResults = await runCommandDag(
            nodes,
            (node, index) => executeOne(node, index),
            { maxConcurrency: max_concurrency, stopOnFailure: stop_on_failure }
          );
          results = dagResults.map((result, index) => {
            if (!result?.skipped) return result;
            const node = nodes[index];
            return {
              index,
              id: node.id,
              cwd: resolvePath(node.cwd || "."),
              command: node.command,
              shell: node.shell || defaultShell(),
              exit_code: null,
              timed_out: false,
              skipped: true,
              skip_reason: result.skip_reason,
              stdout_truncated: false,
              stderr_truncated: false,
              stdout: "",
              stderr: ""
            };
          });
        } else if (parallel) {
          results = new Array(commands.length);
          let cursor = 0;
          const worker = async () => {
            while (true) {
              const index = cursor++;
              if (index >= commands.length) return;
              results[index] = await executeOne(commands[index], index);
            }
          };
          await Promise.all(Array.from({ length: Math.min(max_concurrency, commands.length) }, () => worker()));
        } else {
          results = [];
          for (let index = 0; index < commands.length; index += 1) {
            const result = await executeOne(commands[index], index);
            results.push(result);
            if (stop_on_failure && result.exit_code !== 0) break;
          }
        }

        const completed = results.filter(Boolean);
        const executed = completed.filter((result) => !result.skipped);
        return jsonResult({
          ok: completed.length === commands.length && executed.every((result) => result.exit_code === 0) && completed.every((result) => !result.skipped || result.skip_reason === "dependency_failed"),
          parallel: hasDag ? true : parallel,
          dag: hasDag,
          requested: commands.length,
          completed: completed.length,
          executed: executed.length,
          skipped: completed.filter((result) => result.skipped).length,
          stopped_early: completed.length < commands.length,
          results: completed
        });
      }
    );
  }

  return registerExecTools;
}
