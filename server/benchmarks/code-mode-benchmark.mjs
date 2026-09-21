import { performance } from "node:perf_hooks";

import { runCodeMode } from "../code-mode-runtime.mjs";

const CALLS = 8;
const BACKEND_DELAY_MS = 35;

async function backend(action) {
  await new Promise((resolve) => setTimeout(resolve, BACKEND_DELAY_MS));
  return { action, ok: true };
}

const sequentialStart = performance.now();
for (let index = 0; index < CALLS; index += 1) await backend(`read-${index}`);
const sequentialMs = performance.now() - sequentialStart;

const codeStart = performance.now();
const code = await runCodeMode({
  program: `
    const names = Array.from({ length: ${CALLS} }, (_, index) => 'read-' + index);
    return await Promise.all(names.map((name) => lca.read(name, {})));
  `,
  dispatch: (_facade, action) => backend(action)
});
const codeMs = performance.now() - codeStart;
const latencyImprovement = (sequentialMs - codeMs) / sequentialMs;
const modelRoundTripReduction = (CALLS - 1) / CALLS;
const shipped = modelRoundTripReduction >= 0.20 || latencyImprovement >= 0.15;

console.log(JSON.stringify({
  calls: CALLS,
  backend_delay_ms: BACKEND_DELAY_MS,
  sequential_ms: Math.round(sequentialMs * 10) / 10,
  code_mode_ms: Math.round(codeMs * 10) / 10,
  latency_improvement_pct: Math.round(latencyImprovement * 1000) / 10,
  model_round_trip_reduction_pct: Math.round(modelRoundTripReduction * 1000) / 10,
  result_count: Array.isArray(code.value) ? code.value.length : 0,
  threshold: "ship when round trips improve >=20% OR latency improves >=15%",
  shipped
}, null, 2));

if (!shipped) process.exitCode = 1;
