# Sovara for Claude Code

Sovara helps teams manage domain knowledge and put it to work in AI agents.
Capture business rules, expert guidance, and lessons from experience in a shared
knowledge base. Deliver relevant knowledge to agents as they work, review how
they use it, and improve it together.

Bring your team's domain knowledge into Claude Code and review agent sessions together with Sovara.

## Setup

1. Install the integration with either runtime:

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

## Using your team's knowledge

Store business rules and expert guidance as lessons in Sovara, including when
they should apply. Relevant lessons are added to your prompts; recorded sessions
let your team review how they were used.

If Sovara is unavailable, Claude Code continues running.

Packages: [`python/`](python) (`sovara-claude-code`) and [`typescript/`](typescript)
(`@sovara/claude-code`). Choose either runtime.

## License

MIT.
