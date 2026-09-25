/**
 * A persistent strip under the scatter showing what the agent is doing now.
 *
 * Under the plot, not in the chat: it reports on the *app*, not the
 * conversation. (The chat has its own inline status line — see ChatPanel —
 * because while reading the transcript your eyes are over there. Both read
 * the same `useAgentPhase` hook, so they can never disagree.)
 *
 * The error state matters: a failed run used to be visually silent — the
 * runtime logged `agent_run_error_event` to the console and the chat showed
 * nothing at all. This is where that surfaces.
 */
import { useAgentPhase } from "../hooks/useAgentPhase";

export function AgentActivityBar() {
  const { phase, reasoning, isBusy, stop, label } = useAgentPhase();

  let detail: string | null = null;
  let detailClass = "agent-activity-bar-detail";
  if (phase.kind === "thinking") detail = reasoning || null;
  if (phase.kind === "calling") {
    detail = phase.tool;
    detailClass += " agent-activity-bar-tool";
  }
  if (phase.kind === "error") detail = phase.message;

  const barClass =
    "agent-activity-bar" +
    (phase.kind === "error" ? " is-error" : "") +
    (phase.kind === "idle" ? " is-idle" : "");

  return (
    <div className={barClass} role="status" aria-live="polite">
      <span className="agent-activity-bar-icon" aria-hidden="true">
        {phase.kind === "error" ? (
          "⚠️"
        ) : isBusy ? (
          <span className="agent-activity-bar-spinner" />
        ) : (
          <span className="agent-activity-bar-dot" />
        )}
      </span>
      <span className="agent-activity-bar-label">{label}</span>
      {detail && <span className={detailClass}>{detail}</span>}

      {/* `stopAgent` aborts the AbortSignal handed to every tool handler, so
          an in-flight DEG fetch is cancelled too. */}
      {isBusy && (
        <button type="button" className="agent-activity-bar-stop" onClick={stop}>
          Stop
        </button>
      )}
    </div>
  );
}
