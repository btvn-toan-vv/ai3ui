/**
 * The agent's current phase, plus a way to stop it.
 *
 * Extracted from `AgentActivityBar` because two surfaces need the same
 * answer: the bar under the plot, and the inline status header in the chat
 * panel. One subscription shape, one label vocabulary — if these drifted
 * apart the app would be telling the user two different things about the
 * same run.
 *
 * Built entirely on `useChat()` — `status`, `connectionStatus`, `error` and
 * `stop` come straight from the hook, so there is no manual
 * subscribe/unsubscribe bookkeeping and no `activeAgentRef` to keep in sync
 * by hand; the engine already tracks all of that.
 *
 * One phase from the old implementation does not survive: "applying" (the
 * moment between a tool finishing and the model's next words) doesn't
 * correspond to anything `EngineSnapshot` exposes directly — there is no
 * event between "this tool call has a result" and "the next round is
 * streaming" that this hook can see. It folds into "thinking" rather than
 * being reconstructed from a guess. Nothing outside this file depended on
 * the literal "applying" tag.
 */
import { useMemo } from "react";
import { useChat, type Message } from "@bioturing-org/ai2ui";

export type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "calling"; tool: string }
  | { kind: "error"; message: string };

/** Human-readable label for a phase. Shared so the bar and the chat agree. */
export function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case "idle":
      return "Ready";
    case "thinking":
      return "Thinking";
    case "calling":
      return `Calling ${phase.tool}`;
    case "error":
      return "Agent error";
  }
}

function hasResult(messages: Message[], toolCallId: string): boolean {
  return messages.some((m) => m.role === "tool" && m.toolCallId === toolCallId);
}

/**
 * Walks backward for the most recent assistant turn. If it made tool calls
 * that don't all have a result yet, the agent is "calling" (still executing,
 * or about to). Otherwise — a plain text turn, or one whose tool calls are
 * all resolved — the agent is "thinking" (covers text/reasoning streaming
 * and the gap before the next round's first token, since the engine does
 * not expose a narrower signal for that gap).
 */
function derivePhase(messages: Message[], status: "idle" | "running" | "error", error: string | undefined): Phase {
  if (status === "error") return { kind: "error", message: error ?? "The agent hit an error." };
  if (status !== "running") return { kind: "idle" };

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (!m.toolCalls?.length) break;
    const pending = m.toolCalls.find((c) => !hasResult(messages, c.id));
    return pending ? { kind: "calling", tool: pending.name } : { kind: "thinking" };
  }
  return { kind: "thinking" };
}

export function useAgentPhase() {
  const { messages, status, error, stop } = useChat();

  const phase = useMemo(() => derivePhase(messages, status, error), [messages, status, error]);

  // Live reasoning text only while it's the most recent thing in the
  // transcript — the instant a tool call or a settled text message follows
  // it, it is no longer "happening now". Matches the old buffer's lifetime:
  // populated while streaming, cleared once the run moves on.
  const last = messages[messages.length - 1];
  const reasoning = phase.kind === "thinking" && last?.role === "reasoning" ? last.content : "";

  const isBusy = phase.kind === "thinking" || phase.kind === "calling";

  return { phase, reasoning, isBusy, stop, label: phaseLabel(phase) };
}
