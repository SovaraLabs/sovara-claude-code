import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle, REQUEST_TIMEOUT_MS } from "../src/hooks.js";
import { load } from "../src/state.js";

const TOKEN = "write-token-secret";
const HEALTH = {
  status: "ok",
  service: "sovara-exec-server",
  compatibility: { component: "exec-server", contracts: { "runner-api": [6] } },
};

/** A fake exec server answering the runner-api 6 routes the hooks use. */
function fakeServer(lessons: string | null = "Run the tests first.") {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const lost = { recordings: 0, failingTurns: 0, failingStatus: 500, failingLessons: false, failingOpens: 0 };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/exec/health") return Response.json(HEALTH);
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ path, body });
    if (path === "/exec/traces" && lost.failingOpens > 0) {
      lost.failingOpens -= 1;
      return Response.json({ error: "internal_error", message: "x" }, { status: 500 });
    }
    if (path === "/exec/traces") {
      return Response.json({
        trace_id: "trace-1", recording_id: "rec-1", project_id: "project-1", appended: false,
        trace_write_token: TOKEN,
      });
    }
    if (path.endsWith("/turns")) {
      if (lost.failingTurns > 0) {
        lost.failingTurns -= 1;
        return Response.json({ error: "x", message: "x" }, { status: lost.failingStatus });
      }
      if (lost.recordings > 0) {
        lost.recordings -= 1;
        return Response.json({ error: "recording_inactive", message: "Not active." }, { status: 409 });
      }
      return Response.json({ turn_id: "turn-1", recording_id: "rec-1" });
    }
    if (path.endsWith("/lesson-retrievals") && lost.failingLessons) {
      return Response.json({ error: "internal_error", message: "x" }, { status: 500 });
    }
    if (path.endsWith("/lesson-retrievals")) {
      return Response.json({ ok: true, lesson_context: lessons ? { text: lessons, retrieval_id: "r1" } : null });
    }
    if (path.endsWith("/steps/record")) return Response.json({ ok: true, step_uuid: body.step_uuid });
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const paths = () => requests.map((r) => r.path.replace("/exec/traces/trace-1", "") || r.path);
  return { fetch, requests, paths, lost };
}

const event = (name: string, fields: Record<string, unknown> = {}) => ({
  hook_event_name: name, session_id: "s1", cwd: "/work/my-repo", ...fields,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sovara-claude-code-"));
  vi.stubEnv("CLAUDE_PLUGIN_DATA", dir);
  vi.stubEnv("SOVARA_EXEC_SERVER_URL", "http://exec.test");
});

describe("Claude Code hooks", () => {
  it("records a session with lessons, tool calls and the reply", async () => {
    const server = fakeServer();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = (name: string, fields?: Record<string, unknown>) => handle(event(name, fields), { fetch: server.fetch });

    expect(await run("SessionStart", { source: "startup" })).toBeNull();
    const output = await run("UserPromptSubmit", { prompt: "Fix the build" });
    await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "make" }, tool_response: { stdout: "ok" }, tool_use_id: "t1" });
    await run("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "x" }, error: "Exit code 1", tool_use_id: "t2" });
    await run("Stop", { last_assistant_message: "Fixed it." });
    await run("SessionEnd", { reason: "other" });

    expect(JSON.parse(output!).hookSpecificOutput.additionalContext).toBe("Run the tests first.");
    expect(server.paths()).toEqual([
      "/exec/traces", "/turns", "/lesson-retrievals", "/steps/record", "/steps/record", "/steps/record", "/complete",
    ]);
    expect([server.requests[0].body.project_name, server.requests[0].body.trace_id]).toEqual(["my-repo", "claude-code:s1"]);
    const [tool, failed, reply] = server.requests.filter((r) => r.path.endsWith("/record")).map((r) => r.body);
    expect([tool.call.value.name, tool.turn_id]).toEqual(["Bash", "turn-1"]);
    expect(failed.outcome.value.status).toBe("error");
    expect(reply.outcome.value.output.message.content[0].text).toBe("Fixed it.");
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
  });

  it("reopens a recording the server lost at the next prompt", async () => {
    const server = fakeServer();
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });
    server.lost.recordings = 1; // e.g. the exec server restarted

    const output = await handle(event("UserPromptSubmit", { prompt: "Fix the build" }), { fetch: server.fetch });

    expect(output).not.toBeNull();
    expect(server.paths()).toEqual(["/exec/traces", "/turns", "/exec/traces", "/turns", "/lesson-retrievals"]);
    expect(server.requests[2].body.trace_id).toBe("claude-code:s1");
  });

  it.each([500, 422])("does not open a second recording after a passing failure (HTTP %i)", async (status) => {
    const server = fakeServer();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });
    server.lost.failingTurns = 1;
    server.lost.failingStatus = status;

    expect(await handle(event("UserPromptSubmit", { prompt: "hi" }), { fetch: server.fetch })).toBeNull();
    expect(server.paths()).toEqual(["/exec/traces", "/turns"]);
  });

  it("starts the turn even when lesson retrieval fails", async () => {
    const server = fakeServer();
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });
    server.lost.failingLessons = true;

    expect(await handle(event("UserPromptSubmit", { prompt: "second" }), { fetch: server.fetch })).toBeNull();
    await handle(event("Stop", { last_assistant_message: "Done." }), { fetch: server.fetch });

    const reply = server.requests.at(-1)!.body;
    expect(reply.turn_id).toBe("turn-1");
    expect(reply.call.value.input.messages[0].content[0].text).toBe("second");
  });

  it("records a session that could not start from the next prompt", async () => {
    const server = fakeServer();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    server.lost.failingOpens = 1;
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });

    expect(await handle(event("UserPromptSubmit", { prompt: "hi" }), { fetch: server.fetch })).not.toBeNull();
    expect(server.paths()).toEqual(["/exec/traces", "/exec/traces", "/turns", "/lesson-retrievals"]);
  });

  it("keeps the recording of a resumed session", async () => {
    const server = fakeServer();
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });
    await handle(event("SessionStart", { source: "resume" }), { fetch: server.fetch });
    expect(server.paths()).toEqual(["/exec/traces"]);
  });

  // An unreachable server is retried for the SDK's 5 s budget, within Claude Code's 15 s limit.
  it("keeps state private and never lets a failure reach Claude Code", { timeout: 15_000 }, async () => {
    const server = fakeServer();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handle(event("SessionStart", { source: "startup" }), { fetch: server.fetch });
    expect(statSync(join(dir, "s1.json")).mode & 0o777).toBe(0o600);

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await handle(event("UserPromptSubmit", { prompt: "hi" }), { fetch: down })).toBeNull();
    expect(await handle({ hook_event_name: "Unknown" })).toBeNull();
    expect(() => load("../escape")).toThrow();
  });

  it("gives every request a timeout that fits inside the hook limit", async () => {
    const server = fakeServer();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return server.fetch(input, init);
    }) as typeof globalThis.fetch;
    await handle(event("SessionStart", { source: "startup" }), { fetch });
    expect(await handle(event("UserPromptSubmit", { prompt: "hi" }), { fetch })).not.toBeNull();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(REQUEST_TIMEOUT_MS * 3).toBeLessThan(15_000);
  });
});
