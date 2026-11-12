"""A Claude Code session recorded through its hooks, against a fake exec server."""

import json

import httpx
import pytest

from sovara_claude_code import _state, handle
from sovara_claude_code._hooks import REQUEST_TIMEOUT_SECONDS

TOKEN = "write-token-secret"
HEALTH = {
    "status": "ok",
    "service": "sovara-exec-server",
    "compatibility": {"component": "exec-server", "contracts": {"runner-api": [6]}},
}


class FakeExecServer:
    """Answer the runner-api 6 routes the hooks use and keep the requests."""

    def __init__(self, lessons: str | None = "Run the tests first.") -> None:
        self.lessons = lessons
        self.lost_recordings = 0
        self.failing_turns = 0
        self.failing_status = 500
        self.failing_lessons = False
        self.failing_opens = 0
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/exec/health":
            return httpx.Response(200, json=HEALTH)
        body = json.loads(request.content or b"{}")
        self.requests.append((path, body))
        if path == "/exec/traces" and self.failing_opens:
            self.failing_opens -= 1
            return httpx.Response(500, json={"error": "internal_error", "message": "x"})
        if path == "/exec/traces":
            return httpx.Response(
                200,
                json={
                    "trace_id": "trace-1",
                    "recording_id": "rec-1",
                    "project_id": "project-1",
                    "appended": False,
                    "trace_write_token": TOKEN,
                },
            )
        if path.endswith("/turns"):
            if self.failing_turns:
                self.failing_turns -= 1
                return httpx.Response(self.failing_status, json={"error": "x", "message": "x"})
            if self.lost_recordings:
                self.lost_recordings -= 1
                return httpx.Response(
                    409, json={"error": "recording_inactive", "message": "Not active."}
                )
            return httpx.Response(200, json={"turn_id": "turn-1", "recording_id": "rec-1"})
        if path.endswith("/lesson-retrievals") and self.failing_lessons:
            return httpx.Response(500, json={"error": "internal_error", "message": "x"})
        if path.endswith("/lesson-retrievals"):
            context = (
                {"text": self.lessons, "retrieval_id": "retrieval-1"} if self.lessons else None
            )
            return httpx.Response(200, json={"ok": True, "lesson_context": context})
        if path.endswith("/steps/record"):
            return httpx.Response(200, json={"ok": True, "step_uuid": body["step_uuid"]})
        return httpx.Response(200, json={"ok": True})

    def paths(self) -> list[str]:
        return [path.removeprefix("/exec/traces/trace-1") or path for path, _ in self.requests]


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path))
    monkeypatch.setenv("SOVARA_EXEC_SERVER_URL", "http://exec.test")
    fake = FakeExecServer()
    with httpx.Client(transport=httpx.MockTransport(fake)) as client:
        yield fake, client


def _event(name: str, **fields) -> dict:
    return {"hook_event_name": name, "session_id": "s1", "cwd": "/work/my-repo", **fields}


def test_a_session_is_recorded_with_lessons_tools_and_the_reply(server, tmp_path, caplog):
    fake, client = server
    assert handle(_event("SessionStart", source="startup"), client) is None
    output = handle(_event("UserPromptSubmit", prompt="Fix the build"), client)
    handle(
        _event(
            "PostToolUse",
            tool_name="Bash",
            tool_input={"command": "make"},
            tool_response={"stdout": "ok"},
            tool_use_id="t1",
        ),
        client,
    )
    handle(
        _event(
            "PostToolUseFailure",
            tool_name="Bash",
            tool_input={"command": "x"},
            error="Exit code 1",
            tool_use_id="t2",
        ),
        client,
    )
    handle(_event("Stop", last_assistant_message="Fixed it."), client)
    handle(_event("SessionEnd", reason="other"), client)

    assert json.loads(output or "")["hookSpecificOutput"]["additionalContext"] == (
        "Run the tests first."
    )
    assert fake.paths() == [
        "/exec/traces",
        "/turns",
        "/lesson-retrievals",
        "/steps/record",
        "/steps/record",
        "/steps/record",
        "/complete",
    ]
    opened = fake.requests[0][1]
    assert (opened["project_name"], opened["trace_id"]) == ("my-repo", "claude-code:s1")
    tool, failed, reply = (body for path, body in fake.requests if path.endswith("/record"))
    assert tool["call"]["value"]["name"] == "Bash" and tool["turn_id"] == "turn-1"
    assert failed["outcome"]["value"]["status"] == "error"
    assert reply["call"]["value"]["kind"] == "llm"
    assert reply["outcome"]["value"]["output"]["message"]["content"][0]["text"] == "Fixed it."
    assert list(tmp_path.glob("*.json")) == []
    assert TOKEN not in caplog.text


def test_a_resumed_session_keeps_its_recording(server):
    fake, client = server
    handle(_event("SessionStart", source="startup"), client)
    handle(_event("SessionStart", source="resume"), client)
    assert fake.paths() == ["/exec/traces"]


def test_state_is_private_and_failures_never_reach_claude_code(server, tmp_path, monkeypatch):
    fake, client = server
    handle(_event("SessionStart", source="startup"), client)
    assert oct((tmp_path / "s1.json").stat().st_mode & 0o777) == "0o600"

    def down(request):
        raise httpx.ConnectError("down", request=request)

    with httpx.Client(transport=httpx.MockTransport(down)) as broken:
        assert handle(_event("UserPromptSubmit", prompt="hi"), broken) is None
    assert handle({"hook_event_name": "Unknown"}, client) is None
    with pytest.raises(ValueError):
        _state.load("../escape")


def test_a_recording_lost_by_the_server_is_reopened_at_the_next_prompt(server):
    fake, client = server
    handle(_event("SessionStart", source="startup"), client)
    fake.lost_recordings = 1  # e.g. the exec server restarted

    output = handle(_event("UserPromptSubmit", prompt="Fix the build"), client)

    assert output is not None
    assert fake.paths() == [
        "/exec/traces",
        "/turns",
        "/exec/traces",
        "/turns",
        "/lesson-retrievals",
    ]
    assert fake.requests[2][1]["trace_id"] == "claude-code:s1"


@pytest.mark.parametrize("status", [500, 422])
def test_a_passing_failure_does_not_open_a_second_recording(server, status):
    fake, client = server
    handle(_event("SessionStart", source="startup"), client)
    fake.failing_turns, fake.failing_status = 1, status

    assert handle(_event("UserPromptSubmit", prompt="hi"), client) is None
    assert fake.paths() == ["/exec/traces", "/turns"]


def test_a_failed_lesson_retrieval_still_starts_the_turn(server):
    fake, client = server
    handle(_event("SessionStart", source="startup"), client)
    fake.failing_lessons = True

    assert handle(_event("UserPromptSubmit", prompt="second"), client) is None
    handle(_event("Stop", last_assistant_message="Done."), client)

    reply = fake.requests[-1][1]
    assert reply["turn_id"] == "turn-1"
    assert reply["call"]["value"]["input"]["messages"][0]["content"][0]["text"] == "second"


def test_a_session_that_could_not_start_is_recorded_from_the_next_prompt(server):
    fake, client = server
    fake.failing_opens = 1
    handle(_event("SessionStart", source="startup"), client)

    assert handle(_event("UserPromptSubmit", prompt="hi"), client) is not None
    assert fake.paths() == ["/exec/traces", "/exec/traces", "/turns", "/lesson-retrievals"]


def test_hooks_without_a_client_time_out_within_the_hook_limit(server, monkeypatch):
    fake, _ = server
    timeouts = []
    real_client = httpx.Client

    def client(**kwargs):
        timeouts.append(kwargs["timeout"])
        return real_client(transport=httpx.MockTransport(fake), **kwargs)

    monkeypatch.setattr("sovara_claude_code._hooks.httpx.Client", client)
    handle(_event("SessionStart", source="startup"))
    assert handle(_event("UserPromptSubmit", prompt="hi")) is not None
    assert timeouts == [REQUEST_TIMEOUT_SECONDS] * 2
