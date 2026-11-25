import { readFile } from "node:fs/promises";
import path from "node:path";

export function createWorkspaceProfile(options) {
  const { PRIMARY_ROOT, detectTestCommands, jsonResult, log, reg, resolveDefaultRoot = () => PRIMARY_ROOT, projectRootForPath = (root) => root } = options;
  const profiles = new Map();

  async function loadWorkspaceProfile(root = PRIMARY_ROOT) {
    const profilePath = path.join(root, ".agent", "profile.json");
    let profile = null;
    try {
      const raw = await readFile(profilePath, "utf8");
      profile = JSON.parse(raw);
      log(`Loaded workspace profile from ${profilePath}`);
    } catch {
      profile = null;
    }
    profiles.set(root, profile);
    return profile;
  }

  async function profileFor(root) {
    if (!profiles.has(root)) await loadWorkspaceProfile(root);
    return profiles.get(root);
  }

  function registerProfileTools(mcp) {
    reg(
      mcp,
      "profile_status",
      {
        title: "Profile status",
        description: "Return the loaded workspace profile (.agent/profile.json) and explain what it configures.",
        inputSchema: {}
      },
      async () => {
        const root = projectRootForPath(resolveDefaultRoot());
        const profile = await profileFor(root);
        if (!profile) {
          return jsonResult({
            loaded: false,
            path: path.join(root, ".agent", "profile.json"),
            message: "No profile.json found. Create one to configure ignored dirs, conventions, project roots, and optional manual test commands.",
            schema: {
              extraRoots: ["array of extra root paths"],
              testCommands: { test: "command", build: "command", lint: "command" },
              ignoredDirs: ["array of dir names to skip"],
              conventions: "string describing project conventions",
              description: "short project description"
            }
          });
        }
        return jsonResult({ loaded: true, root, profile: profile });
      }
    );

    reg(
      mcp,
      "reload_profile",
      {
        title: "Reload profile",
        description: "Reload .agent/profile.json from disk (e.g. after editing it).",
        inputSchema: {}
      },
      async () => {
        const root = projectRootForPath(resolveDefaultRoot());
        const profile = await loadWorkspaceProfile(root);
        return jsonResult({ ok: true, root, loaded: profile !== null, profile: profile });
      }
    );
  }

  async function getTestCommandsMerged(rootDir) {
    const detected = await detectTestCommands(rootDir);
    const profile = await profileFor(projectRootForPath(rootDir));
    if (profile && profile.testCommands) {
      return { ...detected, ...profile.testCommands };
    }
    return detected;
  }


  return { loadWorkspaceProfile, registerProfileTools, getTestCommandsMerged };
}
