import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function createFilesystemCore(options) {
  const { RG_BIN, SKIP_DIRS, toRel } = options;

  async function buildTree(start, maxDepth, maxEntries) {
    const tree = [];
    const dirs = [];
    const files = [];
    async function walk(current, depth) {
      if (tree.length >= maxEntries || depth > maxDepth) return;
      let items;
      try {
        items = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      // directories first, then files, alphabetical — predictable for the model
      items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const item of items) {
        if (tree.length >= maxEntries) return;
        if (SKIP_DIRS.has(item.name)) continue;
        const abs = path.join(current, item.name);
        tree.push(item.isDirectory() ? abs + path.sep : abs);
        if (item.isDirectory()) {
          dirs.push(abs);
          await walk(abs, depth + 1);
        } else {
          files.push(abs);
        }
      }
    }
    await walk(start, 1);
    return { tree, dirs, files };
  }

  async function buildTreeFast(start, maxDepth, maxEntries) {
    const listed = await listRepoFilesFast(start, Math.max(maxEntries * 4, 4000));
    if (listed.engine === "scan") return { ...(await buildTree(start, maxDepth, maxEntries)), engine: "scan" };
    const tree = [];
    const dirs = new Set();
    const files = [];
    const seen = new Set();
    const addEntry = (entry) => {
      if (tree.length >= maxEntries || seen.has(entry)) return;
      seen.add(entry);
      tree.push(entry);
    };
    for (const abs of listed.files) {
      const rel = path.relative(start, abs).split(path.sep).join("/");
      const parts = rel.split("/").filter(Boolean);
      for (let i = 1; i < parts.length && i <= maxDepth; i++) {
        const dirAbs = path.resolve(start, ...parts.slice(0, i));
        dirs.add(dirAbs);
        addEntry(`${dirAbs}${path.sep}`);
      }
      if (parts.length <= maxDepth) {
        files.push(abs);
        addEntry(abs);
      }
      if (tree.length >= maxEntries) break;
    }
    return { tree, dirs: [...dirs], files, engine: listed.engine };
  }

  // ----------------------------------------------------------------------------
  // Filesystem write tools
  // ----------------------------------------------------------------------------
  async function listEntries(dir, { recursive, limit }) {
    const out = [];
    async function walk(current) {
      let items;
      try {
        items = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (out.length >= limit) return;
        if (SKIP_DIRS.has(item.name)) continue;
        const abs = path.join(current, item.name);
        let info;
        try {
          info = await stat(abs);
        } catch {
          continue;
        }
        out.push({
          path: toRel(abs),
          type: item.isDirectory() ? "directory" : "file",
          size: info.size,
          modified: info.mtime.toISOString()
        });
        if (recursive && item.isDirectory()) await walk(abs);
      }
    }
    await walk(dir);
    return out;
  }

  // Parse "path:line:text" grep-style output into match objects.
  function parseGrepOutput(out, dir, limit) {
    const matches = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      const abs = path.resolve(dir, m[1]);
      matches.push({ path: toRel(abs), line: Number(m[2]), text: m[3].slice(0, 500) });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  // Fastest path: ripgrep. Respects .gitignore, works in any folder. null on miss.
  function ripgrepGrep(dir, query, { regex, limit, glob }) {
    if (!RG_BIN) return Promise.resolve(null);
    // NOTE: no -I here — in ripgrep -I means --no-filename (grep/git use it for
    // "ignore binary"). ripgrep skips binary files by default.
    const args = ["--no-heading", "--with-filename", "-n", "-S", "--color", "never"];
    if (!regex) args.push("-F");
    if (glob) args.push("-g", glob);
    args.push("-e", query, "--", ".");
    return new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawn(RG_BIN, args, { cwd: dir, windowsHide: true });
      } catch {
        return resolve(null);
      }
      child.stdout?.on("data", (c) => {
        if (out.length < 8_000_000) out += c.toString();
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0 && code !== 1) return resolve(null);
        resolve(parseGrepOutput(out, dir, limit));
      });
    });
  }

  // Fast path: `git grep` inside a git work tree. Returns null when not a git repo
  // / git unavailable / errored, so the caller can fall back to a JS scan.
  function gitGrep(dir, query, { regex, limit, glob }) {
    return new Promise((resolve) => {
      const args = ["-C", dir, "grep", "--no-color", "-n", "-I", "-i", "--untracked"];
      args.push(regex ? "-E" : "-F", "-e", query, "--", glob ? glob : ".");
      let out = "";
      let child;
      try {
        child = spawn("git", args, { windowsHide: true });
      } catch {
        return resolve(null);
      }
      child.stdout?.on("data", (c) => {
        if (out.length < 8_000_000) out += c.toString();
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code === 128) return resolve(null); // not a git repo
        if (code !== 0 && code !== 1) return resolve(null); // 1 = no matches
        resolve(parseGrepOutput(out, dir, limit));
      });
    });
  }

  // Attach a few lines of context to each match by reading files locally (no extra
  // round trips to the model). Files are read once and cached for this call.
  async function attachContext(matches, ctx) {
    const cache = new Map();
    for (const m of matches) {
      const abs = path.isAbsolute(m.path) ? m.path : path.resolve(PRIMARY_ROOT, m.path);
      let lines = cache.get(abs);
      if (!lines) {
        try {
          lines = (await readFile(abs, "utf8")).split(/\r?\n/);
        } catch {
          lines = null;
        }
        cache.set(abs, lines);
      }
      if (!lines) continue;
      const from = Math.max(1, m.line - ctx);
      const to = Math.min(lines.length, m.line + ctx);
      const snippet = [];
      for (let i = from; i <= to; i++) snippet.push(`${i}| ${lines[i - 1]}`);
      m.snippet = snippet.join("\n");
    }
  }

  // Convert a simple glob (*, **, ?) to a RegExp for the scan fallback.
  function globToRegex(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        if (glob[i + 1] === "*") {
          out += ".*";
          i++;
        } else {
          out += "[^/]*";
        }
      } else if (c === "?") {
        out += ".";
      } else if (/[.+^${}()|[\]\\]/.test(c)) {
        out += "\\" + c;
      } else {
        out += c;
      }
    }
    return new RegExp("^" + out + "$", "i");
  }

  // Find files by name glob: ripgrep --files > git ls-files > JS walk.
  async function findFiles(start, glob, limit) {
    // ripgrep
    if (RG_BIN) {
      const out = await spawnFilesList(RG_BIN, ["--files", "-g", glob], start);
      if (out !== null) return { engine: "ripgrep", files: out.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
    }
    // git ls-files
    const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
    if (gitOut !== null) {
      const rx = globToRegex(glob);
      const hasSlash = glob.includes("/");
      const hit = gitOut.filter((p) => rx.test(hasSlash ? p : path.basename(p)));
      if (hit.length || gitOut.length) return { engine: "git", files: hit.slice(0, limit).map((p) => toRel(path.resolve(start, p))) };
    }
    // JS walk fallback
    const rx = globToRegex(glob);
    const hasSlash = glob.includes("/");
    const all = await listEntries(start, { recursive: true, limit: 20000 });
    const files = all
      .filter((e) => e.type === "file")
      .map((e) => e.path)
      .filter((p) => rx.test(hasSlash ? p.split(path.sep).join("/") : path.basename(p)))
      .slice(0, limit);
    return { engine: "scan", files };
  }

  async function listRepoFilesFast(start, limit = 4000) {
    if (RG_BIN) {
      const out = await spawnFilesList(RG_BIN, ["--files"], start);
      if (out !== null) {
        return { engine: "ripgrep", files: out.slice(0, limit).map((p) => path.resolve(start, p)) };
      }
    }
    const gitOut = await spawnFilesList("git", ["-C", start, "ls-files", "--cached", "--others", "--exclude-standard"], null);
    if (gitOut !== null) {
      return { engine: "git", files: gitOut.slice(0, limit).map((p) => path.resolve(start, p)) };
    }
    const all = await listEntries(start, { recursive: true, limit });
    return { engine: "scan", files: all.filter((e) => e.type === "file").map((e) => resolvePath(e.path)) };
  }

  function spawnFilesList(file, args, cwd) {
    return new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawn(file, args, cwd ? { cwd, windowsHide: true } : { windowsHide: true });
      } catch {
        return resolve(null);
      }
      child.stdout?.on("data", (c) => {
        if (out.length < 8_000_000) out += c.toString();
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0 && code !== 1) return resolve(null);
        resolve(out.split(/\r?\n/).filter(Boolean));
      });
    });
  }

  async function searchTree(start, query, { regex, limit, glob }) {
    const pattern = regex ? new RegExp(query, "i") : null;
    const needle = query.toLowerCase();
    const globRx = glob ? globToRegex(glob) : null;
    const globHasSlash = glob ? glob.includes("/") : false;
    const matches = [];
    const files = [];

    async function collect(current) {
      let info;
      try {
        info = await stat(current);
      } catch {
        return;
      }
      if (info.isFile()) {
        files.push(current);
        return;
      }
      let items;
      try {
        items = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (files.length > 50000) return;
        await collect(path.join(current, item.name));
      }
    }

    await collect(start);
    for (const file of files) {
      if (matches.length >= limit) break;
      if (globRx) {
        const rel = toRel(file);
        const target = globHasSlash ? rel : path.basename(file);
        if (!globRx.test(target)) continue;
      }
      let content;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const found = regex ? pattern.test(line) : line.toLowerCase().includes(needle);
        if (!found) continue;
        matches.push({ path: toRel(file), line: i + 1, text: line.slice(0, 500) });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  // ----------------------------------------------------------------------------
  // Command execution
  // ----------------------------------------------------------------------------

  return {
    attachContext, buildTree, buildTreeFast, findFiles, gitGrep, listEntries, listRepoFilesFast,
    ripgrepGrep, searchTree
  };
}
