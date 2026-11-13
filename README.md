# Sovara for Claude Code

Record Claude Code sessions in Sovara and add relevant lessons to each prompt.

- Each session is a Sovara trace, each prompt a turn.
- Tool calls (succeeded or failed) are tool steps; Claude's reply is a model step.
- Matching lessons are added to the prompt as extra context.

## Setup

1. Install the hook program with either runtime:

   ```sh
   uv tool install sovara-claude-code    # Python 3.10+
   # or: pip install sovara-claude-code
   npm install -g @sovara/claude-code    # or Node.js 24.22.1+
   ```

2. [Install the Sovara CLI](https://docs.sovara-labs.com/get-started/installation) and sign in
   with `sovara login --url <your Sovara URL>`.
3. In Claude Code, add the marketplace and install the plugin:

   ```text
   /plugin marketplace add SovaraLabs/sovara-claude-code
   /plugin install sovara-recording@sovara-claude-code
   ```

   Restart Claude Code to activate the hooks.

The project is the folder you start Claude Code in; set `SOVARA_PROJECT` to choose another.

## Behavior

- Hooks never block Claude Code. If Sovara is unavailable, the session runs unrecorded.

Packages: [`python/`](python) (`sovara-claude-code`) and [`typescript/`](typescript)
(`@sovara/claude-code`). Both read and write the same state, so either works.

## License

MIT.
