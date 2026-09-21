import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

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
  assert.ok(commands[0]?.args.includes("PaymentCoordinator"));
  assert.equal(evidence[0]?.provider, "filesystem");
  assert.equal(evidence[0]?.path, "/repo/src/payment.ts");
  assert.equal(evidence[0]?.metadata?.line, 14);
});

test("expands top source matches into bounded source slices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lca-source-slice-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "payment.ts"), [
      "line1", "line2", "line3", "line4", "line5", "line6",
      "export class PaymentCoordinator {}",
      "line8", "line9", "line10", "line11", "line12"
    ].join("\n"), "utf8");
    const adapter = new RipgrepFilesystemContextAdapter({
      runner: {
        async run() {
          return {
            stdout: JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/payment.ts" },
                lines: { text: "export class PaymentCoordinator {}\n" },
                line_number: 7
              }
            })
          };
        }
      }
    });

    const evidence = await adapter.search({ task: "Fix PaymentCoordinator", root, budget: { maxItems: 3, maxChars: 6_000 } });
    assert.equal(evidence[0]?.metadata?.source_slice, true);
    assert.match(evidence[0]?.content ?? "", />\s+7 \| export class PaymentCoordinator/);
    assert.match(evidence[0]?.content ?? "", /2 \| line2/);
    assert.match(evidence[0]?.content ?? "", /12 \| line12/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ranks concrete code symbols above noisy project metadata", async () => {
  let maxMatches = 0;
  let commandArgs: readonly string[] = [];
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run(_command, args, _cwd, options) {
        commandArgs = args;
        maxMatches = options?.maxMatches ?? 0;
        return {
          stdout: [
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "README.md" },
                lines: { text: "ScanResultPage and advertisement prefetch are documented here.\n" },
                line_number: 20
              }
            }),
            JSON.stringify({
              type: "match",
              data: {
                path: { text: ".commandcode/taste/taste.md" },
                lines: { text: "Prefer ScanResultPage for the advertisement flow.\n" },
                line_number: 4
              }
            }),
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "lib/pages/user-new/scan/result/scan_result_page.dart" },
                lines: { text: "class ScanResultPage extends StatefulWidget {\n" },
                line_number: 38
              }
            }),
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "lib/blocs/user_scan/user_scan_cubit.dart" },
                lines: { text: "final slides = await loadScanAdvertisementSlides(\n" },
                line_number: 287
              }
            })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Find loadScanAdvertisementSlides and ScanResultPage advertisement prefetch callers",
    root: "/repo",
    budget: { maxItems: 2 }
  });

  assert.equal(maxMatches, 16, "filesystem search should gather a candidate pool before ranking");
  assert.ok(commandArgs.includes("--fixed-strings"));
  assert.deepEqual(evidence.map((item) => item.path), [
    "/repo/lib/blocs/user_scan/user_scan_cubit.dart",
    "/repo/lib/pages/user-new/scan/result/scan_result_page.dart"
  ]);
  assert.ok((evidence[0]?.score ?? 0) > 80);
  assert.ok((evidence[1]?.score ?? 0) > 80);
});

test("implementation reranking prefers source definitions over docs and lock/config noise", async () => {
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        return {
          stdout: [
            JSON.stringify({ type: "match", data: { path: { text: "README.md" }, lines: { text: "PaymentCoordinator is described here.\n" }, line_number: 4 } }),
            JSON.stringify({ type: "match", data: { path: { text: "package-lock.json" }, lines: { text: "PaymentCoordinator dependency metadata\n" }, line_number: 20 } }),
            JSON.stringify({ type: "match", data: { path: { text: "src/payment/payment_coordinator.ts" }, lines: { text: "export class PaymentCoordinator {\n" }, line_number: 8 } })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Implement PaymentCoordinator retry behavior",
    intent: "implement",
    root: "/repo",
    budget: { maxItems: 3 }
  });

  assert.equal(evidence[0]?.path, "/repo/src/payment/payment_coordinator.ts");
  assert.ok((evidence[0]?.metadata?.rerankReasons as string[]).includes("definition"));
  assert.ok((evidence[0]?.score ?? 0) > (evidence.find((item) => item.path?.endsWith("README.md"))?.score ?? 0));
  assert.ok((evidence[0]?.score ?? 0) > (evidence.find((item) => item.path?.endsWith("package-lock.json"))?.score ?? 0));
});

test("identifier splitting falls back from exact symbol to useful camel-case parts", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run(_command, args) {
        mutableCalls.push([...args]);
        if (mutableCalls.length === 1) return { stdout: "" };
        return {
          stdout: JSON.stringify({
            type: "match",
            data: { path: { text: "lib/scan/ads.dart" }, lines: { text: "Future<void> load scan advertisement slides() async {}\n" }, line_number: 12 }
          })
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Fix loadScanAdvertisementSlides",
    intent: "debug",
    root: "/repo",
    budget: { maxItems: 3 }
  });

  assert.equal(mutableCalls.length, 2);
  assert.ok(mutableCalls[1]?.includes("Scan"));
  assert.ok(mutableCalls[1]?.includes("Advertisement"));
  assert.ok(mutableCalls[1]?.includes("Slides"));
  assert.equal(evidence[0]?.path, "/repo/lib/scan/ads.dart");
});

test("review intent boosts relevant tests and explicit config over ordinary usages", async () => {
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        return {
          stdout: [
            JSON.stringify({ type: "match", data: { path: { text: "src/retry.ts" }, lines: { text: "return RetryCoordinator.run();\n" }, line_number: 30 } }),
            JSON.stringify({ type: "match", data: { path: { text: "tests/retry.test.ts" }, lines: { text: "expect(RetryCoordinator.run()).toBeDefined();\n" }, line_number: 18 } }),
            JSON.stringify({ type: "match", data: { path: { text: "tsconfig.json" }, lines: { text: "// RetryCoordinator config review marker\n" }, line_number: 5 } })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Review RetryCoordinator test and config risk",
    intent: "review",
    root: "/repo",
    budget: { maxItems: 3 }
  });

  assert.equal(evidence[0]?.path, "/repo/tests/retry.test.ts");
  const config = evidence.find((item) => item.path === "/repo/tsconfig.json");
  assert.ok((config?.metadata?.rerankReasons as string[]).includes("explicit-config-match"));
  assert.ok((config?.score ?? 0) > 1);
});

test("boosts matches from explicitly changed files and nearby files", async () => {
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        return {
          stdout: [
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "lib/legacy/retry.dart" },
                lines: { text: "class RetryCoordinator {}\n" },
                line_number: 10
              }
            }),
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "lib/current/retry.dart" },
                lines: { text: "class RetryCoordinator {}\n" },
                line_number: 10
              }
            }),
            JSON.stringify({
              type: "match",
              data: {
                path: { text: "lib/current/retry_helper.dart" },
                lines: { text: "RetryCoordinator helper usage\n" },
                line_number: 4
              }
            })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Trace RetryCoordinator",
    root: "/repo",
    changedFiles: ["lib/current/retry.dart"],
    budget: { maxItems: 2 }
  });

  assert.equal(evidence[0]?.path, "/repo/lib/current/retry.dart");
  assert.ok((evidence[0]?.score ?? 0) > (evidence[1]?.score ?? 0));
});

test("spreads high-signal matches across files before returning duplicate lines", async () => {
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        return {
          stdout: [
            JSON.stringify({ type: "match", data: { path: { text: "lib/a.dart" }, lines: { text: "ScanResultPage one\n" }, line_number: 1 } }),
            JSON.stringify({ type: "match", data: { path: { text: "lib/a.dart" }, lines: { text: "ScanResultPage two\n" }, line_number: 2 } }),
            JSON.stringify({ type: "match", data: { path: { text: "lib/b.dart" }, lines: { text: "ScanResultPage three\n" }, line_number: 3 } })
          ].join("\n")
        };
      }
    }
  });

  const evidence = await adapter.search({
    task: "Trace ScanResultPage",
    root: "/repo",
    budget: { maxItems: 2 }
  });

  assert.deepEqual(evidence.map((item) => item.path), ["/repo/lib/a.dart", "/repo/lib/b.dart"]);
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
