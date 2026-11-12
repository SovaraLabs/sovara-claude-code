#!/usr/bin/env node
/** Command line: `sovara-claude-code hook` reads one Claude Code hook event from stdin. */
import { handle } from "./hooks.js";

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "hook") {
    console.error("usage: sovara-claude-code hook");
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let event: unknown;
  try {
    event = JSON.parse(input || "{}");
  } catch {
    return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const output = await handle(event as Record<string, unknown>);
  if (output) process.stdout.write(`${output}\n`);
}

// Always exit 0, so a Sovara problem never interrupts Claude Code.
main().catch(() => undefined).finally(() => process.exit(0));
