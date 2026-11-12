/**
 * Record Claude Code sessions in Sovara and add relevant lessons to each prompt.
 *
 * Claude Code runs `sovara-claude-code hook` for each hook event (see the `sovara-recording`
 * plugin). `handle(event)` is the same entry point for tests.
 */
export { handle, type HookEvent } from "./hooks.js";
