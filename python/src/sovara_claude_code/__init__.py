"""Record Claude Code sessions in Sovara and add relevant lessons to each prompt.

Claude Code runs ``sovara-claude-code hook`` for each hook event (see the plugin in this
package's ``plugin/`` directory). ``handle(event)`` is the same entry point for tests.
"""

from sovara_claude_code._hooks import handle

__all__ = ["handle"]
