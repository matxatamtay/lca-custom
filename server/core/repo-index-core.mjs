import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function createRepoIndexCore(options) {
  const {
    INDEX_PATH, REPO_INDEX_TTL_MS, RG_BIN, buildTreeFast, collectImportantFiles, compactGitStatus,
    detectProjectProfile, isoNow, scanSymbols, toRel
  } = options;

  async function readRepoIndex() {
    try {
      const raw = await readFile(INDEX_PATH, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function writeRepoIndex(data) {
    await mkdir(path.dirname(INDEX_PATH), { recursive: true });
    await writeFile(INDEX_PATH, JSON.stringify(data, null, 2), "utf8");
  }

  function indexFresh(idx) {
    if (!idx || !idx.ts) return false;
    return Date.now() - new Date(idx.ts).getTime() < REPO_INDEX_TTL_MS;
  }

  function indexMatches(idx, rootDir) {
    return Boolean(idx && idx.rootDir === rootDir && indexFresh(idx));
  }

  function treeCovers(idx, { depth, maxEntries }) {
    const tree = idx?.tree;
    if (!tree || Number(tree.depth || 0) < depth) return false;
    if (tree.truncated && Number(tree.max_entries || tree.entries?.length || 0) < maxEntries) return false;
    return true;
  }

  function symbolsCover(idx, { maxFiles, maxMatches }) {
    const meta = idx?.symbols_meta;
    return Array.isArray(idx?.symbols) &&
      Number(meta?.max_files || 0) >= maxFiles &&
      Number(meta?.max_matches || 0) >= maxMatches;
  }

  function relEntriesToAbs(rootDir, entries = []) {
    return entries.filter((entry) => !entry.endsWith("/")).map((entry) => path.resolve(rootDir, entry));
  }

  async function buildRepoIndex(rootDir, { depth = 3, maxEntries = 800, includeSymbols = false, symbolMaxFiles = 500, symbolMaxMatches = 2000, refresh = false } = {}) {
    const cached = await readRepoIndex();
    if (!refresh && indexMatches(cached, rootDir) && treeCovers(cached, { depth, maxEntries })) {
      if (includeSymbols && !symbolsCover(cached, { maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches })) {
        const seeded = relEntriesToAbs(rootDir, cached.tree?.entries || []);
        cached.symbols = await scanSymbols(rootDir, { files: seeded, maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches }).catch(() => []);
        cached.symbols_meta = { max_files: symbolMaxFiles, max_matches: symbolMaxMatches };
        cached.ts = isoNow();
        cached.generated_at = cached.ts;
        await writeRepoIndex(cached);
      }
      return { ...cached, cached: true };
    }

    const [profile, treePack, importantFiles, git] = await Promise.all([
      detectProjectProfile(rootDir).catch(() => ({ languages: [], frameworks: [], packageManagers: [], manifests: [], scripts: {} })),
      buildTreeFast(rootDir, depth, maxEntries),
      collectImportantFiles(rootDir).catch(() => []),
      compactGitStatus(rootDir)
    ]);
    const treeEntries = treePack.tree.map(toRel).slice(0, maxEntries);
    const symbols = includeSymbols
      ? await scanSymbols(rootDir, { files: treePack.files, maxFiles: symbolMaxFiles, maxMatches: symbolMaxMatches }).catch(() => [])
      : undefined;
    const ts = isoNow();
    const next = {
      ts,
      generated_at: ts,
      rootDir,
      ttl_ms: REPO_INDEX_TTL_MS,
      profile: { rootDir, ...profile },
      tree: {
        depth,
        max_entries: maxEntries,
        engine: treePack.engine || "scan",
        dirs: treePack.dirs.length,
        files: treePack.files.length,
        truncated: treePack.tree.length >= maxEntries,
        entries: treeEntries
      },
      important_files: importantFiles.slice(0, 120),
      git,
      ripgrep_status: { available: Boolean(RG_BIN), bin: RG_BIN || null },
      symbols,
      symbols_meta: includeSymbols ? { max_files: symbolMaxFiles, max_matches: symbolMaxMatches } : undefined
    };
    await writeRepoIndex(next);
    return { ...next, cached: false };
  }


  return {
    buildRepoIndex, indexFresh, indexMatches, readRepoIndex, relEntriesToAbs, symbolsCover,
    treeCovers, writeRepoIndex
  };
}
