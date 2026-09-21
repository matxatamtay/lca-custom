import { firstText } from "./runtime-utils.mjs";

export function createAgentMemoryObservation(options) {
  const { getNextApplicationRuntime, isWithinRoots, log, PRIMARY_ROOT, resolvePath, ROOTS } = options;

  function scheduleAgentMemoryObservation(name, args, result, success, durationMs, outChars, errText) {
    const structured = result?.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : null;
    const task = name === "workspace_context" && typeof args?.task === "string" ? args.task.trim() : undefined;
    const evidence = Array.isArray(structured?.evidence) ? structured.evidence : [];
    const coverage = structured?.coverage && typeof structured.coverage === "object" ? structured.coverage : undefined;
    const observation = {
      tool: name,
      root: inferObservationRoot(args),
      argsSummary: memorySafeArgsSummary(args),
      outputSummary: name === "workspace_context"
        ? firstText(result).slice(0, 500)
        : `${success ? "success" : "failed"}; output_chars=${outChars}${errText ? `; error=${errText}` : ""}`,
      success,
      durationMs,
      ...(task ? { task } : {}),
      ...(coverage ? { coverage } : {}),
      ...(evidence.length ? { evidenceCount: evidence.length } : {}),
      files: collectObservationFiles(args)
    };
    const decision = extractAgentMemoryDecision(name, args, success, observation.root);
    void getNextApplicationRuntime()
      .then(async (runtime) => {
        const operations = [
          runtime.memorySessions.recordToolCall(observation)
        ];
        if (decision) operations.push(runtime.memorySessions.recordDecision(decision));
        const results = await Promise.allSettled(operations);
        for (const result of results) {
          if (result.status === "rejected") {
            log(`AgentMemory persistence failed for ${name}: ${result.reason?.message || result.reason}`);
          }
        }
      })
      .catch((error) => log(`AgentMemory persistence failed for ${name}: ${error?.message || error}`));
  }

  function extractAgentMemoryDecision(name, args, success, root) {
    if (!success || name !== "workspace_edit" || args?.action !== "decision") return null;
    const forwarded = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
    const decision = typeof forwarded.decision === "string" ? forwarded.decision.trim() : "";
    const why = typeof forwarded.why === "string" ? forwarded.why.trim() : "";
    if (!decision || !why) return null;
    return { root, decision, why };
  }

  function inferObservationRoot(args) {
    const nested = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
    const candidates = [args?.root, args?.path, args?.cwd, nested.root, nested.path, nested.cwd];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      try {
        const resolved = resolvePath(candidate);
        return ROOTS.find((root) => isWithinRoots(resolved, [root])) || PRIMARY_ROOT;
      } catch {
        // Ignore optional path-like arguments that are not workspace paths.
      }
    }
    return PRIMARY_ROOT;
  }

  function memorySafeArgsSummary(args) {
    const nested = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
    const summary = {};
    for (const [key, value] of Object.entries({
      action: args?.action,
      task: args?.task,
      intent: args?.intent,
      path: args?.path,
      cwd: args?.cwd,
      nested_action: nested.action,
      nested_path: nested.path,
      nested_cwd: nested.cwd
    })) {
      if (typeof value === "string" && value.trim()) summary[key] = value.slice(0, 500);
    }
    if (Array.isArray(args?.changed_files)) summary.changed_files = args.changed_files.filter((value) => typeof value === "string").slice(0, 50);
    return JSON.stringify(summary);
  }

  function collectObservationFiles(args) {
    const files = new Set();
    const nested = args?.arguments && typeof args.arguments === "object" ? args.arguments : {};
    const add = (value) => {
      if (typeof value === "string" && value.trim()) files.add(value.trim());
    };
    add(args?.path);
    add(args?.cwd);
    add(nested.path);
    add(nested.cwd);
    for (const value of args?.changed_files || []) add(value);
    return [...files].slice(0, 50);
  }


  return scheduleAgentMemoryObservation;
}
