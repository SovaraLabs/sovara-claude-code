/**
 * Record a Claude Code session in Sovara from its hook events.
 *
 * Hooks run as separate processes, so the session's recording is shared through a handle
 * (`openRecording`) kept in the session's state file. A hook never blocks Claude Code: failures
 * are swallowed and requests retry only briefly.
 */
import { basename } from "node:path";
import {
  closeRecording,
  exportRecording,
  openRecording,
  RecordingError,
  recordStep,
  resumeRecording,
  retrieveLessons,
  SovaraConfigError,
  startTurn,
  type Call,
  type Execution,
  type JsonObject,
  type Message,
  type Outcome,
} from "@sovara/sdk";
import { flushRecordings, jsonValue, withShortRetries } from "@sovara/sdk/integration";
import { load, prune, remove, save, type SessionState } from "./state.js";

export type HookEvent = { hook_event_name?: string; session_id?: string; [field: string]: unknown };
type Options = { fetch?: typeof globalThis.fetch };
type Handler = (event: HookEvent & { session_id: string }, options: Options) => Promise<string | null>;

/** Per-request timeout, so a hook's usual three requests fit in the 15 s Claude Code allows it. */
export const REQUEST_TIMEOUT_MS = 4_000;
/** How long a hook waits, before exiting, for reports the SDK sends in the background. */
const FLUSH_MS = REQUEST_TIMEOUT_MS;

/** Wrap `fetch` so each request is aborted after REQUEST_TIMEOUT_MS. */
function withTimeout(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetcher(input, { ...init, signal });
  };
}

/** Errors meaning the recording no longer exists; an unknown write token is a 403 SovaraConfigError. */
const LOST_RECORDING = new Set(["recording_inactive", "not_found"]);

function projectName(event: HookEvent): string {
  const configured = process.env.SOVARA_PROJECT?.trim();
  return configured || basename(String(event.cwd ?? process.cwd())) || "claude-code";
}

function textMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

/** Open a recording of the session's trace; the same session always gets the same trace. */
function open(event: HookEvent & { session_id: string }, options: Options): Promise<string> {
  return openRecording({
    projectName: projectName(event),
    name: "Claude Code session",
    traceId: `claude-code:${event.session_id}`,
    fetch: options.fetch,
  });
}

async function sessionStart(event: HookEvent & { session_id: string }, options: Options) {
  prune();
  if (load(event.session_id) !== null) return null;
  save(event.session_id, { session: await open(event, options), turn: null, prompt: null });
  return null;
}

function beginTurn(session: string, prompt: string, options: Options): Promise<string | null> {
  return resumeRecording(session, async () => {
    await startTurn(prompt);
    return exportRecording();
  }, { fetch: options.fetch });
}

function lessonsFor(handle: string, prompt: string, options: Options) {
  return resumeRecording(handle, () => retrieveLessons(prompt), { fetch: options.fetch });
}

async function userPromptSubmit(event: HookEvent & { session_id: string }, options: Options) {
  let state = load(event.session_id);
  if (state === null) {
    // SessionStart could not open the recording; the trace key is stable, so open it now.
    state = { session: await open(event, options), turn: null, prompt: null };
    save(event.session_id, state);
  }
  const prompt = String(event.prompt ?? "");
  let turn: string | null;
  try {
    turn = await beginTurn(state.session, prompt, options);
  } catch (error) {
    // Only a recording the exec server lost (e.g. after a restart) is reopened; a passing
    // failure must not open a second recording of the session.
    const lost = (error instanceof SovaraConfigError && error.status === 403)
      || (error instanceof RecordingError && LOST_RECORDING.has(error.code));
    if (!lost) throw error;
    state = { ...state, session: await open(event, options) };
    turn = await beginTurn(state.session, prompt, options);
  }
  // Saved before retrieving lessons, so later steps join this turn even if retrieval fails.
  state = { ...state, turn, prompt, lessons: null };
  save(event.session_id, state);
  let lessons = null;
  if (prompt) {
    try {
      lessons = await lessonsFor(turn ?? state.session, prompt, options);
    } catch (error) {
      if (!(error instanceof RecordingError)) throw error;
    }
  }
  if (!lessons) return null;
  // Kept until Stop, which records them as part of the input of the turn's model step.
  save(event.session_id, { ...state, lessons: { text: lessons.text, retrieval_id: lessons.retrieval_id } });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lessons.text },
  });
}

async function record(
  state: SessionState, call: Call, outcome: Outcome, options: Options, execution?: Execution,
): Promise<void> {
  await resumeRecording(state.turn ?? state.session, () => recordStep(call, outcome, { execution }), {
    fetch: options.fetch,
  });
}

function toolCall(event: HookEvent): Call {
  const args = jsonValue(event.tool_input);
  return {
    kind: "tool",
    name: String(event.tool_name ?? "tool"),
    arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : { input: args }) as JsonObject,
    call_id: String(event.tool_use_id ?? "").trim() || null,
    metadata: { source: "claude-code" },
  };
}

async function postToolUse(event: HookEvent & { session_id: string }, options: Options) {
  const state = load(event.session_id);
  if (state) await record(state, toolCall(event), { status: "success", output: jsonValue(event.tool_response) }, options);
  return null;
}

async function postToolUseFailure(event: HookEvent & { session_id: string }, options: Options) {
  const state = load(event.session_id);
  const outcome: Outcome = { status: "error", error: { type: "ToolError", message: String(event.error ?? "") } };
  if (state) await record(state, toolCall(event), outcome, options);
  return null;
}

async function stop(event: HookEvent & { session_id: string }, options: Options) {
  const state = load(event.session_id);
  const reply = String(event.last_assistant_message ?? "");
  if (!state || !reply || event.stop_hook_active) return null;
  const messages = state.prompt ? [textMessage("user", state.prompt)] : [];
  const call: Call = {
    kind: "llm",
    provider: "anthropic",
    input: { format: "conversation", messages },
    metadata: { source: "claude-code" },
  };
  const lessons = state.lessons;
  // Claude Code added the lessons to the prompt. Reporting them as a user message after it, as
  // the SDK expects, ties the retrieval to this step.
  const execution: Execution | undefined = lessons
    ? {
      input: { format: "conversation", messages: [...messages, textMessage("user", lessons.text)] },
      injected_retrieval_id: lessons.retrieval_id,
    }
    : undefined;
  const outcome: Outcome = { status: "success", output: { message: textMessage("assistant", reply) } };
  await record(state, call, outcome, options, execution);
  // A retrieval belongs to one step.
  if (lessons) save(event.session_id, { ...state, lessons: null });
  return null;
}

async function sessionEnd(event: HookEvent & { session_id: string }, options: Options) {
  const state = load(event.session_id);
  if (!state) return null;
  try {
    await closeRecording(state.session, { fetch: options.fetch });
  } finally {
    remove(event.session_id);
  }
  return null;
}

const HANDLERS: Record<string, Handler> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PostToolUse: postToolUse,
  PostToolUseFailure: postToolUseFailure,
  Stop: stop,
  SessionEnd: sessionEnd,
};

/**
 * Run the handler for one hook event; resolve to text for Claude Code, or null.
 *
 * Never rejects: a failure is logged by type only and the session continues unrecorded.
 */
export async function handle(event: HookEvent, options: Options = {}): Promise<string | null> {
  const handler = HANDLERS[String(event.hook_event_name)];
  if (!handler || !event.session_id) return null;
  try {
    const timed = { ...options, fetch: withTimeout(options.fetch ?? globalThis.fetch) };
    const output = await withShortRetries(() => handler(event as HookEvent & { session_id: string }, timed));
    // The hook process exits right after; let reports queued in the background finish.
    await flushRecordings(FLUSH_MS);
    return output;
  } catch (error) {
    const type = error instanceof Error ? error.name : typeof error;
    console.error(`[sovara] Claude Code hook failed event=${String(event.hook_event_name)} error_type=${type}`);
    return null;
  }
}
