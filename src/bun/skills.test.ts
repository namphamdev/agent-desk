import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listSkills,
  loadSkillsState,
  parseSkillFrontmatter,
  setSkillEnabled,
  uninstallSkill,
  type SkillsPaths,
} from "./skills";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(root: string, id: string, name?: string, desc?: string) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name ?? id}
description: ${desc ?? `Help with ${id}`}
---

# ${name ?? id}
`,
  );
  return dir;
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description", () => {
    const meta = parseSkillFrontmatter(`---
name: frontend-design
description: Build beautiful UIs
---
body`);
    expect(meta.name).toBe("frontend-design");
    expect(meta.description).toBe("Build beautiful UIs");
  });

  it("handles quoted description", () => {
    const meta = parseSkillFrontmatter(`---
name: github
description: "Use the gh CLI for issues and PRs"
---
`);
    expect(meta.description).toBe("Use the gh CLI for issues and PRs");
  });

  it("returns empty without frontmatter", () => {
    expect(parseSkillFrontmatter("# No frontmatter")).toEqual({});
  });
});

describe("skills manager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function setup(): SkillsPaths {
    const dataDir = tempDir("tr-skills-data-");
    const skillsRoot = tempDir("tr-skills-root-");
    // Path must include ".claude" so enable restores the preferred agent link.
    const claudeSkills = join(tempDir("tr-home-"), ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    dirs.push(dataDir, skillsRoot, dirname(dirname(claudeSkills)));
    return {
      skillsRoot,
      dataDir,
      agentSkillDirs: [claudeSkills],
    };
  }

  it("lists installed skills with metadata", () => {
    const paths = setup();
    writeSkill(paths.skillsRoot, "research", "research", "Deep research workflow");
    writeSkill(paths.skillsRoot, "ask", "ask", "Quick answers");

    const skills = listSkills(paths);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.id).sort()).toEqual(["ask", "research"]);
    expect(skills.find((s) => s.id === "research")?.description).toContain(
      "Deep research",
    );
    expect(skills.every((s) => s.enabled)).toBe(true);
  });

  it("ignores non-skill entries", () => {
    const paths = setup();
    writeSkill(paths.skillsRoot, "real-skill");
    writeFileSync(join(paths.skillsRoot, "notes.txt"), "nope");
    mkdirSync(join(paths.skillsRoot, "empty-dir"));
    writeFileSync(join(paths.skillsRoot, "pack.skill"), "zip-like");

    expect(listSkills(paths).map((s) => s.id)).toEqual(["real-skill"]);
  });

  it("disables a skill by moving it under .disabled and unlinking agents", () => {
    const paths = setup();
    const skillPath = writeSkill(paths.skillsRoot, "research");
    const claudeLink = join(paths.agentSkillDirs![0]!, "research");
    symlinkSync(skillPath, claudeLink);
    expect(existsSync(claudeLink)).toBe(true);

    const res = setSkillEnabled(paths, "research", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skill.enabled).toBe(false);
    expect(res.skill.path).toContain(".disabled");
    expect(existsSync(join(paths.skillsRoot, "research"))).toBe(false);
    expect(existsSync(join(paths.skillsRoot, ".disabled", "research"))).toBe(
      true,
    );
    expect(existsSync(claudeLink)).toBe(false);

    const listed = listSkills(paths);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.enabled).toBe(false);
    expect(loadSkillsState(paths.dataDir).disabled).toContain("research");
  });

  it("re-enables a skill and restores Claude symlink", () => {
    const paths = setup();
    writeSkill(paths.skillsRoot, "research");
    setSkillEnabled(paths, "research", false);

    const res = setSkillEnabled(paths, "research", true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skill.enabled).toBe(true);
    expect(existsSync(join(paths.skillsRoot, "research", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(paths.skillsRoot, ".disabled", "research"))).toBe(
      false,
    );
    const claudeLink = join(paths.agentSkillDirs![0]!, "research");
    expect(existsSync(claudeLink)).toBe(true);
    expect(loadSkillsState(paths.dataDir).disabled).not.toContain("research");
  });

  it("uninstalls a skill", () => {
    const paths = setup();
    writeSkill(paths.skillsRoot, "research");
    writeSkill(paths.skillsRoot, "ask");

    const res = uninstallSkill(paths, "research");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skills.map((s) => s.id)).toEqual(["ask"]);
    expect(existsSync(join(paths.skillsRoot, "research"))).toBe(false);
  });

  it("rejects invalid skill ids", () => {
    const paths = setup();
    expect(setSkillEnabled(paths, "../etc", false).ok).toBe(false);
    expect(setSkillEnabled(paths, "", true).ok).toBe(false);
    expect(uninstallSkill(paths, "missing").ok).toBe(false);
  });

  it("lists project-scoped skills", () => {
    const paths = setup();
    const project = tempDir("tr-project-");
    dirs.push(project);
    writeSkill(paths.skillsRoot, "global-one");
    writeSkill(join(project, ".agents", "skills"), "project-one");

    const skills = listSkills({ ...paths, projectCwd: project });
    expect(skills.map((s) => s.id).sort()).toEqual([
      "global-one",
      "project-one",
    ]);
    expect(skills.find((s) => s.id === "project-one")?.scope).toBe("project");
  });

  it("persists disabled state to disk", () => {
    const paths = setup();
    writeSkill(paths.skillsRoot, "research");
    setSkillEnabled(paths, "research", false);
    const raw = readFileSync(join(paths.dataDir, "skills-state.json"), "utf8");
    expect(JSON.parse(raw).disabled).toEqual(["research"]);
    // listing after reload still sees disabled
    expect(listSkills(paths)[0]!.enabled).toBe(false);
    // ensure dir listing still has the skill under .disabled
    expect(readdirSync(join(paths.skillsRoot, ".disabled"))).toContain(
      "research",
    );
  });
});
