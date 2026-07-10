/**
 * Skills manager: list, install, enable/disable agent skills (SKILL.md packages).
 *
 * Skills live under `~/.agents/skills/<name>/`. Disabled skills are moved to
 * `~/.agents/skills/.disabled/<name>/` so agent discovery skips them. A small
 * state file under the app data dir records the disabled set for resilience.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type SkillInfo = {
  /** Directory name / slug (unique id). */
  id: string;
  /** Display name from SKILL.md frontmatter (falls back to id). */
  name: string;
  description: string;
  /** Absolute path to the skill directory. */
  path: string;
  enabled: boolean;
  /** global = user-level skills root; project = under a project skills folder */
  scope: "global" | "project";
};

export type SkillsState = {
  /** Skill ids that should be treated as disabled. */
  disabled: string[];
};

export type SkillsPaths = {
  /** User-level skills root (default: ~/.agents/skills). */
  skillsRoot: string;
  /** App data dir for skills-state.json. */
  dataDir: string;
  /** Optional project cwd for project-scoped skills. */
  projectCwd?: string | null;
  /** Agent dirs that may hold symlinks into the skills root. */
  agentSkillDirs?: string[];
};

const DISABLED_DIR_NAME = ".disabled";

export function defaultSkillsRoot(): string {
  return join(homedir(), ".agents", "skills");
}

export function defaultAgentSkillDirs(): string[] {
  return [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".gemini", "skills"),
    join(homedir(), ".config", "opencode", "skills"),
  ];
}

function defaultState(): SkillsState {
  return { disabled: [] };
}

export function skillsStatePath(dataDir: string): string {
  return join(dataDir, "skills-state.json");
}

export function loadSkillsState(dataDir: string): SkillsState {
  try {
    const raw = readFileSync(skillsStatePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillsState>;
    return {
      disabled: Array.isArray(parsed.disabled)
        ? parsed.disabled.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return defaultState();
  }
}

export function saveSkillsState(dataDir: string, state: SkillsState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    skillsStatePath(dataDir),
    JSON.stringify(
      {
        disabled: [...new Set(state.disabled)].sort(),
      },
      null,
      2,
    ),
  );
}

/** Parse YAML-ish frontmatter from SKILL.md (name / description only). */
export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1] ?? "";
  const out: { name?: string; description?: string } = {};
  const nameM = block.match(/^name:\s*(.+)$/m);
  if (nameM) {
    out.name = nameM[1]!.trim().replace(/^["']|["']$/g, "");
  }
  const descM = block.match(
    /^description:\s*(?:>-?\s*)?(?:"([^"]*)"|'([^']*)'|(.+))$/m,
  );
  if (descM) {
    out.description = (descM[1] ?? descM[2] ?? descM[3] ?? "")
      .trim()
      .replace(/\s+/g, " ");
  }
  return out;
}

function readSkillMeta(skillDir: string, id: string): {
  name: string;
  description: string;
} {
  const skillMd = join(skillDir, "SKILL.md");
  try {
    if (existsSync(skillMd)) {
      const text = readFileSync(skillMd, "utf8");
      const meta = parseSkillFrontmatter(text);
      return {
        name: meta.name?.trim() || id,
        description: meta.description?.trim() || "",
      };
    }
  } catch {
    /* ignore */
  }
  return { name: id, description: "" };
}

function isSkillDir(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return false;
    return existsSync(join(path, "SKILL.md"));
  } catch {
    return false;
  }
}

/**
 * List skills under a root directory (enabled + `.disabled/` sibling).
 */
export function scanSkillsRoot(
  enabledRoot: string,
  options?: { scope?: "global" | "project"; dataDir?: string },
): SkillInfo[] {
  const scope = options?.scope ?? "global";
  const disabledRoot = join(enabledRoot, DISABLED_DIR_NAME);
  const stateDisabled = new Set(
    options?.dataDir ? loadSkillsState(options.dataDir).disabled : [],
  );
  const results: SkillInfo[] = [];
  const seen = new Set<string>();

  const collect = (root: string, physicallyEnabled: boolean) => {
    if (!existsSync(root)) return;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (entry.endsWith(".skill") || entry.endsWith(".zip")) continue;
      const full = join(root, entry);
      if (!isSkillDir(full)) continue;
      const id = entry;
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = readSkillMeta(full, id);
      const enabled = physicallyEnabled && !stateDisabled.has(id);
      results.push({
        id,
        name: meta.name,
        description: meta.description,
        path: full,
        enabled,
        scope,
      });
    }
  };

  collect(enabledRoot, true);
  collect(disabledRoot, false);

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

export function listSkills(paths: SkillsPaths): SkillInfo[] {
  const global = scanSkillsRoot(paths.skillsRoot, {
    scope: "global",
    dataDir: paths.dataDir,
  });
  const byId = new Map(global.map((s) => [s.id, s]));

  if (paths.projectCwd) {
    const projectRoots = [
      join(paths.projectCwd, ".agents", "skills"),
      join(paths.projectCwd, ".claude", "skills"),
    ];
    for (const root of projectRoots) {
      for (const s of scanSkillsRoot(root, {
        scope: "project",
        dataDir: paths.dataDir,
      })) {
        if (!byId.has(s.id)) byId.set(s.id, s);
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function removeAgentSymlinks(
  skillId: string,
  skillPath: string,
  agentDirs: string[],
): void {
  const resolvedSkill = resolve(skillPath);
  for (const agentDir of agentDirs) {
    const linkPath = join(agentDir, skillId);
    try {
      let st;
      try {
        st = lstatSync(linkPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(linkPath), readlinkSync(linkPath));
        if (target === resolvedSkill || basename(target) === skillId) {
          rmSync(linkPath, { force: true });
        }
      }
    } catch {
      /* ignore per-agent failures */
    }
  }
}

function ensureAgentSymlink(
  skillId: string,
  skillPath: string,
  agentDir: string,
): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    const linkPath = join(agentDir, skillId);
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(linkPath), readlinkSync(linkPath));
        if (target === resolve(skillPath)) return;
        rmSync(linkPath, { force: true });
      } else if (st.isDirectory()) {
        return;
      }
    } catch {
      /* does not exist */
    }
    symlinkSync(skillPath, linkPath);
  } catch (err) {
    console.warn(`[skills] failed to link into ${agentDir}:`, err);
  }
}

/**
 * Enable or disable a skill. Disabled skills are moved under `.disabled/` so
 * agent discovery no longer sees them; agent symlinks are updated accordingly.
 */
export function setSkillEnabled(
  paths: SkillsPaths,
  skillId: string,
  enabled: boolean,
): { ok: true; skill: SkillInfo } | { ok: false; error: string } {
  const id = skillId.trim();
  if (!id || id.includes("/") || id.includes("..") || id.startsWith(".")) {
    return { ok: false, error: "Invalid skill id" };
  }

  const skillsRoot = paths.skillsRoot;
  const agentDirs = paths.agentSkillDirs ?? defaultAgentSkillDirs();
  const enabledPath = join(skillsRoot, id);
  const disabledPath = join(skillsRoot, DISABLED_DIR_NAME, id);
  const state = loadSkillsState(paths.dataDir);

  const currentlyAt = existsSync(enabledPath)
    ? enabledPath
    : existsSync(disabledPath)
      ? disabledPath
      : null;

  if (!currentlyAt) {
    return { ok: false, error: `Skill not found: ${id}` };
  }

  try {
    if (enabled) {
      if (currentlyAt === disabledPath) {
        mkdirSync(skillsRoot, { recursive: true });
        if (existsSync(enabledPath)) {
          return {
            ok: false,
            error: `Cannot enable: ${id} already exists in skills folder`,
          };
        }
        renameSync(disabledPath, enabledPath);
      }
      state.disabled = state.disabled.filter((x) => x !== id);
      saveSkillsState(paths.dataDir, state);
      // Restore agent-facing symlink (prefer Claude Code path, else first configured dir).
      const linkDir =
        agentDirs.find((d) => d.includes(".claude")) ?? agentDirs[0];
      if (linkDir) ensureAgentSymlink(id, enabledPath, linkDir);
      const meta = readSkillMeta(enabledPath, id);
      return {
        ok: true,
        skill: {
          id,
          name: meta.name,
          description: meta.description,
          path: enabledPath,
          enabled: true,
          scope: "global",
        },
      };
    }

    // Disable
    if (currentlyAt === enabledPath) {
      mkdirSync(join(skillsRoot, DISABLED_DIR_NAME), { recursive: true });
      if (existsSync(disabledPath)) {
        rmSync(enabledPath, { recursive: true, force: true });
      } else {
        renameSync(enabledPath, disabledPath);
      }
    }
    removeAgentSymlinks(id, enabledPath, agentDirs);
    removeAgentSymlinks(id, disabledPath, agentDirs);
    if (!state.disabled.includes(id)) state.disabled.push(id);
    saveSkillsState(paths.dataDir, state);
    const finalPath = existsSync(disabledPath) ? disabledPath : currentlyAt;
    const meta = readSkillMeta(finalPath, id);
    return {
      ok: true,
      skill: {
        id,
        name: meta.name,
        description: meta.description,
        path: finalPath,
        enabled: false,
        scope: "global",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Install a skill via the Skills CLI (`npx skills add`).
 * Package examples: `vercel-labs/agent-skills@frontend-design`,
 * `owner/repo`, or a GitHub URL.
 */
export async function installSkill(
  paths: SkillsPaths,
  packageSpec: string,
): Promise<{ ok: true; skills: SkillInfo[] } | { ok: false; error: string }> {
  const spec = packageSpec.trim();
  if (!spec) return { ok: false, error: "Package is required" };
  if (/[;&|`$(){}<>\n\r]/.test(spec)) {
    return { ok: false, error: "Invalid package specification" };
  }

  const before = new Set(listSkills(paths).map((s) => s.id));

  try {
    const proc = Bun.spawn(
      [
        "npx",
        "--yes",
        "skills",
        "add",
        spec,
        "-g",
        "-y",
        "-a",
        "claude-code",
      ],
      {
        cwd: homedir(),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CI: "1" },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const detail = (stderr || stdout || `exit ${exitCode}`).trim();
      return {
        ok: false,
        error: detail.slice(0, 800) || `skills add failed (exit ${exitCode})`,
      };
    }

    const after = listSkills(paths);
    const state = loadSkillsState(paths.dataDir);
    let changed = false;
    const agentDirs = paths.agentSkillDirs ?? defaultAgentSkillDirs();
    const linkDir =
      agentDirs.find((d) => d.includes(".claude")) ?? agentDirs[0];
    for (const s of after) {
      if (!before.has(s.id) && state.disabled.includes(s.id)) {
        state.disabled = state.disabled.filter((x) => x !== s.id);
        changed = true;
      }
      if (!before.has(s.id) && s.enabled && linkDir) {
        ensureAgentSymlink(s.id, s.path, linkDir);
      }
    }
    if (changed) saveSkillsState(paths.dataDir, state);

    return { ok: true, skills: listSkills(paths) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Uninstall a skill by removing its directory and agent symlinks.
 */
export function uninstallSkill(
  paths: SkillsPaths,
  skillId: string,
): { ok: true; skills: SkillInfo[] } | { ok: false; error: string } {
  const id = skillId.trim();
  if (!id || id.includes("/") || id.includes("..") || id.startsWith(".")) {
    return { ok: false, error: "Invalid skill id" };
  }

  const enabledPath = join(paths.skillsRoot, id);
  const disabledPath = join(paths.skillsRoot, DISABLED_DIR_NAME, id);
  const found = [enabledPath, disabledPath].filter((p) => existsSync(p));

  if (found.length === 0) {
    return { ok: false, error: `Skill not found: ${id}` };
  }

  try {
    const agentDirs = paths.agentSkillDirs ?? defaultAgentSkillDirs();
    for (const p of found) {
      removeAgentSymlinks(id, p, agentDirs);
      rmSync(p, { recursive: true, force: true });
    }
    const state = loadSkillsState(paths.dataDir);
    state.disabled = state.disabled.filter((x) => x !== id);
    saveSkillsState(paths.dataDir, state);
    return { ok: true, skills: listSkills(paths) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Build default paths for the running desktop app. */
export function appSkillsPaths(
  dataDir: string,
  projectCwd?: string | null,
): SkillsPaths {
  return {
    skillsRoot: defaultSkillsRoot(),
    dataDir,
    projectCwd: projectCwd ?? null,
    agentSkillDirs: defaultAgentSkillDirs(),
  };
}

export const _test = {
  DISABLED_DIR_NAME,
  isSkillDir,
};
