import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./file-state.mjs";

const VERSION = 1;
const DEFAULT_MAX_SAMPLES = 30_000;

export function classifyCommandFamily(command) {
  const text = String(command || "").trim().replace(/\s+/g, " ");
  if (!text) return "unknown";
  const rules = [
    [/^npm\s+run\s+(typecheck|type-check|type:check)\b/i, "npm:typecheck"],
    [/^npm\s+(?:test|run\s+test)\b/i, "npm:test"],
    [/^npm\s+run\s+lint\b/i, "npm:lint"],
    [/^npm\s+run\s+build\b/i, "npm:build"],
    [/^(?:pnpm|yarn)\b.*\b(typecheck|type-check|type:check)\b/i, "js:typecheck"],
    [/^(?:pnpm|yarn)\b.*\btest\b/i, "js:test"],
    [/^npx\s+tsc\b/i, "tsc"],
    [/^flutter\s+analyze\b/i, "flutter:analyze"],
    [/^flutter\s+test\b/i, "flutter:test"],
    [/^flutter\s+build\b/i, "flutter:build"],
    [/^(?:flutter|dart)\s+pub\s+get\b/i, "dart:pub-get"],
    [/^dart\s+analyze\b/i, "dart:analyze"],
    [/^dart\s+test\b/i, "dart:test"],
    [/^(?:\.\/)?gradlew?\b.*\btest\b/i, "gradle:test"],
    [/^(?:\.\/)?gradlew?\b.*\b(?:assemble|build)\b/i, "gradle:build"],
    [/^mvn\b.*\btest\b/i, "maven:test"],
    [/^mvn\b.*\b(?:package|verify|install)\b/i, "maven:build"],
    [/^python(?:3)?\s+-m\s+pytest\b|^pytest\b/i, "python:test"],
    [/^python(?:3)?\s+-m\s+(?:mypy|pyright)\b|^(?:mypy|pyright)\b/i, "python:typecheck"],
    [/^go\s+test\b/i, "go:test"],
    [/^go\s+build\b/i, "go:build"],
    [/^cargo\s+test\b/i, "rust:test"],
    [/^cargo\s+(?:build|check)\b/i, "rust:build-check"],
    [/^git\b/i, "git"],
    [/^(?:npm\s+(?:install|ci)|pnpm\s+install|yarn\s+install)\b/i, "js:install"]
  ];
  for (const [pattern, family] of rules) if (pattern.test(text)) return family;
  const first = text.match(/^([A-Za-z0-9._/-]+)/)?.[1];
  if (!first) return "other";
  const executable = path.basename(first).toLowerCase().replace(/\.exe$/, "");
  return `other:${executable.slice(0, 32)}`;
}

export function createPerformanceFollow(options = {}) {
  const {
    filePath = null,
    now = () => Date.now(),
    maxSamples = DEFAULT_MAX_SAMPLES
  } = options;
  const state = { version: VERSION, samples: [], last_error: null, sequence: 0 };
  let flushTimer = null;
  let flushPromise = null;

  async function load() {
    if (!filePath) return report();
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      state.samples = Array.isArray(parsed?.samples) ? parsed.samples.slice(-maxSamples) : [];
      state.sequence = state.samples.reduce((max, sample) => Math.max(max, Number(sample?.seq || 0)), 0);
      state.last_error = null;
    } catch (error) {
      if (error?.code !== "ENOENT") state.last_error = String(error?.message || error).slice(0, 1000);
    }
    return report();
  }

  function recordToolCall(input = {}) {
    const timestamp = now();
    const root = safeText(input.root, 500);
    const trace = input.trace || {};
    const base = {
      seq: nextSequence(),
      ts: timestamp,
      task_id: safeText(trace.task_id || input.taskId, 100),
      correlation_id: safeText(trace.correlation_id || input.correlationId, 200),
      trace_id: safeText(trace.trace_id || input.traceId, 64),
      task_class: normalizeTaskClass(trace.task_class || input.taskClass),
      root,
      context_temperature: normalizeTemperature(trace.context_temperature),
      success: input.success !== false
    };
    const structured = extractStructured(input.result);
    const cache = cacheFields(structured);
    const projectRoot = safeText(structured?.project_resolution?.active_project_root, 500);
    if (projectRoot) base.project_root = projectRoot;
    const prewarm = input.tool === "workspace_context" ? latestPrewarm(root, projectRoot, timestamp) : null;
    append({
      ...base,
      kind: "tool",
      name: safeText(input.action ? `${input.tool}:${input.action}` : input.tool, 120),
      duration_ms: round(input.durationMs),
      in_chars: boundedNumber(input.inChars),
      out_bytes: boundedNumber(input.outBytes),
      ...cache,
      ...(prewarm ? { prewarm_age_ms: Math.max(0, timestamp - prewarm.ts), prewarm_recent: timestamp - prewarm.ts <= 10 * 60_000 } : {})
    });

    if (input.tool === "workspace_verify" && (input.action === "semgrep" || input.action === "semgrep_scan")) {
      const semgrepSummary = structured?.summary || {};
      append({
        ...base,
        seq: nextSequence(),
        kind: "sensor",
        name: "semgrep",
        duration_ms: round(input.durationMs),
        available: structured?.available !== false,
        success: structured?.available === false ? true : structured?.ok !== false,
        findings: boundedNumber(semgrepSummary.findings),
        error_findings: boundedNumber(semgrepSummary.error),
        warning_findings: boundedNumber(semgrepSummary.warning),
        info_findings: boundedNumber(semgrepSummary.info)
      });
    }

    if (input.tool === "workspace_verify" && (input.action === "mutation" || input.action === "mutation_test")) {
      const mutation = structured?.telemetry || {};
      append({
        ...base,
        seq: nextSequence(),
        kind: "sensor",
        name: "mutation",
        duration_ms: round(input.durationMs),
        available: structured?.available !== false,
        success: structured?.available === false ? true : structured?.ok !== false,
        mode: safeText(structured?.mode, 20),
        mutants_total: boundedNumber(mutation.mutants_total),
        killed: boundedNumber(mutation.killed),
        survived: boundedNumber(mutation.survived),
        timeout_mutants: boundedNumber(mutation.timeout),
        no_coverage: boundedNumber(mutation.no_coverage),
        mutation_score: Number.isFinite(Number(mutation.mutation_score))
          ? round(Number(mutation.mutation_score))
          : null
      });
    }

    if (input.tool === "workspace_context") {
      for (const [provider, value] of Object.entries(structured?.coverage || {})) {
        const providerEvidence = (structured?.evidence || []).filter((item) => item?.provider === provider);
        append({
          ...base,
          seq: nextSequence(),
          kind: "provider",
          name: safeText(provider, 60),
          duration_ms: round(value?.latencyMs || 0),
          hits: boundedNumber(value?.hits),
          success: value?.status !== "error",
          ...cacheFields(providerEvidence),
          ...(value?.details && typeof value.details === "object" ? { details: sanitizeDetails(value.details) } : {})
        });
      }
      const ranking = structured?.ranking;
      if (ranking && typeof ranking === "object") {
        append({
          ...base,
          seq: nextSequence(),
          kind: "ranking",
          name: safeText(`${ranking.provider || "rule"}:${ranking.status || "unknown"}`, 60),
          duration_ms: round(ranking.latencyMs || 0),
          model: safeText(ranking.model, 80),
          candidates: boundedNumber(ranking.candidates),
          accepted: boundedNumber(ranking.accepted),
          candidate_cap: boundedNumber(ranking.candidateCap),
          state_chars: boundedNumber(ranking.stateChars),
          pruned: boundedNumber(ranking.pruned),
          sufficiency: ["insufficient", "partial", "sufficient"].includes(ranking.sufficiency) ? ranking.sufficiency : null,
          sufficiency_confidence: round(ranking.sufficiencyConfidence || 0),
          fallback_reason: safeText(ranking.fallbackReason, 80)
        });
      }
    }

    for (const command of collectTimedCommands(structured)) {
      append({
        ...base,
        seq: nextSequence(),
        kind: "command",
        name: classifyCommandFamily(command.command),
        duration_ms: round(command.duration_ms),
        success: command.exit_code === 0 || command.ok === true,
        cache_hit: command.acceleration?.cache_hit === true || command.cached === true,
        reusable: command.acceleration?.reusable === true,
        timed_out: command.timed_out === true
      });
    }
    scheduleFlush();
  }

  function recordRuntimeSpans(input = {}) {
    const root = safeText(input.root, 500);
    const trace = input.trace || {};
    const spans = Array.isArray(input.spans) ? input.spans : [];
    if (!root || !trace.task_id || !spans.length) return { recorded: 0 };

    let recorded = 0;
    for (const span of spans.slice(0, 500)) {
      const name = safeText(span?.name, 160);
      if (!name) continue;
      const timestamp = Date.parse(span?.startedAt || "");
      append({
        seq: nextSequence(),
        ts: Number.isFinite(timestamp) ? timestamp : now(),
        task_id: safeText(trace.task_id, 100),
        correlation_id: safeText(trace.correlation_id || input.correlationId || span?.correlationId, 200),
        trace_id: safeText(trace.trace_id || input.traceId, 64),
        task_class: normalizeTaskClass(trace.task_class || input.taskClass),
        root,
        project_root: safeText(input.projectRoot, 500),
        context_temperature: normalizeTemperature(trace.context_temperature),
        success: span?.success !== false,
        kind: "span",
        name,
        duration_ms: round(span?.durationMs),
        span_id: safeText(span?.spanId, 200),
        parent_span_id: safeText(span?.parentSpanId, 200),
        surface: safeText(span?.surface, 30)
      });
      recorded += 1;
    }
    if (recorded) scheduleFlush();
    return { recorded };
  }

  function recordPrewarm(input = {}) {
    const root = safeText(input.root, 500);
    if (!root) return;
    append({
      seq: nextSequence(),
      ts: now(),
      task_id: "",
      task_class: "internal",
      root,
      project_root: safeText(input.projectRoot, 500),
      context_temperature: "unknown",
      success: input.success !== false,
      kind: "prewarm",
      name: safeText(input.name || "context", 80),
      duration_ms: round(input.durationMs),
      cache_hit: input.cacheHit === true,
      providers: sanitizePrewarmProviders(input.providers)
    });
    scheduleFlush();
  }

  function report({
    root = null,
    windowDays = 30,
    taskClass = "user",
    compact = false,
    taskId = null,
    latestTask = false,
    includeTimeline = false
  } = {}) {
    const cutoff = now() - Math.max(1, Math.min(3650, Number(windowDays) || 30)) * 24 * 60 * 60_000;
    const windowSamples = state.samples.filter((sample) => {
      if (Number(sample.ts || 0) < cutoff) return false;
      if (root && sample.root !== root) return false;
      return true;
    });
    const eligible = windowSamples.filter((sample) => {
      if (taskClass !== "all" && sample.task_class !== taskClass) return false;
      return true;
    });
    const latestTaskId = latestTaskIdFrom(eligible);
    const selectedTaskId = safeText(taskId, 100) || (latestTask ? latestTaskId : "");
    const samples = selectedTaskId
      ? eligible.filter((sample) => sample.task_id === selectedTaskId)
      : eligible;
    const tools = groupMetrics(samples.filter((sample) => sample.kind === "tool"));
    const commands = groupMetrics(samples.filter((sample) => sample.kind === "command"));
    const providers = groupMetrics(samples.filter((sample) => sample.kind === "provider"));
    const rankings = samples.filter((sample) => sample.kind === "ranking");
    const runtimeSpans = samples.filter((sample) => sample.kind === "span");
    const contextRuntimeSpans = runtimeSpans.filter((sample) => sample.name.startsWith("workspace_context."));
    const editRuntimeSpans = runtimeSpans.filter((sample) => sample.name.startsWith("workspace_edit."));
    const sensors = samples.filter((sample) => sample.kind === "sensor");
    const semgrepSensors = sensors.filter((sample) => sample.name === "semgrep");
    const mutationSensors = sensors.filter((sample) => sample.name === "mutation");
    const prewarms = windowSamples.filter((sample) => sample.kind === "prewarm");
    const tasks = new Set(samples.map((sample) => sample.task_id).filter(Boolean));
    const toolSamples = samples.filter((sample) => sample.kind === "tool");
    const contexts = toolSamples.filter((sample) => sample.name === "workspace_context");
    const searches = toolSamples.filter((sample) => sample.name.startsWith("workspace_search"));
    const reads = toolSamples.filter((sample) => sample.name.startsWith("workspace_read"));
    const verifications = toolSamples.filter((sample) => sample.name.startsWith("workspace_verify"));
    const testCommands = samples.filter((sample) => sample.kind === "command" && /(?:^|:)test$/.test(sample.name || ""));
    const codegraphProviders = samples.filter((sample) => sample.kind === "provider" && sample.name === "codegraph");
    const codegraphIndex = codegraphProviders
      .filter((sample) => Number.isFinite(Number(sample.details?.index_ms)))
      .map((sample) => ({ ...sample, duration_ms: Number(sample.details.index_ms) }));
    const codegraphQuery = codegraphProviders
      .filter((sample) => Number.isFinite(Number(sample.details?.query_ms)))
      .map((sample) => ({ ...sample, duration_ms: Number(sample.details.query_ms) }));
    const cacheSamples = samples.filter((sample) => typeof sample.cache_hit === "boolean" || Number(sample.cache_checks || 0) > 0);
    const cacheChecks = cacheSamples.reduce((sum, sample) => sum + (Number(sample.cache_checks || 0) || (typeof sample.cache_hit === "boolean" ? 1 : 0)), 0);
    const cacheHits = cacheSamples.reduce((sum, sample) => sum + (Number(sample.cache_hits || 0) || (sample.cache_hit === true ? 1 : 0)), 0);
    const classCounts = countBy(samples.filter((sample) => sample.kind === "tool"), (sample) => sample.task_class || "unknown");
    const temperatureCounts = countBy(contexts, (sample) => sample.context_temperature || "unknown");
    const bottlenecks = [
      ...tools.map((entry) => ({ category: "tool", ...entry })),
      ...commands.map((entry) => ({ category: "command", ...entry })),
      ...providers.map((entry) => ({ category: "provider", ...entry }))
    ].sort((left, right) => right.total_ms - left.total_ms || right.p95_ms - left.p95_ms).slice(0, compact ? 5 : 12);
    const oldest = samples.length ? Math.min(...samples.map((sample) => sample.ts)) : null;
    const newest = samples.length ? Math.max(...samples.map((sample) => sample.ts)) : null;

    return {
      version: VERSION,
      query: {
        root,
        window_days: windowDays,
        task_class: taskClass,
        ...(selectedTaskId ? { task_id: selectedTaskId } : {}),
        latest_task: Boolean(latestTask),
        include_timeline: Boolean(includeTimeline)
      },
      samples: samples.length,
      tasks: tasks.size,
      latest_task_id: latestTaskId || null,
      ...(selectedTaskId ? { task: taskSummary(samples, selectedTaskId) } : {}),
      task_classes: classCounts,
      context_temperature: temperatureCounts,
      context_ms: metrics(contexts),
      trace_attribution: {
        workspace_context: attributionSummary(contexts, contextRuntimeSpans, "workspace_context."),
        workspace_edit: attributionSummary(
          toolSamples.filter((sample) => sample.name.startsWith("workspace_edit")),
          editRuntimeSpans,
          "workspace_edit."
        )
      },
      cache_efficiency: {
        checks: cacheChecks,
        hits: cacheHits,
        hit_ratio: cacheChecks ? round(cacheHits / cacheChecks) : null
      },
      provider_cache: providerCacheSummary(samples),
      prewarm: prewarmSummary(contexts, prewarms),
      search_efficiency: {
        calls: searches.length,
        failures: searches.filter((sample) => sample.success === false).length,
        calls_per_task: tasks.size ? round(searches.length / tasks.size) : 0,
        by_action: Object.fromEntries(groupMetrics(searches).map(({ name, ...value }) => [
          name.startsWith("workspace_search:") ? name.slice("workspace_search:".length) : name,
          value
        ]))
      },
      workflow_efficiency: {
        tool_calls: toolSamples.length,
        roundtrips_per_task: tasks.size ? round(toolSamples.length / tasks.size) : 0,
        read_calls: reads.length,
        read_calls_per_task: tasks.size ? round(reads.length / tasks.size) : 0,
        bytes_to_model: toolSamples.reduce((sum, sample) => sum + Number(sample.out_bytes || 0), 0),
        bytes_to_model_per_task: tasks.size
          ? round(toolSamples.reduce((sum, sample) => sum + Number(sample.out_bytes || 0), 0) / tasks.size)
          : 0,
        failure_rate: toolSamples.length
          ? roundRatio(toolSamples.filter((sample) => sample.success === false).length / toolSamples.length)
          : 0
      },
      verification_ms: metrics(verifications),
      test_duration_ms: metrics(testCommands),
      codegraph: {
        index_ms: metrics(codegraphIndex),
        query_ms: metrics(codegraphQuery)
      },
      semgrep: {
        samples: semgrepSensors.length,
        available_samples: semgrepSensors.filter((sample) => sample.available !== false).length,
        unavailable_samples: semgrepSensors.filter((sample) => sample.available === false).length,
        gate_failures: semgrepSensors.filter((sample) => sample.available !== false && sample.success === false).length,
        findings: {
          error: semgrepSensors.reduce((sum, sample) => sum + Number(sample.error_findings || 0), 0),
          warning: semgrepSensors.reduce((sum, sample) => sum + Number(sample.warning_findings || 0), 0),
          info: semgrepSensors.reduce((sum, sample) => sum + Number(sample.info_findings || 0), 0),
          total: semgrepSensors.reduce((sum, sample) => sum + Number(sample.findings || 0), 0)
        },
        latency_ms: metrics(semgrepSensors)
      },
      mutation: {
        samples: mutationSensors.length,
        available_samples: mutationSensors.filter((sample) => sample.available !== false).length,
        unavailable_samples: mutationSensors.filter((sample) => sample.available === false).length,
        gate_failures: mutationSensors.filter((sample) => sample.available !== false && sample.success === false).length,
        modes: countBy(mutationSensors.filter((sample) => sample.mode), (sample) => sample.mode),
        mutants_total: mutationSensors.reduce((sum, sample) => sum + Number(sample.mutants_total || 0), 0),
        killed: mutationSensors.reduce((sum, sample) => sum + Number(sample.killed || 0), 0),
        survived: mutationSensors.reduce((sum, sample) => sum + Number(sample.survived || 0), 0),
        timeout: mutationSensors.reduce((sum, sample) => sum + Number(sample.timeout_mutants || 0), 0),
        no_coverage: mutationSensors.reduce((sum, sample) => sum + Number(sample.no_coverage || 0), 0),
        avg_score: mutationSensors.filter((sample) => Number.isFinite(Number(sample.mutation_score))).length
          ? round(mutationSensors
              .filter((sample) => Number.isFinite(Number(sample.mutation_score)))
              .reduce((sum, sample) => sum + Number(sample.mutation_score), 0)
              / mutationSensors.filter((sample) => Number.isFinite(Number(sample.mutation_score))).length)
          : null,
        latency_ms: metrics(mutationSensors)
      },
      jev: {
        samples: rankings.length,
        statuses: countBy(rankings, (sample) => sample.name || "unknown"),
        models: countBy(rankings.filter((sample) => sample.model), (sample) => sample.model),
        fallback_reasons: countBy(rankings.filter((sample) => sample.fallback_reason), (sample) => sample.fallback_reason),
        sufficiency: countBy(rankings.filter((sample) => sample.sufficiency), (sample) => sample.sufficiency),
        latency_ms: metrics(rankings),
        candidates: rankings.reduce((sum, sample) => sum + Number(sample.candidates || 0), 0),
        accepted: rankings.reduce((sum, sample) => sum + Number(sample.accepted || 0), 0),
        avg_candidate_cap: rankings.length
          ? round(rankings.reduce((sum, sample) => sum + Number(sample.candidate_cap || 0), 0) / rankings.length)
          : 0,
        avg_state_chars: rankings.length
          ? round(rankings.reduce((sum, sample) => sum + Number(sample.state_chars || 0), 0) / rankings.length)
          : 0,
        pruned: rankings.reduce((sum, sample) => sum + Number(sample.pruned || 0), 0),
        avg_sufficiency_confidence: rankings.length
          ? roundRatio(rankings.reduce((sum, sample) => sum + Number(sample.sufficiency_confidence || 0), 0) / rankings.length)
          : 0,
        acceptance_rate: rankings.reduce((sum, sample) => sum + Number(sample.candidates || 0), 0)
          ? roundRatio(rankings.reduce((sum, sample) => sum + Number(sample.accepted || 0), 0) / rankings.reduce((sum, sample) => sum + Number(sample.candidates || 0), 0))
          : null,
        avg_pruned: rankings.length
          ? round(rankings.reduce((sum, sample) => sum + Number(sample.pruned || 0), 0) / rankings.length)
          : 0
      },
      bottlenecks,
      tools: tools.slice(0, compact ? 5 : 20),
      commands: commands.slice(0, compact ? 5 : 20),
      providers: providers.slice(0, compact ? 4 : 10),
      ...(includeTimeline ? { timeline: buildTimeline(samples) } : {}),
      storage: {
        persisted: Boolean(filePath),
        retained_samples: state.samples.length,
        max_samples: maxSamples,
        oldest_ts: oldest,
        newest_ts: newest
      },
      ...(state.last_error ? { last_error: state.last_error } : {})
    };
  }

  async function flush() {
    if (!filePath) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFileAtomic(filePath, Buffer.from(`${JSON.stringify({ version: VERSION, samples: state.samples.slice(-maxSamples) }, null, 2)}\n`, "utf8"));
        state.last_error = null;
      } catch (error) {
        state.last_error = String(error?.message || error).slice(0, 1000);
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  }

  async function close() {
    await flush();
  }

  function reclassifyTasks(taskClasses) {
    const lookup = taskClasses instanceof Map
      ? Object.fromEntries(taskClasses)
      : taskClasses && typeof taskClasses === "object" ? taskClasses : {};
    let changed = 0;
    for (const sample of state.samples) {
      const next = lookup[sample.task_id];
      if (!next || sample.task_class === next) continue;
      sample.task_class = normalizeTaskClass(next);
      changed += 1;
    }
    if (changed) scheduleFlush();
    return changed;
  }

  function append(sample) {
    state.samples.push(sample);
    if (state.samples.length > maxSamples) state.samples.splice(0, state.samples.length - maxSamples);
  }

  function scheduleFlush() {
    if (!filePath || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 500);
    flushTimer.unref?.();
  }

  function latestPrewarm(root, projectRoot, timestamp) {
    for (let index = state.samples.length - 1; index >= 0; index -= 1) {
      const sample = state.samples[index];
      if (sample?.kind !== "prewarm" || sample.success === false || Number(sample.ts) > timestamp) continue;
      if (sample.root === root) {
        if (!projectRoot || !sample.project_root || sample.project_root === projectRoot) return sample;
      }
    }
    return null;
  }

  function nextSequence() {
    state.sequence += 1;
    return state.sequence;
  }

  return { load, recordToolCall, recordRuntimeSpans, recordPrewarm, report, reclassifyTasks, flush, close };
}

function latestTaskIdFrom(samples) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const taskId = safeText(samples[index]?.task_id, 100);
    if (taskId) return taskId;
  }
  return "";
}

function taskSummary(samples, taskId) {
  const tools = samples.filter((sample) => sample.kind === "tool");
  const started = samples.length ? Math.min(...samples.map((sample) => Number(sample.ts || 0))) : 0;
  const ended = tools.length
    ? Math.max(...tools.map((sample) => Number(sample.ts || 0) + Number(sample.duration_ms || 0)))
    : started;
  const identitySample = samples.find((sample) => sample.correlation_id || sample.trace_id) || {};
  return {
    task_id: taskId,
    correlation_id: identitySample.correlation_id || null,
    trace_id: identitySample.trace_id || null,
    observed_wall_ms: round(Math.max(0, ended - started)),
    observed_tool_ms: round(tools.reduce((sum, sample) => sum + Number(sample.duration_ms || 0), 0)),
    tool_calls: tools.length,
    failures: tools.filter((sample) => sample.success === false).length,
    bytes_to_model: tools.reduce((sum, sample) => sum + Number(sample.out_bytes || 0), 0)
  };
}

function buildTimeline(samples) {
  if (!samples.length) return [];
  const start = Math.min(...samples.map((sample) => Number(sample.ts || 0)));
  return [...samples]
    .sort((left, right) => Number(left.ts || 0) - Number(right.ts || 0) || Number(left.seq || 0) - Number(right.seq || 0))
    .slice(0, 300)
    .map((sample) => ({
      offset_ms: Math.max(0, Number(sample.ts || 0) - start),
      kind: sample.kind,
      name: sample.name,
      duration_ms: round(sample.duration_ms || 0),
      success: sample.success !== false,
      ...(sample.correlation_id ? { correlation_id: sample.correlation_id } : {}),
      ...(sample.trace_id ? { trace_id: sample.trace_id } : {}),
      ...(sample.kind === "span" ? {
        span_id: sample.span_id || null,
        parent_span_id: sample.parent_span_id || null,
        surface: sample.surface || null
      } : {}),
      ...(sample.kind === "provider" && sample.details ? { details: sample.details } : {}),
      ...(sample.kind === "ranking" ? {
        model: sample.model || null,
        candidates: sample.candidates || 0,
        accepted: sample.accepted || 0,
        candidate_cap: sample.candidate_cap || 0,
        state_chars: sample.state_chars || 0,
        pruned: sample.pruned || 0,
        sufficiency: sample.sufficiency || null,
        sufficiency_confidence: sample.sufficiency_confidence || 0,
        fallback_reason: sample.fallback_reason || ""
      } : {}),
      ...(sample.prewarm_age_ms !== undefined ? { prewarm_age_ms: sample.prewarm_age_ms } : {})
    }));
}

function attributionSummary(parentSamples, spanSamples, prefix) {
  const parentMetrics = metrics(parentSamples);
  const grouped = groupMetrics(spanSamples).map((entry) => ({
    component: String(entry.name || "").startsWith(prefix)
      ? String(entry.name).slice(prefix.length)
      : String(entry.name || "unknown"),
    calls: entry.calls,
    total_ms: entry.total_ms,
    avg_ms: entry.avg_ms,
    p50_ms: entry.p50_ms,
    p95_ms: entry.p95_ms,
    max_ms: entry.max_ms,
    failures: entry.failures,
    share_of_parent_p95: parentMetrics.p95_ms > 0
      ? roundRatio(entry.p95_ms / parentMetrics.p95_ms)
      : null
  })).sort((left, right) => right.p95_ms - left.p95_ms || right.total_ms - left.total_ms);
  return {
    spans: spanSamples.length,
    parent: parentMetrics,
    components: grouped,
    top_contributors: grouped.slice(0, 8)
  };
}

function providerCacheSummary(samples) {
  const providers = samples.filter((sample) => sample.kind === "provider");
  return Object.fromEntries([...new Set(providers.map((sample) => sample.name))].map((name) => {
    const group = providers.filter((sample) => sample.name === name);
    const checks = group.reduce((sum, sample) => sum + Number(sample.cache_checks || (typeof sample.cache_hit === "boolean" ? 1 : 0)), 0);
    const hits = group.reduce((sum, sample) => sum + Number(sample.cache_hits || (sample.cache_hit === true ? 1 : 0)), 0);
    return [name, { checks, hits, hit_ratio: checks ? round(hits / checks) : null }];
  }));
}

function prewarmSummary(contexts, prewarms) {
  const recent = contexts.filter((sample) => sample.prewarm_recent === true);
  const other = contexts.filter((sample) => sample.prewarm_recent !== true);
  const providerNames = ["codegraph", "agentmemory", "semantic"];
  const providers = Object.fromEntries(providerNames.map((name) => {
    const entries = prewarms
      .map((sample) => sample.providers?.[name])
      .filter(Boolean);
    const fulfilled = entries.filter((entry) => entry.status === "fulfilled");
    return [name, {
      attempts: entries.length,
      failures: entries.filter((entry) => entry.status === "rejected").length,
      latency_ms: metrics(entries.map((entry) => ({
        duration_ms: entry.latency_ms,
        success: entry.status === "fulfilled"
      })))
    }];
  }));
  return {
    attempts: prewarms.length,
    failures: prewarms.filter((sample) => sample.success === false).length,
    contexts_after_recent_prewarm: recent.length,
    contexts_without_recent_prewarm: other.length,
    recent_context_ms: metrics(recent),
    other_context_ms: metrics(other),
    providers
  };
}

function sanitizePrewarmProviders(value) {
  const result = {};
  for (const name of ["codegraph", "agentmemory", "semantic"]) {
    const receipt = value?.[name];
    if (!receipt || !["fulfilled", "rejected"].includes(receipt.status)) continue;
    result[name] = {
      status: receipt.status,
      latency_ms: round(receipt.latencyMs || receipt.latency_ms || 0)
    };
  }
  return result;
}

function sanitizeDetails(value) {
  const allowed = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (!["index_ms", "query_ms", "prewarm_ms", "route", "cache_hit", "index_synced", "language", "engine", "state", "available"].includes(key)) continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) allowed[key] = item;
  }
  return allowed;
}

function collectTimedCommands(value) {
  const result = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 6 || result.length >= 30 || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 30)) visit(item, depth + 1);
      return;
    }
    if (typeof node.command === "string" && Number.isFinite(Number(node.duration_ms))) {
      result.push(node);
    }
    for (const item of Object.values(node)) if (item && typeof item === "object") visit(item, depth + 1);
  };
  visit(value);
  return result;
}

function groupMetrics(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const name = sample.name || "unknown";
    const values = groups.get(name) || [];
    values.push(sample);
    groups.set(name, values);
  }
  return [...groups.entries()]
    .map(([name, values]) => ({ name, ...metrics(values) }))
    .sort((left, right) => right.total_ms - left.total_ms || right.p95_ms - left.p95_ms);
}

function metrics(samples) {
  const durations = samples.map((sample) => Number(sample.duration_ms || 0)).filter(Number.isFinite).sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const cacheSamples = samples.filter((sample) => typeof sample.cache_hit === "boolean");
  return {
    calls: samples.length,
    total_ms: round(total),
    avg_ms: samples.length ? round(total / samples.length) : 0,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    max_ms: durations.length ? round(durations[durations.length - 1]) : 0,
    failures: samples.filter((sample) => sample.success === false).length,
    cache_hit_ratio: cacheSamples.length ? round(cacheSamples.filter((sample) => sample.cache_hit).length / cacheSamples.length) : null
  };
}

function cacheFields(value) {
  const signals = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (depth > 5 || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (["cache_hit", "prefetch_hit", "cached"].includes(key) && typeof item === "boolean") signals.push(item);
      else if (item && typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(value);
  return signals.length ? { cache_hit: signals.every(Boolean), cache_checks: signals.length, cache_hits: signals.filter(Boolean).length } : {};
}

function extractStructured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const first = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item?.text === "string")?.text
    : null;
  if (typeof first === "string") {
    const text = first.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try { return JSON.parse(text); } catch { /* ordinary text */ }
    }
  }
  return result && typeof result === "object" ? result : {};
}

function countBy(samples, selector) {
  const result = {};
  for (const sample of samples) {
    const key = selector(sample);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return round(sorted[0]);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] * (1 - (position - lower)) + sorted[upper] * (position - lower);
  return round(value);
}

function normalizeTaskClass(value) {
  return ["user", "internal", "synthetic", "unknown"].includes(value) ? value : "unknown";
}

function normalizeTemperature(value) {
  return ["cold", "mixed", "warm", "unknown"].includes(value) ? value : "unknown";
}

function boundedNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function safeText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function roundRatio(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
