import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjectHarness,
  CLAUDE_MD_AGENTS_REF,
  containsAgentsMdRef,
  containsKarpathyGuidelines,
  getProjectHarness,
  KARPATHY_AGENTS_MD,
} from "./project-harness";

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tr-harness-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("containsKarpathyGuidelines", () => {
  it("detects the full guideline set", () => {
    expect(containsKarpathyGuidelines(KARPATHY_AGENTS_MD)).toBe(true);
  });

  it("rejects partial content", () => {
    expect(containsKarpathyGuidelines("## 1. Think Before Coding\nonly")).toBe(
      false,
    );
  });
});

describe("containsAgentsMdRef", () => {
  it("detects @AGENTS.md pointer", () => {
    expect(containsAgentsMdRef("@AGENTS.md\n")).toBe(true);
    expect(containsAgentsMdRef("See @AGENTS.md for rules")).toBe(true);
    expect(containsAgentsMdRef("# Project only")).toBe(false);
  });
});

describe("getProjectHarness", () => {
  it("reports missing folder", () => {
    const h = getProjectHarness("/tmp/does-not-exist-tr-harness-xyz", "x");
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/not found/i);
  });

  it("reports empty project without optimizations", () => {
    const cwd = tempDir();
    const h = getProjectHarness(cwd, "demo");
    expect(h.ok).toBe(true);
    expect(h.project).toBe("demo");
    expect(h.hasClaudeMd).toBe(false);
    expect(h.hasAgentsMd).toBe(false);
    expect(h.appliedCount).toBe(0);
    expect(h.optimizations[0]?.id).toBe("karpathy-guidelines");
    expect(h.optimizations[0]?.applied).toBe(false);
  });

  it("detects existing AGENTS.md guidelines", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "AGENTS.md"), KARPATHY_AGENTS_MD, "utf8");
    writeFileSync(join(cwd, "CLAUDE.md"), `${CLAUDE_MD_AGENTS_REF}\n`, "utf8");
    const h = getProjectHarness(cwd);
    expect(h.hasAgentsMd).toBe(true);
    expect(h.hasClaudeMd).toBe(true);
    expect(h.optimizations[0]?.applied).toBe(true);
    expect(h.optimizations[0]?.details).toContain("AGENTS.md");
    expect(h.optimizations[0]?.details).toContain("CLAUDE.md → @AGENTS.md");
  });
});

describe("applyProjectHarness", () => {
  it("writes AGENTS.md + CLAUDE.md pointer and skill packages on empty project", () => {
    const cwd = tempDir();
    const res = applyProjectHarness(cwd, "karpathy-guidelines", "demo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.written).toContain("AGENTS.md");
    expect(res.written).toContain("CLAUDE.md");
    expect(
      res.written.some((w) => w.includes("karpathy-guidelines")),
    ).toBe(true);

    const agentsText = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const claudeText = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(containsKarpathyGuidelines(agentsText)).toBe(true);
    expect(containsAgentsMdRef(claudeText)).toBe(true);
    expect(claudeText.trim()).toBe(CLAUDE_MD_AGENTS_REF);
    // Full guidelines live in AGENTS.md, not duplicated into CLAUDE.md.
    expect(containsKarpathyGuidelines(claudeText)).toBe(false);

    const agentsSkill = join(
      cwd,
      ".agents",
      "skills",
      "karpathy-guidelines",
    );
    const claudeSkill = join(
      cwd,
      ".claude",
      "skills",
      "karpathy-guidelines",
    );
    expect(existsSync(join(agentsSkill, "SKILL.md"))).toBe(true);
    expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(true);
    expect(realpathSync(claudeSkill)).toBe(realpathSync(agentsSkill));
    expect(res.harness.appliedCount).toBe(1);
  });

  it("replaces a duplicate .claude skill copy with a symlink", () => {
    const cwd = tempDir();
    const agentsSkill = join(cwd, ".agents", "skills", "karpathy-guidelines");
    const claudeSkill = join(cwd, ".claude", "skills", "karpathy-guidelines");
    mkdirSync(agentsSkill, { recursive: true });
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(agentsSkill, "SKILL.md"), "---\nname: karpathy-guidelines\n---\n", "utf8");
    writeFileSync(join(claudeSkill, "SKILL.md"), "duplicate copy\n", "utf8");

    const res = applyProjectHarness(cwd, "karpathy-guidelines");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(true);
    expect(realpathSync(claudeSkill)).toBe(realpathSync(agentsSkill));
    expect(readlinkSync(claudeSkill)).toBe(
      join("..", "..", ".agents", "skills", "karpathy-guidelines"),
    );
  });

  it("appends guidelines to existing AGENTS.md and points CLAUDE.md at it", () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "AGENTS.md"),
      "# Project\n\nUse TypeScript strict mode.\n",
      "utf8",
    );
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Local notes\n\nPrefer bun.\n",
      "utf8",
    );
    const res = applyProjectHarness(cwd, "karpathy-guidelines");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const agentsText = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agentsText).toContain("Use TypeScript strict mode");
    expect(containsKarpathyGuidelines(agentsText)).toBe(true);

    const claudeText = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(claudeText).toContain("Prefer bun");
    expect(claudeText.startsWith(CLAUDE_MD_AGENTS_REF)).toBe(true);
    expect(containsKarpathyGuidelines(claudeText)).toBe(false);
  });

  it("is idempotent when already applied", () => {
    const cwd = tempDir();
    const first = applyProjectHarness(cwd, "karpathy-guidelines");
    expect(first.ok).toBe(true);
    const second = applyProjectHarness(cwd, "karpathy-guidelines");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.written).not.toContain("AGENTS.md");
    expect(second.written).not.toContain("CLAUDE.md");
    expect(second.harness.appliedCount).toBe(1);
  });

  it("rejects unknown optimization", () => {
    const cwd = tempDir();
    const res = applyProjectHarness(cwd, "not-a-thing");
    expect(res.ok).toBe(false);
  });

  it("detects skill-only install", () => {
    const cwd = tempDir();
    const skillDir = join(cwd, ".agents", "skills", "karpathy-guidelines");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: karpathy-guidelines\n---\n## 1. Think Before Coding\n",
      "utf8",
    );
    const h = getProjectHarness(cwd);
    expect(h.optimizations[0]?.applied).toBe(true);
  });
});
