"""Record a Claude Code session in Sovara from its hook events.

Hooks run as separate processes, so the session's recording is shared through a handle
(``sovara.open_recording``) kept in the session's state file. A hook never blocks Claude Code:
failures are swallowed and requests retry only briefly.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

import sovara
from sovara import (
    ConversationInput,
    ConversationOutput,
    ErrorInfo,
    ErrorOutcome,
    LlmCall,
    Message,
    SuccessOutcome,
    TextBlock,
    ToolCall,
)
from sovara.integration import flush_recordings, json_value, short_retries
from sovara_claude_code import _state

logger = logging.getLogger("sovara_claude_code")

# Per-request timeout, so a hook's usual three requests fit in the 15 s Claude Code allows
# it (hooks/hooks.json).
REQUEST_TIMEOUT_SECONDS = 4.0
# How long a hook waits, before exiting, for reports the SDK sends in the background.
FLUSH_SECONDS = REQUEST_TIMEOUT_SECONDS

# Errors meaning the recording no longer exists. A write token the server no longer knows
# is a SovaraConfigError with HTTP 403.
_LOST_RECORDING = {"recording_inactive", "not_found"}


def _recording_lost(exc: Exception) -> bool:
    if isinstance(exc, sovara.SovaraConfigError):
        return exc.status_code == 403
    return isinstance(exc, sovara.RecordingError) and exc.code in _LOST_RECORDING


def _project_name(event: dict[str, Any]) -> str:
    configured = os.environ.get("SOVARA_PROJECT", "").strip()
    return configured or Path(str(event.get("cwd") or os.getcwd())).name or "claude-code"


def _text_message(role: str, text: str) -> Message:
    return Message(role=role, content=(TextBlock(text=text),))  # type: ignore[arg-type]


def _open(event: dict[str, Any], http_client: httpx.Client | None) -> str:
    """Open a recording of the session's trace; the same session always gets the same trace."""
    return sovara.open_recording(
        project_name=_project_name(event),
        name="Claude Code session",
        trace_id=f"claude-code:{event['session_id']}",
        agent_token=os.environ.get("SOVARA_AGENT_TOKEN") or None,
        http_client=http_client,
    )


def session_start(event: dict[str, Any], http_client: httpx.Client | None = None) -> str | None:
    """Open the session's recording, or keep it on resume, clear and compact."""
    session_id = event["session_id"]
    _state.prune()
    if _state.load(session_id) is not None:
        return None
    _state.save(session_id, {"session": _open(event, http_client), "turn": None, "prompt": None})
    return None


def _start_turn(session: str, prompt: str, http_client: httpx.Client | None) -> str | None:
    with sovara.resume_recording(session, http_client=http_client):
        sovara.start_turn(turn_input=prompt)
        return sovara.export_recording()


def _lessons(handle: str, prompt: str, http_client: httpx.Client | None) -> Any:
    # Retrieved, not applied: Claude Code does not show what reaches the model.
    with sovara.resume_recording(handle, http_client=http_client):
        return sovara.retrieve_lessons(prompt)


def user_prompt_submit(
    event: dict[str, Any], http_client: httpx.Client | None = None
) -> str | None:
    """Start a turn for the prompt and return matching lessons as extra context."""
    session_id = event["session_id"]
    state = _state.load(session_id)
    if state is None:
        # SessionStart could not open the recording; the trace key is stable, so open it now.
        state = {"session": _open(event, http_client), "turn": None, "prompt": None}
        _state.save(session_id, state)
    prompt = str(event.get("prompt") or "")
    try:
        turn = _start_turn(state["session"], prompt, http_client)
    except (sovara.RecordingError, sovara.SovaraConfigError) as exc:
        # Only a recording the exec server lost (e.g. after a restart) is reopened; a passing
        # failure must not open a second recording of the session.
        if not _recording_lost(exc):
            raise
        state = {**state, "session": _open(event, http_client)}
        turn = _start_turn(state["session"], prompt, http_client)
    # Saved before retrieving lessons, so later steps join this turn even if retrieval fails.
    _state.save(session_id, {**state, "turn": turn, "prompt": prompt})
    try:
        lessons = _lessons(turn or state["session"], prompt, http_client) if prompt else None
    except sovara.RecordingError:
        lessons = None
    if lessons is None:
        return None
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": lessons.text,
            }
        }
    )


def _record(
    state: dict[str, Any], call: Any, outcome: Any, http_client: httpx.Client | None
) -> None:
    handle = state.get("turn") or state["session"]
    with sovara.resume_recording(handle, http_client=http_client):
        sovara.record_step(call, outcome)


def _tool_call(event: dict[str, Any]) -> ToolCall:
    arguments = json_value(event.get("tool_input"))
    return ToolCall(
        name=str(event.get("tool_name") or "tool"),
        arguments=arguments if isinstance(arguments, dict) else {"input": arguments},
        call_id=str(event.get("tool_use_id") or "").strip() or None,
        metadata={"source": "claude-code"},
    )


def post_tool_use(event: dict[str, Any], http_client: httpx.Client | None = None) -> str | None:
    """Record a tool call that succeeded."""
    state = _state.load(event["session_id"])
    if state is not None:
        outcome = SuccessOutcome(output=json_value(event.get("tool_response")))
        _record(state, _tool_call(event), outcome, http_client)
    return None


def post_tool_use_failure(
    event: dict[str, Any], http_client: httpx.Client | None = None
) -> str | None:
    """Record a tool call that failed or was interrupted."""
    state = _state.load(event["session_id"])
    if state is not None:
        error = ErrorInfo(type="ToolError", message=str(event.get("error") or ""))
        _record(state, _tool_call(event), ErrorOutcome(error=error), http_client)
    return None


def stop(event: dict[str, Any], http_client: httpx.Client | None = None) -> str | None:
    """Record Claude's reply to the turn's prompt as a model step."""
    state = _state.load(event["session_id"])
    reply = str(event.get("last_assistant_message") or "")
    if state is None or not reply or event.get("stop_hook_active"):
        return None
    prompt = str(state.get("prompt") or "")
    call = LlmCall(
        provider="anthropic",
        input=ConversationInput(messages=(_text_message("user", prompt),) if prompt else ()),
        metadata={"source": "claude-code"},
    )
    outcome = SuccessOutcome(output=ConversationOutput(message=_text_message("assistant", reply)))
    _record(state, call, outcome, http_client)
    return None


def session_end(event: dict[str, Any], http_client: httpx.Client | None = None) -> str | None:
    """Close the session's recording and forget its state."""
    session_id = event["session_id"]
    state = _state.load(session_id)
    if state is None:
        return None
    try:
        sovara.close_recording(state["session"], http_client=http_client)
    finally:
        _state.delete(session_id)
    return None


HANDLERS = {
    "SessionStart": session_start,
    "UserPromptSubmit": user_prompt_submit,
    "PostToolUse": post_tool_use,
    "PostToolUseFailure": post_tool_use_failure,
    "Stop": stop,
    "SessionEnd": session_end,
}


def handle(event: dict[str, Any], http_client: httpx.Client | None = None) -> str | None:
    """Run the handler for one hook event; return text for Claude Code, or None.

    Never raises: a failure is logged by type only and the session continues unrecorded.
    """
    handler = HANDLERS.get(str(event.get("hook_event_name")))
    if handler is None or not event.get("session_id"):
        return None
    try:
        with short_retries(), contextlib.ExitStack() as stack:
            if http_client is None:
                http_client = stack.enter_context(httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS))
            output = handler(event, http_client)
            # Reports queued in the background use http_client, which closes on return.
            flush_recordings(FLUSH_SECONDS)
            return output
    except Exception as exc:
        logger.warning(
            "Sovara Claude Code hook failed event=%s error_type=%s",
            event.get("hook_event_name"),
            type(exc).__name__,
        )
        return None
