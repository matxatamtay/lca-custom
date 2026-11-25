import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export function createSkillToolRegistrar(options) {
  const { reg, jsonResult, defaultSkillsDir, discoverSkills, isWithinSkillsDir, resolvePath, sanitizeSkillName, MAX_READ_CHARS, PRIMARY_ROOT } = options;

  function registerSkillTools(mcp) {
    reg(
      mcp,
      "list_skills",
      {
        title: "List skills",
        description: "List reusable skills (playbooks) available to load. Call this when a task might match a skill; it is cheap (names + descriptions only).",
        inputSchema: {}
      },
      async () => {
        const skills = await discoverSkills();
        return jsonResult({
          count: skills.length,
          skills: skills.map((s) => ({ name: s.name, description: s.description }))
        });
      }
    );

    reg(
      mcp,
      "read_skill",
      {
        title: "Read skill",
        description: "Load a skill's full instructions (SKILL.md) and its bundled file list. Call before doing work the skill covers.",
        inputSchema: { name: z.string().min(1).describe("Skill name from list_skills.") }
      },
      async ({ name }) => {
        const skills = await discoverSkills();
        const skill = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
        if (!skill) throw new Error(`No skill named "${name}". Use list_skills to see available skills.`);
        const body = await readFile(skill.skillFile, "utf8");
        let files = [];
        try {
          files = (await readdir(skill.dir)).filter((f) => f.toLowerCase() !== "skill.md");
        } catch {
          /* ignore */
        }
        return jsonResult({ name: skill.name, dir: skill.dir, files, content: body.slice(0, MAX_READ_CHARS) });
      }
    );

    reg(
      mcp,
      "create_skill",
      {
        title: "Create skill",
        description: "Author a reusable skill: writes <skillsdir>/<name>/SKILL.md with YAML frontmatter (name, description) plus your body. Default skillsdir is <PRIMARY_ROOT>/.claude/skills. After this, list_skills will show it.",
        inputSchema: {
          name: z.string().min(1).describe("Skill name (folder + frontmatter name), e.g. \"deploy-web\"."),
          description: z.string().min(1).describe("One-line description shown by list_skills."),
          body: z.string().describe("Markdown body of the skill (instructions). Written below the frontmatter."),
          dir: z.string().optional().describe("Skills directory to write into. Relative paths resolve from the primary project; absolute paths are accepted. Default <PRIMARY_ROOT>/.claude/skills.")
        }
      },
      async ({ name, description, body, dir }) => {
        const folderName = sanitizeSkillName(name);
        if (!folderName) throw new Error("Invalid skill name. Use letters, digits, dot, dash or underscore.");
        const skillsDir = resolvePath(dir || defaultSkillsDir());
        const skillFolder = path.join(skillsDir, folderName);
        // Keep writes within a recognised skills dir (defense in depth).
        if (!isWithinSkillsDir(skillFolder)) {
          throw new Error("Refusing to write outside a skills directory.");
        }
        const skillFile = path.join(skillFolder, "SKILL.md");
        const frontName = String(name).replace(/"/g, '\\"');
        const frontDesc = String(description).replace(/\r?\n/g, " ").replace(/"/g, '\\"');
        const content = `---\nname: "${frontName}"\ndescription: "${frontDesc}"\n---\n\n${body || ""}${body && !body.endsWith("\n") ? "\n" : ""}`;
        await mkdir(skillFolder, { recursive: true });
        await writeFile(skillFile, content, "utf8");
        return jsonResult({ ok: true, name: folderName, dir: skillFolder, skill_file: skillFile });
      }
    );

    reg(
      mcp,
      "delete_skill",
      {
        title: "Delete skill",
        description: "Delete a skill folder (the directory holding its SKILL.md). Only removes folders located inside a skills directory.",
        inputSchema: {
          name: z.string().min(1).describe("Skill name from list_skills."),
          dir: z.string().optional().describe("Skills directory to inspect. Relative paths resolve from the primary project; absolute paths are accepted. Default <PRIMARY_ROOT>/.claude/skills.")
        }
      },
      async ({ name, dir }) => {
        const skills = await discoverSkills();
        let target = null;
        const hit = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
        if (hit) {
          target = hit.dir;
        } else {
          const folderName = sanitizeSkillName(name);
          if (folderName) target = path.join(resolvePath(dir || defaultSkillsDir()), folderName);
        }
        if (!target) throw new Error(`No skill named "${name}".`);
        const resolved = resolvePath(target);
        if (!isWithinSkillsDir(resolved)) {
          throw new Error("Refusing to delete a folder that is not inside a skills directory.");
        }
        if (!existsSync(resolved)) throw new Error(`No skill folder at ${resolved}.`);
        await rm(resolved, { recursive: true, force: true });
        return jsonResult({ ok: true, deleted: resolved });
      }
    );
  }

  // First workspace skills dir for authoring: <PRIMARY_ROOT>/.claude/skills.

  return registerSkillTools;
}
