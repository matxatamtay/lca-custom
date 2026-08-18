import test from "node:test";
import assert from "node:assert/strict";

import { RipgrepFilesystemContextAdapter } from "./ripgrep-filesystem-context-adapter.js";

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

test("filters generated and license noise unless licensing is the task", async () => {
  const seen: string[][] = [];
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run(_command, args) {
        seen.push([...args]);
        return { stdout: "" };
      }
    }
  });

  await adapter.search({ task: "Implement context reranking", root: "/repo" });
  await adapter.search({ task: "Review AGPL license", root: "/repo" });

  assert.ok(seen[0]?.includes("!dist/**"));
  assert.ok(seen[0]?.includes("!LICENSE"));
  assert.equal(seen[1]?.includes("!LICENSE"), false);
});

test("ranks changed source matches ahead of documentation matches", async () => {
  const adapter = new RipgrepFilesystemContextAdapter({
    runner: {
      async run() {
        return {
          stdout: [
            JSON.stringify({
              type: "match",
              data: { path: { text: "docs/context.md" }, lines: { text: "context reranking\n" }, line_number: 1 }
            }),
            JSON.stringify({
              type: "match",
              data: { path: { text: "src/context.ts" }, lines: { text: "export function reranking() {}\n" }, line_number: 10 }
            })
          ].join("\n")
        };
      }
    }
  });

  const result = await adapter.search({
    task: "context reranking",
    root: "/repo",
    changedFiles: ["src/context.ts"],
    budget: { maxItems: 2 }
  });

  assert.equal(result[0]?.path, "/repo/src/context.ts");
});
