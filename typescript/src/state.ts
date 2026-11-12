/**
 * Per-session state shared by the hook processes of one Claude Code session.
 *
 * Each session has one JSON file holding its recording handles, which carry a write token: the
 * file is private (0600), written atomically, and never logged. The format is shared with the
 * Python integration (`sovara-claude-code`).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type SessionState = {
  session: string;
  turn: string | null;
  prompt: string | null;
};

/** A session whose SessionEnd never ran (a crash) is forgotten after this long. */
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function stateDir(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA?.trim();
  return pluginData || join(homedir(), ".sovara", "claude-code");
}

function statePath(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error("Unsupported Claude Code session ID.");
  return join(stateDir(), `${sessionId}.json`);
}

export function load(sessionId: string): SessionState | null {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), "utf8")) as SessionState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function save(sessionId: string, state: SessionState): void {
  const path = statePath(sessionId);
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = join(stateDir(), `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function remove(sessionId: string): void {
  rmSync(statePath(sessionId), { force: true });
}

/** Delete state files of sessions that ended without SessionEnd. */
export function prune(): void {
  const cutoff = Date.now() - STALE_AFTER_MS;
  let names: string[];
  try {
    names = readdirSync(stateDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(stateDir(), name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      continue;
    }
  }
}
