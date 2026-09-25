/**
 * Mounts the chat panel in the right column, with a live status header
 * pinned above the transcript.
 *
 * The status also appears in `AgentActivityBar` under the plot, and that is
 * deliberate rather than redundant: while you are reading the transcript your
 * eyes are here, not on the far side of the window. Both read the same
 * `useAgentPhase` hook, so they cannot disagree.
 */
import { Chat } from "@bioturing-org/ai2ui";
import { useAgentPhase } from "../hooks/useAgentPhase";

/**
 * `Chat.Panel`'s `header` prop is a plain `ReactNode`, not a slot component
 * — `ChatPanel` below passes `<ChatStatusHeader />`, an already-rendered
 * element. Idle renders an empty fragment rather than `null` so the header
 * row's presence doesn't flicker in and out of the DOM on every phase change.
 */
function ChatStatusHeader() {
  const { phase, reasoning, isBusy, stop, label } = useAgentPhase();

  // Idle is the resting state — a permanent "Ready" line above the
  // transcript would just be furniture.
  if (phase.kind === "idle") return <></>;

  return (
    <div
      className={`chat-status${phase.kind === "error" ? " is-error" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="chat-status-icon" aria-hidden="true">
        {phase.kind === "error" ? "⚠️" : <span className="chat-status-dot" />}
      </span>
      <span className="chat-status-label">{label}</span>
      {/* Live reasoning, truncated by CSS — a hint that thinking is happening,
          not a second transcript. The full text is in the collapsible
          reasoning panel the message view already renders. */}
      {phase.kind === "thinking" && reasoning && (
        <span className="chat-status-detail">{reasoning}</span>
      )}
      {phase.kind === "error" && (
        <span className="chat-status-detail">{phase.message}</span>
      )}
      {isBusy && (
        <button type="button" className="chat-status-stop" onClick={stop}>
          Stop
        </button>
      )}
    </div>
  );
}

export function ChatPanel() {
  // This app is light-only, so the chat is pinned to light rather than
  // following the OS. Without it, a dark-mode OS gave the chat a dark palette
  // while `.chat-panel` kept painting the surface white — unreadable text.
  return <Chat.Panel className="chat-panel" header={<ChatStatusHeader />} />;
}
