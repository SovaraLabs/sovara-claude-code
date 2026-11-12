# Sovara for Claude Code

Record Claude Code sessions in Sovara and add relevant lessons to each prompt.

- Each session is a Sovara trace, each prompt a turn.
- Tool calls (succeeded or failed) are tool steps; Claude's reply is a model step.
- Matching lessons are added to the prompt as extra context.

## Setup

1. Install the hook program with either runtime:

   ```sh
   uv tool install sovara-claude-code    # Python 3.10+
   npm install -g @sovara/claude-code    # or Node.js 24.22.1+
   ```

2. Sign in with `sovara login --url <your Sovara URL>`, or set `SOVARA_EXEC_SERVER_URL` and
   `SOVARA_AGENT_TOKEN`.
3. Load the `sovara-recording` plugin from [`plugin/`](plugin), for example
   `claude --plugin-dir plugin` from a clone of this repository. Its hooks run `sovara-claude-code hook`.

The project is the folder you start Claude Code in; set `SOVARA_PROJECT` to choose another.

## Behavior

- Hooks never block Claude Code. If Sovara is unavailable, the session runs unrecorded.
- Lessons are recorded as retrieved, not applied: Claude Code doesn't expose the exact model
  input, so Sovara can't confirm what reached the model.
- Recording handles are kept per session in a private file (0600) under the plugin's data
  directory or `~/.sovara/claude-code`, and deleted when the session ends.

Packages: [`python/`](python) (`sovara-claude-code`) and [`typescript/`](typescript)
(`@sovara/claude-code`). Both read and write the same state, so either works.

## Development

The packages use the Sovara SDK from a [sovara](https://github.com/SovaraLabs/sovara) checkout
next to this repository (`../sovara`).
CI checks out sovara's `main` branch (set the `SOVARA_REF` repository variable to use
another one) with the `SOVARA_REPO_TOKEN` secret, a token that can read `SovaraLabs/sovara`.

Python (`python/`):

```sh
cd python
uv sync
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```

TypeScript (`typescript/`): build the SDK first, then run the checks:

```sh
(cd ../sovara/packages/typescript-sdk && npm ci && npm run build)
cd typescript
npm ci
npm run check
```

## License

MIT.
