import { readFile } from "node:fs/promises";
import path from "node:path";

export function createWorkspaceProfile(options) {
  const { PRIMARY_ROOT, detectTestCommands, jsonResult, log, reg } = options;
  let profile = null;

  async function loadWorkspaceProfile() {
    const profilePath = path.join(PRIMARY_ROOT, ".agent", "profile.json");
    try {
      const raw = await readFile(profilePath, "utf8");
      profile = JSON.parse(raw);
      log(`Loaded workspace profile from ${profilePath}`);
    } catch {
      profile = null;
    }
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
        if (!profile) {
          return jsonResult({
            loaded: false,
            path: path.join(PRIMARY_ROOT, ".agent", "profile.json"),
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
        return jsonResult({ loaded: true, profile: profile });
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
        await loadWorkspaceProfile();
        return jsonResult({ ok: true, loaded: profile !== null, profile: profile });
      }
    );
  }

  async function getTestCommandsMerged(rootDir) {
    const detected = await detectTestCommands(rootDir);
    if (profile && profile.testCommands) {
      return { ...detected, ...profile.testCommands };
    }
    return detected;
  }


  return { loadWorkspaceProfile, registerProfileTools, getTestCommandsMerged };
}
