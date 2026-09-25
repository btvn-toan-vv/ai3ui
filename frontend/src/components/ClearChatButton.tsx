/**
 * Clears the chat transcript.
 *
 * Deliberately does NOT touch the view store. Clearing the conversation should
 * not wipe the scatter, the displayed genes, or the marker table — you often
 * want to start a fresh line of questioning about the same view. "Reset" in
 * the toolbar is the control that clears the *view*; this one clears the
 * *conversation*. Two different things, two different buttons.
 */
import { useChat } from "@bioturing-org/ai2ui";

export function ClearChatButton() {
  const { clear } = useChat();

  return (
    <button
      type="button"
      className="clear-chat-button"
      onClick={clear}
      title="Clear the conversation (the plot and panels stay as they are)"
    >
      Clear chat
    </button>
  );
}
