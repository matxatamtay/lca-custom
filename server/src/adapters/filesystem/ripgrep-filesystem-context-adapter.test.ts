import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildRipgrepCommandCandidates,
  RipgrepFilesystemContextAdapter,
  StreamingSearchCommandRunner
} from "./ripgrep-filesystem-context-adapter.js";

test("turns ripgrep JSON matches into bounded filesystem evidence", async () => {
  const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run(command, args, cwd) {
        commands.push({ command, args, cwd });
        return {
          stdout: [
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/payment.ts" },
                lines: { text: "export class PaymentCoordinator {}\n" },
                line_number: 14
              }
            }),
            JSON.stringify({ type: "end", data: {} })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Trace PaymentCoordinator retry flow",
    root: "/repo",
    budget: { maxItems: 5 }
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.command, "rg");
  assert.ok(commands[0]?.args.includes("paymentcoordinator"));
  assert.equal(evidence[0]?.provider, "filesystem");
  assert.equal(evidence[0]?.path, "/repo/src/payment.ts");
  assert.equal(evidence[0]?.metadata?.line, 14);
});

test("returns no evidence when the task has no searchable terms", async () => {
  let called = false;
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        called = true;
        return { stdout: "" };
      }
    }
  });

  assert.deepEqual(await adapter.search({ task: "a b", root: "/repo" }), []);
  assert.equal(called, false);
});

test("streams command output and stops after the requested match count", async () => {
  const runner = new StreamingSearchCommandRunner();
  const script = [
    "for (let index = 0; index < 10000; index += 1) {",
    "  console.log(JSON.stringify({ type: 'match', data: { path: { text: `src/${index}.ts` }, lines: { text: 'match' }, line_number: 1 } }));",
    "}"
  ].join("\n");

  const result = await runner.run(process.execPath, ["-e", script], process.cwd(), {
    maxMatches: 3,
    maxOutputBytes: 64 * 1024,
    timeoutMs: 5_000
  });
  const matches = result.stdout
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line).type === "match");

  assert.equal(matches.length, 3);
  assert.ok(Buffer.byteLength(result.stdout) < 64 * 1024);
});

test("builds ripgrep candidates from configured path, PATH, and common locations", () => {
  const candidates = buildRipgrepCommandCandidates(
    "rg",
    {
      LCA_RG_PATH: "/custom/ripgrep",
      PATH: "/first/bin:/second/bin"
    },
    "darwin"
  );

  assert.deepEqual(candidates.slice(0, 4), [
    "/custom/ripgrep",
    "rg",
    "/first/bin/rg",
    "/second/bin/rg"
  ]);
  assert.ok(candidates.includes("/opt/homebrew/bin/rg"));
});

test("reports a clear diagnostic when ripgrep cannot be found", async () => {
  const runner = new StreamingSearchCommandRunner({ environment: { PATH: "" } });

  await assert.rejects(
    runner.run("definitely-not-a-real-rg-command", ["--version"], process.cwd(), { timeoutMs: 2_000 }),
    /ripgrep executable was not found.*LCA_RG_PATH/
  );
});

test("reports a missing workspace directory instead of blaming ripgrep", async () => {
  const runner = new StreamingSearchCommandRunner();
  const missing = path.join(process.cwd(), `.missing-workspace-${process.pid}-${Date.now()}`);

  await assert.rejects(
    runner.run("rg", ["--version"], missing, { timeoutMs: 2_000 }),
    (error: unknown) => error instanceof Error
      && error.message === `Workspace search directory does not exist: ${missing}`
  );
});
