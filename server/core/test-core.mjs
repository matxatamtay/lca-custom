import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function createTestCore(options) {
  const { runShellCommand } = options;

  async function detectTestCommands(rootDir) {
    const commands = { test: null, build: null, lint: null, dev: null, typecheck: null };

    async function tryRead(rel) {
      try { return await readFile(path.join(rootDir, rel), "utf8"); } catch { return null; }
    }

    // npm / Node
    const pkgJson = await tryRead("package.json");
    if (pkgJson) {
      try {
        const pkg = JSON.parse(pkgJson);
        const scripts = pkg.scripts || {};
        if (scripts.test) commands.test = `npm test`;
        if (scripts.build) commands.build = `npm run build`;
        if (scripts.lint) commands.lint = `npm run lint`;
        if (scripts.dev) commands.dev = `npm run dev`;
        if (scripts.typecheck || scripts["type-check"] || scripts["type:check"]) {
          commands.typecheck = `npm run ${Object.keys(scripts).find((k) => /typecheck|type.check/.test(k))}`;
        }
      } catch { /* skip */ }
    }

    // Python / pytest
    const pyproject = await tryRead("pyproject.toml");
    const reqTxt = await tryRead("requirements.txt");
    if (pyproject || reqTxt) {
      if (!commands.test) commands.test = "python -m pytest";
      if (!commands.lint) commands.lint = "python -m flake8";
    }

    // Go
    if (await tryRead("go.mod")) {
      if (!commands.test) commands.test = "go test ./...";
      if (!commands.build) commands.build = "go build ./...";
    }

    // Rust
    if (await tryRead("Cargo.toml")) {
      if (!commands.test) commands.test = "cargo test";
      if (!commands.build) commands.build = "cargo build";
      if (!commands.lint) commands.lint = "cargo clippy";
    }

    // Flutter
    if (await tryRead("pubspec.yaml")) {
      if (!commands.test) commands.test = "flutter test";
      if (!commands.build) commands.build = "flutter build";
    }

    // .NET
    let items;
    try { items = await readdir(rootDir); } catch { items = []; }
    if (items.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
      if (!commands.test) commands.test = "dotnet test";
      if (!commands.build) commands.build = "dotnet build";
    }

    // Gradle
    if (await tryRead("build.gradle")) {
      if (!commands.test) commands.test = "gradle test";
      if (!commands.build) commands.build = "gradle build";
    }

    // Maven
    if (await tryRead("pom.xml")) {
      if (!commands.test) commands.test = "mvn test";
      if (!commands.build) commands.build = "mvn package";
    }

    return commands;
  }

  function parseTestFailures(output) {
    const failures = [];
    const lines = output.split(/\r?\n/);
    const patterns = [
      // Jest / Vitest: "FAIL src/foo.test.ts" or "✕ test name"
      /^(FAIL|FAILED)\s+(.+)$/,
      // Node assert / mocha
      /AssertionError/,
      // file:line:col error
      /^(.+):(\d+):(\d+):\s*(Error|error)/,
      // "expected X got Y"
      /expected.*got\b/i,
      // "× test name" (Unicode ×)
      /^[\s]*[×✕✗]\s+(.+)/
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of patterns) {
        const m = line.match(pat);
        if (m) {
          failures.push({ message: line.slice(0, 300), context: lines.slice(Math.max(0, i - 1), i + 3).join("\n").slice(0, 500) });
          break;
        }
      }
      if (failures.length >= 30) break;
    }
    return failures;
  }

  async function runGatedCommand(command, cwd, timeoutMs = 120_000) {
    const startedMs = performance.now();
    const result = await runShellCommand(command, cwd, undefined, timeoutMs);
    const output = (result.stdout + "\n" + result.stderr).trim();
    const ok = result.exit_code === 0;
    const failures = ok ? [] : parseTestFailures(output);
    const summary = output.slice(0, 3000);
    return {
      ok,
      command,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: Math.round((performance.now() - startedMs) * 10) / 10,
      ...(result.acceleration ? { acceleration: result.acceleration } : {}),
      summary,
      failures
    };
  }


  return { detectTestCommands, parseTestFailures, runGatedCommand };
}
