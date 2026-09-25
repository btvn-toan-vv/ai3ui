/**
 * Returns true for a moment whenever `key` changes.
 *
 * Used to flash a panel when its contents change. The point is agent
 * legibility: when the LLM calls `query_genes` or `run_deg`, the panel it
 * touched lights up briefly, so a change you weren't looking at directly
 * still registers in peripheral vision. Without it, the agent silently
 * rewrites a panel and the only evidence is a chat card you may have
 * scrolled past.
 *
 * Deliberately NOT bundled with the LLM tool definitions (`src/llm/`) — it
 * is ordinary UI feedback and fires for manual edits too. `src/llm/` must
 * stay deletable on its own (see its own doc comment / Task 27's invariant
 * check) without taking this along with it.
 */
import { useEffect, useRef, useState } from "react";

export function useFlashOnChange(key: string | number, ms = 1100): boolean {
  const [flashing, setFlashing] = useState(false);
  const previous = useRef(key);

  useEffect(() => {
    // Skip the initial mount — a panel appearing for the first time is not
    // a change the user needs pointed out.
    if (previous.current === key) return;
    previous.current = key;

    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), ms);
    return () => clearTimeout(t);
  }, [key, ms]);

  return flashing;
}
