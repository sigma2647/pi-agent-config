import { execSync, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";

export interface HerdrPaneSnapshot {
  paneId: string;
  focused: boolean;
}

export function parseHerdrPaneCurrent(raw: string): HerdrPaneSnapshot | null {
  try {
    const pane = (JSON.parse(raw) as { result?: { pane?: { pane_id?: unknown; focused?: unknown } } })
      .result?.pane;
    if (!pane || typeof pane.pane_id !== "string" || typeof pane.focused !== "boolean") return null;
    return { paneId: pane.pane_id, focused: pane.focused };
  } catch {
    return null;
  }
}

export function isUsableHerdrPane(pane: HerdrPaneSnapshot | null): pane is HerdrPaneSnapshot {
  return pane !== null;
}

export function parseHerdrPaneSplit(raw: string): string | null {
  try {
    const paneId = (JSON.parse(raw) as { result?: { pane?: { pane_id?: unknown } } })
      .result?.pane?.pane_id;
    return typeof paneId === "string" && paneId ? paneId : null;
  } catch {
    return raw.match(/\b[\w-]+:p[\w-]+\b/)?.[0] ?? null;
  }
}

export interface PaneRect {
  paneId: string;
  width: number;
  height: number;
}

export interface HerdrPaneLayout {
  width: number | null;
  workspaceId: string | null;
  panes: PaneRect[];
}

/** Read every pane rect and the workspace from `herdr pane layout --pane <id>`. */
export function parseHerdrPaneLayout(raw: string, paneId: string): HerdrPaneLayout {
  try {
    const layout = (JSON.parse(raw) as {
      result?: {
        layout?: {
          workspace_id?: unknown;
          panes?: Array<{ pane_id?: unknown; rect?: { width?: unknown; height?: unknown } }>;
        };
      };
    }).result?.layout;
    const panes: PaneRect[] = [];
    for (const pane of layout?.panes ?? []) {
      if (typeof pane.pane_id !== "string") continue;
      if (typeof pane.rect?.width !== "number" || typeof pane.rect?.height !== "number") continue;
      panes.push({ paneId: pane.pane_id, width: pane.rect.width, height: pane.rect.height });
    }
    const width = panes.find((pane) => pane.paneId === paneId)?.width;
    const workspaceId = layout?.workspace_id;
    return {
      width: typeof width === "number" ? width : null,
      workspaceId: typeof workspaceId === "string" && workspaceId ? workspaceId : null,
      panes,
    };
  } catch {
    return { width: null, workspaceId: null, panes: [] };
  }
}

/** Read pane-to-tab membership from `herdr pane list`. */
export function parseHerdrPaneTabs(raw: string): Array<{ paneId: string; tabId: string }> {
  try {
    const panes = (JSON.parse(raw) as {
      result?: { panes?: Array<{ pane_id?: unknown; tab_id?: unknown }> };
    }).result?.panes;
    const result: Array<{ paneId: string; tabId: string }> = [];
    for (const pane of panes ?? []) {
      if (typeof pane.pane_id !== "string" || typeof pane.tab_id !== "string") continue;
      result.push({ paneId: pane.pane_id, tabId: pane.tab_id });
    }
    return result;
  } catch {
    return [];
  }
}

/** Read `tmux list-panes -a -F '#{pane_id} #{pane_width} #{pane_height}'`. */
export function parseTmuxPaneList(raw: string): PaneRect[] {
  const rects: PaneRect[] = [];
  for (const line of raw.split("\n")) {
    const [paneId, width, height] = line.trim().split(/\s+/);
    if (!paneId?.startsWith("%")) continue;
    const w = Number.parseInt(width ?? "", 10);
    const h = Number.parseInt(height ?? "", 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      rects.push({ paneId, width: w, height: h });
    }
  }
  return rects;
}

/** Read the root pane of `herdr tab create`. */
export function parseHerdrTabRootPane(raw: string): string | null {
  try {
    const paneId = (JSON.parse(raw) as { result?: { root_pane?: { pane_id?: unknown } } })
      .result?.root_pane?.pane_id;
    return typeof paneId === "string" && paneId ? paneId : null;
  } catch {
    return raw.match(/\b[\w-]+:p[\w-]+\b/)?.[0] ?? null;
  }
}

/** Rename a Herdr pane to the subagent's name. Cosmetic: a failure never blocks the launch. */
function renameHerdrPane(paneId: string, name: string): void {
  try {
    execFileSync("herdr", ["pane", "rename", paneId, name], { encoding: "utf8" });
  } catch {
    // Optional cosmetic rename.
  }
}

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "cmux" || pref === "tmux" || pref === "zellij" || pref === "wezterm" || pref === "herdr") return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

function currentHerdrPane(): HerdrPaneSnapshot | null {
  try {
    return parseHerdrPaneCurrent(
      execFileSync("herdr", ["pane", "current"], { encoding: "utf8" }),
    );
  } catch {
    return null;
  }
}

function herdrPaneLayout(paneId: string): HerdrPaneLayout {
  try {
    return parseHerdrPaneLayout(
      execFileSync("herdr", ["pane", "layout", "--pane", paneId], { encoding: "utf8" }),
      paneId,
    );
  } catch {
    return { width: null, workspaceId: null, panes: [] };
  }
}

/**
 * Rects of the panes we may split, across every tab that holds one of them. Tab membership
 * comes from one `pane list`; each such tab costs one `pane layout` call.
 */
function herdrOwnedPanes(owned: Set<string>): PaneRect[] {
  const tabOf = new Map<string, string>(); // tab -> one pane in it, to query the layout with
  try {
    for (const pane of parseHerdrPaneTabs(execFileSync("herdr", ["pane", "list"], { encoding: "utf8" }))) {
      if (owned.has(pane.paneId) && !tabOf.has(pane.tabId)) tabOf.set(pane.tabId, pane.paneId);
    }
  } catch {
    return [];
  }
  const rects: PaneRect[] = [];
  for (const anchor of tabOf.values()) {
    for (const pane of herdrPaneLayout(anchor).panes) {
      if (owned.has(pane.paneId)) rects.push(pane);
    }
  }
  return rects;
}

function tmuxPaneRects(): PaneRect[] {
  try {
    return parseTmuxPaneList(
      execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_width} #{pane_height}"], {
        encoding: "utf8",
      }),
    );
  } catch {
    return [];
  }
}

function isHerdrRuntimeAvailable(): boolean {
  return hasCommand("herdr") && isUsableHerdrPane(currentHerdrPane());
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function isHerdrAvailable(): boolean {
  return isHerdrRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;
  if (pref === "herdr") return isHerdrRuntimeAvailable() ? "herdr" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  if (isHerdrRuntimeAvailable()) return "herdr";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  if (pref === "wezterm") {
    return "Start pi inside WezTerm.";
  }
  if (pref === "herdr") {
    return "Start pi inside a Herdr pane.";
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), WezTerm, or Herdr.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

// Herdr's recent-unwrapped source excludes the current viewport.
export function mergeHerdrScreenSources(recent: string, visible: string, lines: number): string {
  const combined = [recent.trimEnd(), visible.trimEnd()].filter(Boolean).join("\n");
  return tailLines(combined, lines);
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

/**
 * Pane-scoped zellij actions that must target a specific pane via --pane-id
 * (the ZELLIJ_PANE_ID env var is ignored by most of these).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/19
 */
const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
  "send-keys",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  // Don't double-add if caller already specified it.
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
}

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

// Mirrors Zellij 0.44.x tab minimums, used to predict which pane Zellij itself
// will choose for a directionless split.
const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;

// Pi subagents need more usable space than Zellij's internal minimum. These can
// be tuned per session without another code change.
const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

export interface ZellijPaneSnapshot {
  id: number;
  is_plugin?: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
  | {
      mode: "split";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
      splitDirection: ZellijSplitDirection;
    }
  | { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

function paneArea(pane: ZellijPaneSnapshot): number {
  return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}

function isUsableZellijTiledPane(pane: ZellijPaneSnapshot): boolean {
  return (
    !pane.is_plugin &&
    !pane.is_floating &&
    pane.is_selectable !== false &&
    !pane.exited &&
    typeof pane.pane_rows === "number" &&
    typeof pane.pane_columns === "number"
  );
}

export function predictZellijSplitDirection(pane: ZellijPaneSnapshot): ZellijSplitDirection | null {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) return null;

  if (
    rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
    rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
  ) {
    return "down";
  }

  if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) {
    return "right";
  }

  return null;
}

export function canSplitZellijPane(
  pane: ZellijPaneSnapshot,
  minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
  minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  const direction = predictZellijSplitDirection(pane);
  if (!direction) return false;

  if (direction === "down") {
    return columns >= minColumns && Math.floor(rows / 2) >= minRows;
  }

  return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

function zellijTabPanesForParent(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): { parentPane: ZellijPaneSnapshot; tabPanes: ZellijPaneSnapshot[] } | null {
  const parentPane = panes.find((pane) => !pane.is_plugin && pane.id === parentPaneId);
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;

  const tabPanes = panes
    .filter((pane) => pane.tab_id === parentPane.tab_id)
    .filter(isUsableZellijTiledPane);

  return { parentPane, tabPanes };
}

export function selectZellijStackPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const stackTarget = tabInfo.tabPanes
    .filter((pane) => pane.id !== parentPaneId)
    .sort((a, b) => paneArea(b) - paneArea(a))[0];
  if (!stackTarget) return null;

  return {
    mode: "stack",
    anchorPaneId: stackTarget.id,
    targetPaneId: stackTarget.id,
    tabId: tabInfo.parentPane.tab_id!,
  };
}

export function selectZellijPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
  minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const zellijSplitCandidates = tabInfo.tabPanes
    .map((pane) => ({ pane, splitDirection: predictZellijSplitDirection(pane) }))
    .filter(
      (candidate): candidate is { pane: ZellijPaneSnapshot; splitDirection: ZellijSplitDirection } =>
        candidate.splitDirection !== null &&
        canSplitZellijPane(candidate.pane, ZELLIJ_MIN_TERMINAL_WIDTH, ZELLIJ_MIN_TERMINAL_HEIGHT),
    );

  const safeSplitCandidates = zellijSplitCandidates.filter((candidate) =>
    canSplitZellijPane(candidate.pane, minColumns, minRows),
  );

  // Split creation is tab-scoped, so Zellij chooses the concrete split pane.
  // Only split when every pane Zellij might split would remain usable.
  if (
    zellijSplitCandidates.length > 0 &&
    safeSplitCandidates.length === zellijSplitCandidates.length
  ) {
    const splitTarget = safeSplitCandidates.sort((a, b) => paneArea(b.pane) - paneArea(a.pane))[0];
    return {
      mode: "split",
      anchorPaneId: splitTarget.pane.id,
      targetPaneId: splitTarget.pane.id,
      tabId: tabInfo.parentPane.tab_id!,
      splitDirection: splitTarget.splitDirection,
    };
  }

  return selectZellijStackPlacement(panes, parentPaneId);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
  }
  return `pane:${idMatch[1]}`;
}

function readZellijPanes(): ZellijPaneSnapshot[] {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync(["list-panes", "--json", "--geometry", "--state", "--tab"]);
      if (!output.trim()) {
        throw new Error("Unexpected zellij list-panes output: empty");
      }
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected zellij list-panes output: not an array");
      }
      return parsed as ZellijPaneSnapshot[];
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync(50);
    }
  }
  throw lastError;
}

function createZellijTiledPane(name: string, tabId: number): string {
  const args = ["new-pane", "--tab-id", String(tabId), "--name", name, "--cwd", process.cwd()];
  return parseZellijPaneSurface(zellijActionSync(args).trim(), "new-pane");
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
  const args = [
    "new-pane",
    "--stacked",
    "--near-current-pane",
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];
  return parseZellijPaneSurface(zellijActionSync(args, anchorSurface).trim(), "new-pane --stacked");
}

function createZellijTab(name: string): string {
  const tabIdRaw = zellijActionSync(["new-tab", "--name", name, "--cwd", process.cwd()]).trim();
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`);
  }

  try {
    const panes = readZellijPanes();
    const pane = panes.find(
      (candidate) =>
        candidate.tab_id === tabId &&
        isUsableZellijTiledPane(candidate) &&
        typeof candidate.id === "number",
    );
    if (!pane) {
      throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
    }

    const surface = `pane:${pane.id}`;
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {
      // Optional.
    }
    return surface;
  } catch (error) {
    try {
      zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
    } catch {
      // Best effort cleanup for tabs created before post-creation inspection failed.
    }
    throw error;
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function zellijSurfaceLockPath(): string {
  const session = (process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default").replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
  return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}

function withZellijSurfaceLock<T>(callback: () => T): T {
  const lockPath = zellijSurfaceLockPath();
  const deadline = Date.now() + 10000;

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`);
      }
      sleepSync(50);
    }
  }

  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function createZellijSurfaceUnlocked(name: string): string {
  const parentPaneIdRaw = process.env.ZELLIJ_PANE_ID;
  const parentPaneId = parentPaneIdRaw ? Number(parentPaneIdRaw) : NaN;
  const minColumns = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  );
  const minRows = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_ROWS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
  );

  const plan = Number.isInteger(parentPaneId)
    ? selectZellijPlacement(readZellijPanes(), parentPaneId, minColumns, minRows)
    : null;

  if (plan?.mode === "split") {
    return createZellijTiledPane(name, plan.tabId);
  }

  if (plan?.mode === "stack") {
    return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
  }

  return createZellijTab(name);
}

function createZellijSurface(name: string): string {
  return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name));
}

type CmuxFocusSnapshot = {
  surfaceRef?: string;
  paneRef?: string;
};

type CmuxCreatedSurface = {
  surface: string;
  paneRef?: string;
};

type CmuxIdentifySnapshot = {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const focused = (value as { focused?: unknown }).focused;
  if (!focused || typeof focused !== "object") return null;

  const record = focused as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch (error) {
    void error;
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(value: string): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const caller = (value as { caller?: unknown }).caller;
  if (!caller || typeof caller !== "object") return null;

  const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxPaneRefForSurface(value: unknown, surface: string): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as { surface_ref?: unknown; pane_ref?: unknown; caller?: unknown };
  if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) return record.pane_ref;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;

  const callerRecord = caller as { surface_ref?: unknown; pane_ref?: unknown };
  if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
    return callerRecord.pane_ref;
  }

  return null;
}

export function parseCmuxPaneRefForSurfaceFromJson(value: string, surface: string): string | null {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}

function readCmux(args: string[]): string | null {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed),
  };
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
  return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
  if (!snapshot) return;

  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
  }
}

function waitForCmuxFocusSettle(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function cmuxFocusMatchesChild(
  currentFocus: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
): boolean {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
  currentFocus: CmuxFocusSnapshot | null,
  surfaceRef: string | undefined,
): boolean {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
  currentFocus: CmuxFocusSnapshot | null,
  paneRef: string | undefined,
): boolean {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
  snapshot: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
  options?: { sourceSurfaceRef?: string; callerSnapshot?: CmuxFocusSnapshot | null },
): void {
  if (!snapshot) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  if (
    cmuxFocusMatchesChild(currentFocus, child) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.callerSnapshot?.surfaceRef) ||
    // cmux can settle focus onto another active surface in the caller pane after creating a split/surface.
    cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
  ) {
    restoreCmuxFocusSnapshot(snapshot);
  }
}

function parseCmuxCreatedSurface(output: string, command: string): CmuxCreatedSurface {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }

  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0],
  };
}

function renameCmuxSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}

function createCmuxSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);

    const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        sourceSurfaceRef: fromSurface,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * A subagent pane is never split below this width. A split halves the parent pane, so a
 * 16-way fan-out collapsed panes to 1 column — where pi exits on the first double-width
 * glyph (emoji) instead of rendering. Below the limit we open a new tab or window, which
 * starts at full width.
 */
export const MIN_SUBAGENT_PANE_WIDTH = 40;

/** Same floor on the other axis, so a fan-out cannot squeeze rows either. */
export const MIN_SUBAGENT_PANE_HEIGHT = 14;

/**
 * The pane being split keeps this share and the new subagent pane takes the rest. The golden
 * ratio keeps a tiling of many panes readable, where an even split runs out of room twice as
 * fast.
 */
export const GOLDEN_EXISTING_SHARE = 0.618;

/**
 * Panes this process created for subagents, plus the caller. Splitting the largest of these
 * keeps the tiling balanced and keeps the extension off panes the user arranged for other
 * work. Stale ids are harmless: only panes found in a live layout are considered.
 */
const ownedSurfaces = new Set<string>();

/**
 * How much of one axis the new pane takes: the golden remainder, but never below `floor`.
 * Returns null when the axis cannot be split without one side dropping under its floor.
 */
export function newPaneSize(axis: number, floor: number): number | null {
  if (axis < floor * 2) return null;
  return Math.max(floor, Math.round(axis * (1 - GOLDEN_EXISTING_SHARE)));
}

/**
 * Split the longer axis, but only when both sides stay above their floors; otherwise fall back to
 * the other axis, or refuse.
 */
export function splitDirectionFor(rect: PaneRect): "right" | "down" | null {
  const canSplitRight = newPaneSize(rect.width, MIN_SUBAGENT_PANE_WIDTH) !== null;
  const canSplitDown = newPaneSize(rect.height, MIN_SUBAGENT_PANE_HEIGHT) !== null;
  const longest = rect.width >= rect.height ? "right" : "down";
  const shortest = longest === "right" ? "down" : "right";
  if (longest === "right" ? canSplitRight : canSplitDown) return longest;
  if (shortest === "right" ? canSplitRight : canSplitDown) return shortest;
  return null;
}

/** Largest pane we own that can still take a split, or null when the whole layout is full. */
export function pickSplitTarget(panes: PaneRect[], owned: Iterable<string>): PaneRect | null {
  const allowed = new Set(owned);
  let best: PaneRect | null = null;
  for (const pane of panes) {
    if (!allowed.has(pane.paneId)) continue;
    if (!splitDirectionFor(pane)) continue;
    if (!best || pane.width * pane.height > best.width * best.height) best = pane;
  }
  return best;
}

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For zellij: chooses a tab-aware tiled or stacked placement.
 * For tmux/wezterm: falls back to split behavior.
 *
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurface(name: string): string {
  const backend = getMuxBackend();

  if (backend === "cmux" && cmuxSubagentPane) {
    // Verify the pane still exists before adding a tab to it
    try {
      const tree = execSync(`cmux tree`, { encoding: "utf8" });
      if (tree.includes(cmuxSubagentPane)) {
        return createSurfaceInPane(name, cmuxSubagentPane);
      }
    } catch {}
    // Pane is gone — fall through to create a new split
    cmuxSubagentPane = null;
  }

  if (backend === "cmux") {
    const created = createCmuxSplitSurface(name, "right", process.env.CMUX_SURFACE_ID);
    cmuxSubagentPane = created.paneRef ?? null;
    return created.surface;
  }

  if (backend === "zellij") {
    return createZellijSurface(name);
  }

  if (backend === "herdr") {
    const caller = currentHerdrPane()?.paneId ?? null;
    const owned = new Set(ownedSurfaces);
    if (caller) owned.add(caller);
    const target = pickSplitTarget(herdrOwnedPanes(owned), owned);
    if (target) {
      const direction = splitDirectionFor(target)!;
      const axis = direction === "right" ? target.width : target.height;
      const floor = direction === "right" ? MIN_SUBAGENT_PANE_WIDTH : MIN_SUBAGENT_PANE_HEIGHT;
      const size = newPaneSize(axis, floor)!;
      const surface = createHerdrSplit(name, target.paneId, direction, 1 - size / axis);
      ownedSurfaces.add(surface);
      return surface;
    }
    // Every owned pane is too small to split: start a fresh tab at full width.
    const workspaceId = caller ? herdrPaneLayout(caller).workspaceId : null;
    const surface = createHerdrSubagentTab(name, workspaceId);
    ownedSurfaces.add(surface);
    return surface;
  }

  if (backend === "tmux") {
    // On tmux, target the parent pi's pane so splits follow the agent, not the user's focus.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/12
    const caller = process.env.TMUX_PANE;
    const owned = new Set(ownedSurfaces);
    if (caller) owned.add(caller);
    const target = pickSplitTarget(tmuxPaneRects(), owned);
    if (target) {
      const direction = splitDirectionFor(target)!;
      const axis = direction === "right" ? target.width : target.height;
      const floor = direction === "right" ? MIN_SUBAGENT_PANE_WIDTH : MIN_SUBAGENT_PANE_HEIGHT;
      const surface = createTmuxSplit(target.paneId, direction, newPaneSize(axis, floor)!);
      ownedSurfaces.add(surface);
      return surface;
    }
    const surface = createTmuxSubagentWindow(name);
    ownedSurfaces.add(surface);
    return surface;
  }

  return createSurfaceSplit(name, "right", undefined);
}

/**
 * Create a new surface (tab) in an existing cmux pane.
 */
function createSurfaceInPane(name: string, pane: string): string {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const output = execFileSync("cmux", ["new-surface", "--pane", pane], { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Split off a new pane, leaving the pane being split at the golden proportion.
 */
function createHerdrSplit(
  name: string,
  paneId: string,
  direction: "right" | "down",
  existingShare: number,
): string {
  const output = execFileSync(
    "herdr",
    [
      "pane",
      "split",
      "--pane",
      paneId,
      "--direction",
      direction,
      "--ratio",
      String(existingShare),
      "--cwd",
      process.cwd(),
      "--no-focus",
    ],
    { encoding: "utf8" },
  );
  const pane = parseHerdrPaneSplit(output);
  if (!pane) throw new Error(`Unexpected Herdr pane split output: ${output || "(empty)"}`);
  renameHerdrPane(pane, name);
  return pane;
}

/**
 * Split off a new pane of an explicit size, which is how tmux takes a golden proportion.
 */
function createTmuxSplit(
  paneId: string,
  direction: "right" | "down",
  size: number,
): string {
  const pane = execFileSync(
    "tmux",
    [
      "split-window",
      "-d",
      direction === "right" ? "-h" : "-v",
      "-l",
      String(size),
      "-t",
      paneId,
      "-P",
      "-F",
      "#{pane_id}",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane || "(empty)"}`);
  }
  return pane;
}

/**
 * Create a full-width tab for a subagent, for when no owned pane can take a split.
 */
function createHerdrSubagentTab(name: string, workspaceId: string | null): string {
  const args = ["tab", "create", "--cwd", process.cwd()];
  if (workspaceId) args.push("--workspace", workspaceId);
  const output = execFileSync("herdr", args, { encoding: "utf8" });
  const paneId = parseHerdrTabRootPane(output);
  if (!paneId) throw new Error(`Unexpected Herdr tab create output: ${output || "(empty)"}`);
  renameHerdrPane(paneId, name);
  return paneId;
}

/**
 * Create a full-width window for a subagent, for when no owned pane can take a split.
 */
function createTmuxSubagentWindow(name: string): string {
  const pane = execFileSync(
    "tmux",
    ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", name],
    { encoding: "utf8" },
  ).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux new-window output: ${pane || "(empty)"}`);
  }
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return createCmuxSplitSurface(name, direction, fromSurface).surface;
  }

  if (backend === "herdr") {
    const parentPane = fromSurface ?? currentHerdrPane()?.paneId;
    if (!parentPane) throw new Error("No current Herdr pane found");
    const output = execFileSync(
      "herdr",
      ["pane", "split", "--pane", parentPane, "--direction", direction, "--cwd", process.cwd(), "--no-focus"],
      { encoding: "utf8" },
    );
    const paneId = parseHerdrPaneSplit(output);
    if (!paneId) throw new Error(`Unexpected Herdr pane split output: ${output || "(empty)"}`);
    try {
      execFileSync("herdr", ["pane", "rename", paneId, name], { encoding: "utf8" });
    } catch {
      // Optional cosmetic rename.
    }
    return paneId;
  }

  if (backend === "tmux") {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    return pane;
  }

  if (backend === "wezterm") {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  let rawId: string;
  try {
    rawId = zellijActionSync(args, fromSurface).trim();
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    rawId = zellijActionSync(args).trim();
  }

  // zellij returns the pane ID as e.g. "terminal_7" — extract the numeric part.
  // Previously we sent `write-chars "echo $ZELLIJ_PANE_ID"` to a temp file, but
  // `write-chars` without --pane-id targets the focused pane, which raced on tab switches.
  const surface = parseZellijPaneSurface(rawId, "new-pane");

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") return;

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  // zellij: rename the agent's own pane, not the whole tab. In multi-pane layouts,
  // rename-tab clobbers the user's tab title whenever a subagent starts or /plan runs.
  // Closes #21.
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (paneId) {
    zellijActionSync(["rename-pane", title], `pane:${paneId}`);
  } else {
    zellijActionSync(["rename-pane", title]);
  }
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") return;

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
    return;
  }

  // Skip session rename for zellij. rename-session renames the socket file
  // but the ZELLIJ_SESSION_NAME env var in the parent process keeps the old
  // name, so all subsequent `zellij action ...` CLI calls fail with
  // "There is no active session!" because the CLI can't find the socket.
  // Additionally, pi titles often contain special characters (em dashes,
  // spaces) that fail zellij's session name validation on lookup.
  // rename-tab (called separately) is sufficient for user-visible naming.
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
      { encoding: "utf8" },
    );
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execFileSync("cmux", ["send", "--surface", surface, "\u001b"], { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-keys", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["write", "27"], surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
  }

  if (backend === "herdr") {
    const recent = execFileSync(
      "herdr",
      ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"],
      { encoding: "utf8" },
    );
    const visible = execFileSync(
      "herdr",
      ["pane", "read", surface, "--source", "visible", "--format", "text"],
      { encoding: "utf8" },
    );
    return mergeHerdrScreenSources(recent, visible, lines);
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "wezterm") {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(raw, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  // The ZELLIJ_PANE_ID env var doesn't reliably target other panes for dump-screen,
  // and --path may silently fail to create the file. Stdout capture is robust.
  const paneId = zellijPaneId(surface);
  const raw = execFileSync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "herdr") {
    const [recent, visible] = await Promise.all([
      execFileAsync(
        "herdr",
        ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"],
        { encoding: "utf8" },
      ),
      execFileAsync(
        "herdr",
        ["pane", "read", surface, "--source", "visible", "--format", "text"],
        { encoding: "utf8" },
      ),
    ]);
    return mergeHerdrScreenSources(recent.stdout, visible.stdout, lines);
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "wezterm") {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(stdout, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  const paneId = zellijPaneId(surface);
  const { stdout } = await execFileAsync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(stdout, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  ownedSurfaces.delete(surface);
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["close-pane"], surface);
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/** Non-terminal request written by `ask_question`; the child stays alive. */
export interface AskRequest {
  name: string;
  question: string;
}

/**
 * Read a `<sessionFile>.ask` sidecar written by `ask_question`. Returns null
 * when the file is missing or carries no usable question. The caller deletes
 * the sidecar once the request has been delivered to the parent.
 */
export function readAskSidecar(path: string): AskRequest | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.type !== "ask") return null;
    const question = typeof data.question === "string" ? data.question.trim() : "";
    if (!question) return null;
    return {
      name: typeof data.name === "string" && data.name ? data.name : "subagent",
      question,
    };
  } catch {
    return null;
  }
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /**
     * Called when the child asks a question. Unlike `.exit`, this does not end
     * the poll: the child is parked in its pane waiting for an answer.
     */
    onAsk?: (ask: AskRequest) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Non-terminal: the child asked a question and stays alive in its pane.
    // Deliver the request and keep polling for its eventual exit.
    if (options.sessionFile && options.onAsk) {
      const askFile = `${options.sessionFile}.ask`;
      const ask = readAskSidecar(askFile);
      if (ask) {
        try {
          rmSync(askFile, { force: true });
        } catch {}
        options.onAsk(ask);
      }
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
