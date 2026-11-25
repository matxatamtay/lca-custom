import { z } from "zod";

export function createProcessToolRegistrar(options) {
  const { reg, jsonResult, resolvePath, killProcessTree, startBackground, processes, MAX_PROCS, PROC_BUFFER } = options;

  function registerProcessTools(mcp) {
    reg(
      mcp,
      "proc_start",
      {
        title: "Start background process",
        description: "Start a long-running process (dev server, watcher). Returns an id to poll.",
        inputSchema: {
          command: z.string().min(1),
          cwd: z.string().optional(),
          shell: z.enum(["cmd", "powershell", "bash", "sh", "zsh"]).optional(),
          name: z.string().optional()
        }
      },
      async ({ command, cwd = ".", shell, name }) => {
        const running = [...processes.values()].filter((p) => p.status === "running").length;
        if (running >= MAX_PROCS) throw new Error(`Too many running processes (max ${MAX_PROCS}). Stop some first.`);
        const workdir = resolvePath(cwd);
        const proc = startBackground(command, workdir, shell, name);
        return jsonResult({ ok: true, id: proc.id, name: proc.name, command, cwd: workdir, pid: proc.child.pid });
      }
    );

    reg(
      mcp,
      "proc_list",
      {
        title: "List background processes",
        description: "List background processes started by this agent.",
        inputSchema: {}
      },
      async () =>
        jsonResult({
          processes: [...processes.values()].map((p) => ({
            id: p.id,
            name: p.name,
            command: p.command,
            status: p.status,
            exit_code: p.exitCode,
            pid: p.child?.pid,
            started_at: p.startedAt
          }))
        })
    );

    reg(
      mcp,
      "proc_output",
      {
        title: "Read process output",
        description: "Return buffered stdout/stderr of a background process.",
        inputSchema: { id: z.string().min(1), tail_chars: z.number().int().min(1).max(PROC_BUFFER).optional() }
      },
      async ({ id, tail_chars }) => {
        const proc = processes.get(id);
        if (!proc) throw new Error(`No process with id ${id}`);
        const tail = (s) => (tail_chars && s.length > tail_chars ? s.slice(-tail_chars) : s);
        return jsonResult({
          id,
          status: proc.status,
          exit_code: proc.exitCode,
          stdout: tail(proc.stdout),
          stderr: tail(proc.stderr)
        });
      }
    );

    reg(
      mcp,
      "proc_stop",
      {
        title: "Stop background process",
        description: "Terminate a background process (and its child tree).",
        inputSchema: { id: z.string().min(1) }
      },
      async ({ id }) => {
        const proc = processes.get(id);
        if (!proc) throw new Error(`No process with id ${id}`);
        killProcessTree(proc);
        return jsonResult({ ok: true, id, status: proc.status });
      }
    );
  }


  return registerProcessTools;
}
