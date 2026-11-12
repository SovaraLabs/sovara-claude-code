"""Command line: ``sovara-claude-code hook`` reads one Claude Code hook event from stdin."""

from __future__ import annotations

import json
import sys

from sovara_claude_code._hooks import handle


def main(argv: list[str] | None = None) -> int:
    """Run a hook and print its output for Claude Code; always exits 0."""
    args = sys.argv[1:] if argv is None else argv
    if args != ["hook"]:
        print("usage: sovara-claude-code hook", file=sys.stderr)
        return 0
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    output = handle(event) if isinstance(event, dict) else None
    if output:
        print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
