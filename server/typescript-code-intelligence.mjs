// Local Coding Agent — TypeScript/JavaScript LSP + native compiler intelligence
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API, DiagnosticCategory } from "typescript/unstable/sync";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const DEFAULT_LSP_TIMEOUT_MS = 30_000;
const TSGO_BIN = fileURLToPath(new URL("./node_modules/.bin/tsc", import.meta.url));

export function isTypeScriptFamilyFile(file) {
  return TS_EXTENSIONS.has(path.extname(String(file || "")).toLowerCase());
}

export async function tsDefinition(input) {
  return withLsp(input, async (client, location) => ({
    engine: "typescript-lsp",
    definitions: normalizeLocations(await client.request("textDocument/definition", locationParams(location)))
  }));
}

export async function tsReferences(input) {
  return withLsp(input, async (client, location) => {
    const references = normalizeLocations(await client.request("textDocument/references", {
      ...locationParams(location),
      context: { includeDeclaration: input.includeDeclaration !== false }
    }));
    return { engine: "typescript-lsp", count: references.length, references };
  });
}

export async function tsDiagnostics(input) {
  const root = path.resolve(String(input.root || process.cwd()));
  const fileName = input.file ? resolveTsFile(root, input.file) : null;
  const api = new API({ cwd: root, collectTiming: true });
  let snapshot;
  try {
    const params = fileName
      ? { openFiles: [fileName] }
      : { openProjects: [findConfig(root)] };
    snapshot = api.updateSnapshot(params);
    const project = fileName
      ? snapshot.getDefaultProjectForFile(fileName)
      : snapshot.getProjects()[0];
    if (!project) throw new Error(`No TypeScript project found for ${fileName || root}.`);
    const values = [
      ...project.program.getSyntacticDiagnostics(fileName || undefined),
      ...project.program.getSemanticDiagnostics(fileName || undefined)
    ];
    const limit = Math.max(1, Math.min(2000, Number(input.limit || 500)));
    return {
      engine: "typescript-native-compiler",
      root,
      file: fileName,
      count: values.length,
      diagnostics: values.slice(0, limit).map((diagnostic) => normalizeNativeDiagnostic(project, diagnostic)),
      timing: api.getTimingInfo()
    };
  } finally {
    try { snapshot?.dispose(); } catch {}
    api.close();
  }
}

export async function tsRenameSymbol(input) {
  const newName = String(input.newName || "").trim();
  if (!newName) throw new Error("rename requires newName.");
  return withLsp(input, async (client, location) => {
    const edit = await client.request("textDocument/rename", {
      ...locationParams(location),
      newName
    });
    const normalized = await normalizeWorkspaceEdit(edit, location.root);
    if (input.apply === true) await applyWorkspaceEdit(normalized);
    return {
      engine: "typescript-lsp",
      new_name: newName,
      apply: input.apply === true,
      files_changed: normalized.length,
      edits: normalized.reduce((sum, file) => sum + file.edits.length, 0),
      changes: normalized.map(({ file, edits, before, after }) => ({
        file,
        edits: edits.length,
        before_chars: before.length,
        after_chars: after.length,
        changed: before !== after
      }))
    };
  });
}

export async function tsOrganizeImports(input) {
  return withLsp({ ...input, requirePosition: false }, async (client, location) => {
    const lineCount = location.text.split(/\r?\n/).length;
    const actions = await client.request("textDocument/codeAction", {
      textDocument: { uri: location.uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: Math.max(0, lineCount - 1), character: 0 }
      },
      context: { diagnostics: [], only: ["source.organizeImports"] }
    });
    const action = Array.isArray(actions)
      ? actions.find((candidate) => candidate?.edit && String(candidate.kind || "").startsWith("source.organizeImports"))
        || actions.find((candidate) => candidate?.edit)
      : null;
    if (!action?.edit) {
      return { engine: "typescript-lsp", apply: false, files_changed: 0, edits: 0, changes: [], supported: false };
    }
    const normalized = await normalizeWorkspaceEdit(action.edit, location.root);
    if (input.apply === true) await applyWorkspaceEdit(normalized);
    return {
      engine: "typescript-lsp",
      apply: input.apply === true,
      files_changed: normalized.length,
      edits: normalized.reduce((sum, file) => sum + file.edits.length, 0),
      changes: normalized.map(({ file, edits, before, after }) => ({
        file,
        edits: edits.length,
        before_chars: before.length,
        after_chars: after.length,
        changed: before !== after
      })),
      supported: true
    };
  });
}

async function withLsp(input, operation) {
  const root = path.resolve(String(input.root || process.cwd()));
  const file = resolveTsFile(root, input.file);
  const text = await readFile(file, "utf8");
  const position = input.requirePosition === false
    ? { line: 0, character: 0 }
    : resolveTextPosition(text, input);
  const location = { root, file, uri: pathToFileURL(file).href, text, position };
  const client = new TypeScriptLspClient({ root, timeoutMs: input.timeoutMs || DEFAULT_LSP_TIMEOUT_MS });
  try {
    await client.start();
    await client.notify("textDocument/didOpen", {
      textDocument: {
        uri: location.uri,
        languageId: languageIdFor(file),
        version: 1,
        text
      }
    });
    return await operation(client, location);
  } finally {
    await client.close();
  }
}

class TypeScriptLspClient {
  constructor({ root, timeoutMs }) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
  }

  async start() {
    if (!existsSync(TSGO_BIN)) throw new Error(`Bundled TypeScript LSP executable not found: ${TSGO_BIN}`);
    this.child = spawn(TSGO_BIN, ["--lsp", "--stdio"], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-20_000); });
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code) => {
      if (code && this.pending.size) this.rejectAll(new Error(this.stderr || `TypeScript LSP exited with code ${code}.`));
    });
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: {
        workspace: { workspaceEdit: { documentChanges: true } },
        textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["source.organizeImports"] } } } }
      },
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]
    });
    await this.notify("initialized", {});
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TypeScript LSP ${method} timed out after ${this.timeoutMs}ms. ${this.stderr}`.trim()));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("TypeScript LSP stdin is not writable.");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try { this.onMessage(JSON.parse(body)); } catch {}
    }
  }

  onMessage(message) {
    if (message?.method && message?.id !== undefined && message?.id !== null) {
      this.respondToServerRequest(message);
      return;
    }
    if (message?.id === undefined || message?.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`TypeScript LSP ${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  respondToServerRequest(message) {
    let result = null;
    if (message.method === "workspace/configuration") {
      result = Array.isArray(message.params?.items) ? message.params.items.map(() => null) : [];
    } else if (message.method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
    } else if (message.method === "workspace/applyEdit") {
      // KCA owns edit preview/apply. Never let an LSP server mutate files implicitly.
      result = { applied: false, failureReason: "KCA requires explicit apply=true." };
    } else if (message.method === "window/workDoneProgress/create"
      || message.method === "client/registerCapability"
      || message.method === "client/unregisterCapability") {
      result = null;
    }
    this.send({ jsonrpc: "2.0", id: message.id, result });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    const child = this.child;
    if (!child) return;
    try { await this.request("shutdown", null); } catch {}
    try { await this.notify("exit", null); } catch {}
    this.child = null;
    if (!child.killed) child.kill("SIGTERM");
  }
}

function resolveTsFile(root, inputFile) {
  if (!inputFile) throw new Error("TypeScript code intelligence requires file.");
  const file = path.isAbsolute(inputFile) ? path.resolve(inputFile) : path.resolve(root, String(inputFile));
  if (!isTypeScriptFamilyFile(file)) throw new Error(`Unsupported TypeScript-family file: ${file}`);
  return file;
}

function resolveTextPosition(text, input) {
  if (input.symbol) {
    const escaped = String(input.symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\b`).exec(text);
    if (!match) throw new Error(`Symbol '${input.symbol}' was not found in the selected file.`);
    return offsetToPosition(text, match.index);
  }
  const line = Number(input.line ?? 1);
  const column = Number(input.column ?? 1);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) throw new Error("line and column must be positive 1-based integers.");
  return { line: line - 1, character: column - 1 };
}

function offsetToPosition(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length || 0 };
}

function locationParams(location) {
  return { textDocument: { uri: location.uri }, position: location.position };
}

function normalizeLocations(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const uri = item.uri || item.targetUri;
    const range = item.range || item.targetSelectionRange || item.targetRange;
    if (!uri || !range) return [];
    return [{
      file: fileURLToPath(uri),
      start: { line: range.start.line + 1, column: range.start.character + 1 },
      end: { line: range.end.line + 1, column: range.end.character + 1 }
    }];
  });
}

function normalizeNativeDiagnostic(project, diagnostic) {
  const source = diagnostic.fileName ? project.program.getSourceFile(diagnostic.fileName) : null;
  const location = source && diagnostic.pos >= 0
    ? source.getLineAndCharacterOfPosition(diagnostic.pos)
    : null;
  return {
    file: diagnostic.fileName || null,
    line: location ? location.line + 1 : null,
    column: location ? location.character + 1 : null,
    severity: diagnosticCategoryName(diagnostic.category),
    code: `TS${diagnostic.code}`,
    message: diagnostic.text || flattenNativeMessage(diagnostic)
  };
}

function diagnosticCategoryName(category) {
  if (category === DiagnosticCategory.Error) return "error";
  if (category === DiagnosticCategory.Warning) return "warning";
  if (category === DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}

function flattenNativeMessage(diagnostic) {
  const values = [];
  let current = diagnostic;
  while (current) {
    if (current.text) values.push(current.text);
    current = current.messageChain?.[0];
  }
  return values.join("\n");
}

async function normalizeWorkspaceEdit(edit, root) {
  if (!edit) return [];
  const byFile = new Map();
  for (const [uri, edits] of Object.entries(edit.changes || {})) {
    const file = fileURLToPath(uri);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(...edits);
  }
  for (const change of edit.documentChanges || []) {
    if (!change?.textDocument?.uri || !Array.isArray(change.edits)) continue;
    const file = fileURLToPath(change.textDocument.uri);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(...change.edits);
  }
  const output = [];
  for (const [file, edits] of byFile) {
    const absolute = path.resolve(file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`LSP edit is outside workspace root: ${absolute}`);
    const before = await readFile(absolute, "utf8");
    const after = applyLspTextEdits(before, edits);
    output.push({ file: absolute, edits, before, after });
  }
  return output;
}

async function applyWorkspaceEdit(changes) {
  for (const change of changes) await writeFile(change.file, change.after, "utf8");
}

function applyLspTextEdits(text, edits) {
  const normalized = edits.map((edit) => ({
    start: positionToOffset(text, edit.range.start),
    end: positionToOffset(text, edit.range.end),
    newText: edit.newText || ""
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let output = text;
  for (const edit of normalized) output = `${output.slice(0, edit.start)}${edit.newText}${output.slice(edit.end)}`;
  return output;
}

function positionToOffset(text, position) {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let index = 0; index < position.line; index++) offset += (lines[index]?.length || 0) + 1;
  return offset + position.character;
}

function findConfig(root) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`No tsconfig.json or jsconfig.json found under ${root}.`);
}

function languageIdFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".jsx") return "javascriptreact";
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
  return "typescript";
}
