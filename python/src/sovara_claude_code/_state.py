"""Per-session state shared by the hook processes of one Claude Code session.

Each session has one JSON file holding its recording handles, which carry a write token: the
file is private (0600), written atomically, and never logged. The format is shared with the
TypeScript integration (``@sovara/claude-code``).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

# A session whose SessionEnd never ran (a crash) is forgotten after this long.
STALE_AFTER_SECONDS = 7 * 24 * 3600
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def state_dir() -> Path:
    """Return the state directory: the plugin's data directory, else ``~/.sovara/claude-code``."""
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "").strip()
    if plugin_data:
        return Path(plugin_data)
    return Path.home() / ".sovara" / "claude-code"


def _path(session_id: str) -> Path:
    if not _SAFE_ID.match(session_id):
        raise ValueError("Unsupported Claude Code session ID.")
    return state_dir() / f"{session_id}.json"


def load(session_id: str) -> dict[str, Any] | None:
    """Return the session's state, or None when it has none."""
    try:
        return json.loads(_path(session_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def save(session_id: str, state: dict[str, Any]) -> None:
    """Replace the session's state atomically, readable only by the current user."""
    path = _path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(state, file)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def delete(session_id: str) -> None:
    """Forget the session's state."""
    _path(session_id).unlink(missing_ok=True)


def prune() -> None:
    """Delete state files of sessions that ended without SessionEnd."""
    cutoff = time.time() - STALE_AFTER_SECONDS
    for path in state_dir().glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            continue
