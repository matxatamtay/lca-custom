import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function createNotesSkills(options) {
  const { NOTES_PATH, PRIMARY_ROOT, ROOTS, SKILLS_DIRS } = options;

  async function readNotes() {
    try {
      return JSON.parse(await readFile(NOTES_PATH, "utf8"));
    } catch {
      return [];
    }
  }

  async function writeNotes(notes) {
    await mkdir(path.dirname(NOTES_PATH), { recursive: true });
    await writeFile(NOTES_PATH, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
  }

  // ----------------------------------------------------------------------------
  // Skills (Claude-style on-demand playbooks)
  // ----------------------------------------------------------------------------
  async function discoverSkills() {
    const found = [];
    const seen = new Set();
    for (const base of SKILLS_DIRS) {
      let entries;
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch {
        continue; // dir doesn't exist
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(base, e.name);
        let skillFile = null;
        try {
          const files = await readdir(dir);
          const hit = files.find((f) => f.toLowerCase() === "skill.md");
          if (hit) skillFile = path.join(dir, hit);
        } catch {
          continue;
        }
        if (!skillFile) continue;
        let meta;
        try {
          meta = parseSkillMeta(await readFile(skillFile, "utf8"), e.name);
        } catch {
          meta = { name: e.name, description: "" };
        }
        const key = meta.name.toLowerCase();
        if (seen.has(key)) continue; // first source wins
        seen.add(key);
        found.push({ name: meta.name, description: meta.description, dir, skillFile });
      }
    }
    return found;
  }

  function parseSkillMeta(text, fallbackName) {
    text = text.replace(/^﻿/, ""); // strip UTF-8 BOM (some Windows editors add it)
    let name = fallbackName;
    let description = "";
    const fm = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
    if (fm) {
      const block = fm[1];
      const n = block.match(/^\s*name\s*:\s*(.+?)\s*$/im);
      const d = block.match(/^\s*description\s*:\s*(.+?)\s*$/im);
      if (n) name = n[1].replace(/^["']|["']$/g, "").trim();
      if (d) description = d[1].replace(/^["']|["']$/g, "").trim();
    }
    if (!description) {
      const body = fm ? text.slice(fm[0].length) : text;
      const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      if (firstLine) description = firstLine.slice(0, 200);
    }
    return { name, description };
  }


  function defaultSkillsDir() {
    return path.join(PRIMARY_ROOT, ".claude", "skills");
  }

  // Skill folder names: keep them simple path segments (no separators / traversal).
  function sanitizeSkillName(name) {
    const s = String(name || "").trim();
    if (!s || s === "." || s === "..") return "";
    if (/[\\/]/.test(s) || !/^[\w.-]+$/.test(s)) return "";
    return s;
  }

  // A path is "inside a skills directory" if any segment of its parent chain is a
  // known skills dir (from SKILLS_DIRS) or matches the .claude/skills | .agent/skills
  // convention under a root. Used to confine create/delete to skills areas.
  function isWithinSkillsDir(p) {
    const parent = path.dirname(p);
    const candidates = new Set(SKILLS_DIRS.map((d) => path.resolve(d)));
    candidates.add(path.resolve(defaultSkillsDir()));
    for (const root of ROOTS) {
      candidates.add(path.resolve(path.join(root, ".claude", "skills")));
      candidates.add(path.resolve(path.join(root, ".agent", "skills")));
    }
    return candidates.has(path.resolve(parent));
  }


  // ----------------------------------------------------------------------------
  // Companion UI tools: @ context picker and / workflow command palette
  // ----------------------------------------------------------------------------

  return { defaultSkillsDir, discoverSkills, isWithinSkillsDir, readNotes, sanitizeSkillName, writeNotes };
}
