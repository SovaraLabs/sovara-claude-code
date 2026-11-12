# Changelog

## Unreleased

- First release: record Claude Code sessions (prompts as turns, tool calls, replies) through
  the `sovara-recording` plugin's hooks, and add matching lessons to each prompt.
- Each hook waits up to 4 s, before it exits, for step reports the SDK sends in the background.
