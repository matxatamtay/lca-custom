import {
  inspectManagedRuntime, installManagedRuntime, runtimeInstallPlan
} from "../managed-runtime.mjs";

export function createManagedRuntimeCommands(options) {
  const {
    MANAGED_RUNTIME_PATHS, capture, isPidAlive, killPid, readJson, readPidState, runChecked
  } = options;

  function managedRuntimeOptions(overrides = {}) {
    return {
      paths: MANAGED_RUNTIME_PATHS,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      agentMemoryUrl: process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111",
      ...overrides
    };
  }

  async function runManagedRuntimeCommand(command, args, options = {}) {
    const label = options.cwd === MANAGED_RUNTIME_PATHS.memoryDirectory
      ? "agentmemory"
      : args.includes("build:next")
        ? "build-next"
        : "server-deps";
    await runChecked(label, command, args, {
      cwd: options.cwd,
      env: options.env
    });
    return { code: 0, signal: null, stdout: "", stderr: "" };
  }

  async function runManagedRuntimeQuiet(command, args, options = {}) {
    const result = await capture(command, args, { cwd: options.cwd, env: options.env });
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed with exit ${result.code}: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  async function installManagedRuntimeCommand(flags = {}) {
    const quiet = flags.quiet === true || flags.json === true;
    const result = await installManagedRuntime(managedRuntimeOptions({
      force: flags.force === true,
      probeEngine: flags.probeEngine,
      probeServices: flags.probeServices,
      run: quiet ? runManagedRuntimeQuiet : runManagedRuntimeCommand,
      log: (message) => {
        if (!quiet) console.log(`[runtime] ${message}`);
      }
    }));
    if (flags.json) {
      console.log(JSON.stringify({
        kind: "managed_runtime_install",
        plan: result.plan,
        repaired: result.plan.installServer || result.plan.installAgentMemory || result.plan.patchAgentMemory || result.plan.initializeAgentMemory,
        rebuilt: result.plan.buildCompactRuntime,
        receipt: result.after
      }, null, 2));
    } else if (!quiet) {
      printManagedRuntimeReceipt(result.after);
    }
    return result.after;
  }

  async function managedRuntimeFastReport() {
    return inspectManagedRuntime(managedRuntimeOptions({
      probeEngine: false,
      probeServices: false
    }));
  }

  async function stopManagedServerForRepair(opts, { quiet = false } = {}) {
    const state = readPidState();
    const health = await readJson(`http://127.0.0.1:${opts.port}/healthz`);
    const serverPid = health?.pid || state.serverPid;
    if (!serverPid || !isPidAlive(serverPid)) return false;
    if (!quiet) console.log(`[runtime] stopping server PID ${serverPid} before replacing dependencies`);
    killPid(serverPid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isPidAlive(serverPid)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (isPidAlive(serverPid)) throw new Error(`Server PID ${serverPid} did not exit before managed runtime repair.`);
    return true;
  }

  async function ensureManagedRuntime(opts) {
    const before = await managedRuntimeFastReport();
    const plan = runtimeInstallPlan(before);
    if (plan.installServer || plan.installAgentMemory || plan.patchAgentMemory) {
      await stopManagedServerForRepair(opts, { quiet: true });
    }
    return installManagedRuntimeCommand({
      quiet: true,
      force: false,
      probeEngine: false,
      probeServices: false
    });
  }

  async function withMutedConsoleLog(operation) {
    const original = console.log;
    console.log = () => {};
    try {
      return await operation();
    } finally {
      console.log = original;
    }
  }

  function printManagedRuntimeReceipt(receipt) {
    for (const check of receipt.checks) {
      const prefix = check.status === "pass" ? "OK " : check.status === "warn" ? "WARN" : "ERR";
      console.log(`${prefix} ${check.title}: ${check.detail}`);
    }
    console.log(`Managed runtime: ${receipt.status.toUpperCase()} (${receipt.summary.pass} pass, ${receipt.summary.warn} warn, ${receipt.summary.fail} fail)`);
  }


  const inspectRuntime = (overrides = {}) => inspectManagedRuntime(managedRuntimeOptions(overrides));
  const installPlan = (report, options = {}) => runtimeInstallPlan(report, options);
  return {
    ensureManagedRuntime, installManagedRuntimeCommand, managedRuntimeFastReport,
    printManagedRuntimeReceipt, stopManagedServerForRepair, withMutedConsoleLog,
    inspectRuntime, installPlan
  };
}
