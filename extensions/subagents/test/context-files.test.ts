/**
 * Tests for context-files frontmatter discovery and project-context block building.
 * Uses temporary directories and git repos.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

const testApi = (subagentsModule as any).__test__;
const {
  findGitRootSync,
  collectProjectContextFiles,
  buildProjectContextBlock,
  resolveEffectiveContextFiles,
} = testApi;

// ── resolveEffectiveContextFiles ──
console.log("\n🧪 resolveEffectiveContextFiles");

assert(
  resolveEffectiveContextFiles(null) === "all",
  "null agentDefs → default 'all'",
);
assert(
  resolveEffectiveContextFiles({}) === "all",
  "empty agentDefs → default 'all'",
);
assert(
  resolveEffectiveContextFiles({ contextFiles: "project" }) === "project",
  "contextFiles: project → project",
);
assert(
  resolveEffectiveContextFiles({ contextFiles: "none" }) === "none",
  "contextFiles: none → none",
);
assert(
  resolveEffectiveContextFiles({ contextFiles: "all" }) === "all",
  "contextFiles: all → all",
);

// ── findGitRootSync ──
console.log("\n🧪 findGitRootSync");

const tmpBase = mkdtempSync(join(tmpdir(), "pi-ctx-test-"));

try {
  // Use the filesystem root so an ambient /tmp/.git cannot invalidate the test.
  const noGit = findGitRootSync("/");
  assert(noGit === null, "filesystem root without .git returns null");

  // In a git repo
  const repoDir = join(tmpBase, "repo");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, ".git"));

  const root = findGitRootSync(repoDir);
  assert(root === repoDir, "git repo root matches");

  // Subdirectory within git repo
  const subDir = join(repoDir, "a", "b");
  mkdirSync(subDir, { recursive: true });
  const subRoot = findGitRootSync(subDir);
  assert(subRoot === repoDir, "subdir inside git repo returns repo root");

} finally {
  rmSync(tmpBase, { recursive: true, force: true });
}

// ── collectProjectContextFiles ──
console.log("\n🧪 collectProjectContextFiles");

const tmpCtxBase = mkdtempSync(join(tmpdir(), "pi-ctx-collect-"));

try {
  // No context file in the discovered directory chain
  const noGitNoCtx = join(tmpCtxBase, "nocontext");
  mkdirSync(noGitNoCtx, { recursive: true });
  const emptyResult = collectProjectContextFiles(noGitNoCtx);
  assert(emptyResult.length === 0, "no git repo, no context file → empty");

  // AGENTS.md in cwd
  const noGitWithCtx = join(tmpCtxBase, "withctx");
  mkdirSync(noGitWithCtx, { recursive: true });
  writeFileSync(join(noGitWithCtx, "AGENTS.md"), "# Project rules", "utf8");
  const singleResult = collectProjectContextFiles(noGitWithCtx);
  assert(singleResult.length === 1, "no git repo, has AGENTS.md → 1 file");
  assert(singleResult[0].file.endsWith("AGENTS.md"), "file is AGENTS.md");
  assert(
    singleResult[0].dir === noGitWithCtx,
    "dir is the working directory",
  );

  // CLAUDE.md loses precedence when AGENTS.md is also present
  const noGitPrecedence = join(tmpCtxBase, "precedence");
  mkdirSync(noGitPrecedence, { recursive: true });
  writeFileSync(join(noGitPrecedence, "AGENTS.md"), "# AGENTS", "utf8");
  writeFileSync(join(noGitPrecedence, "CLAUDE.md"), "# Claude", "utf8");
  const precResult = collectProjectContextFiles(noGitPrecedence);
  assert(precResult.length === 1, "both AGENTS and CLAUDE → only 1 file");
  assert(
    precResult[0].file.endsWith("AGENTS.md"),
    "AGENTS.md takes precedence over CLAUDE.md",
  );

  // In a git repo, with context files at root and subdir
  const gitCtxRepo = join(tmpCtxBase, "gitctx");
  mkdirSync(gitCtxRepo, { recursive: true });
  mkdirSync(join(gitCtxRepo, ".git"));

  writeFileSync(join(gitCtxRepo, "AGENTS.md"), "# Root rules", "utf8");
  const srcDir = join(gitCtxRepo, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "CLAUDE.md"), "# Src rules", "utf8");

  const gitCtxResult = collectProjectContextFiles(srcDir);
  assert(gitCtxResult.length === 2, "git root + subdir → 2 files");
  assert(
    gitCtxResult[0].file.endsWith("AGENTS.md"),
    "first file is root AGENTS.md",
  );
  assert(
    gitCtxResult[1].file.endsWith("CLAUDE.md"),
    "second file is src CLAUDE.md",
  );
  assert(gitCtxResult[0].dir === gitCtxRepo, "first dir is git root");
  assert(gitCtxResult[1].dir === srcDir, "second dir is src");
} finally {
  rmSync(tmpCtxBase, { recursive: true, force: true });
}

// ── buildProjectContextBlock ──
console.log("\n🧪 buildProjectContextBlock");

assert(buildProjectContextBlock([]) === "", "empty array → empty string");

const tmpBuildBase = mkdtempSync(join(tmpdir(), "pi-ctx-build-"));

try {
  // Single file
  const tempFile = join(tmpBuildBase, "AGENTS.md");
  mkdirSync(tmpBuildBase, { recursive: true });
  writeFileSync(tempFile, "# Project rules", "utf8");

  const single = buildProjectContextBlock([{ dir: tmpBuildBase, file: tempFile }]);
  assert(
    single.includes("<project_context>") && single.includes("</project_context>"),
    "single file wraps in project_context tags",
  );
  assert(
    single.includes(`<project_instructions path="${tempFile}">`),
    "single file includes path in project_instructions",
  );
  assert(
    single.includes("Project rules"),
    "single file includes content",
  );

  // Multiple files
  const tempFile2 = join(tmpBuildBase, "CLAUDE.md");
  writeFileSync(tempFile2, "# Claude rules", "utf8");

  const multi = buildProjectContextBlock([
    { dir: tmpBuildBase, file: tempFile },
    { dir: tmpBuildBase, file: tempFile2 },
  ]);
  assert(multi.includes("Project rules"), "multi includes first file content");
  assert(multi.includes("Claude rules"), "multi includes second file content");
  assert(
    (multi.match(/<project_context>/g) ?? []).length === 1,
    "multiple files share one project_context wrapper",
  );
  assert(
    multi.includes("Project-specific instructions and guidelines:"),
    "block matches Pi's project-context heading",
  );
  assert(
    buildProjectContextBlock([{ dir: tmpBuildBase, file: join(tmpBuildBase, "missing.md") }]) === "",
    "unreadable context files are skipped",
  );
} finally {
  rmSync(tmpBuildBase, { recursive: true, force: true });
}

// ── Summary ──
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All tests passed! ✅\n");
