/**
 * Manual gene input: a real control, not a demo affordance. Pressing Enter
 * calls the SAME `displayGenes` fetch-then-store path that a clicked DEG row
 * uses (`DegPanel.tsx`) and that the LLM's `query_genes` tool will use from
 * Task 14 on. Chips show what's currently displayed, each with its real
 * observed range and a remove button.
 */
import { useEffect, useRef, useState } from "react";
import { useViewStore } from "../state/useViewStore";
import { displayGenes } from "../lib/geneDisplay";
import { formatFixed } from "../lib/format";
import { MAX_GENES } from "../lib/constants";

export function GenePanel() {
  const { genes, showGenes, setError } = useViewStore();
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const submit = async () => {
    const symbol = input.trim();
    if (!symbol) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPending(true);
    try {
      await displayGenes(
        [symbol],
        genes,
        { showGenes, setError },
        controller.signal
      );
    } finally {
      if (abortRef.current === controller) setPending(false);
    }
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const removeGene = (gene: string) => {
    showGenes(genes.filter((g) => g.gene !== gene));
  };

  const atCap = genes.length >= MAX_GENES;

  return (
    <div className="gene-panel">
      <div className="gene-panel-input-row">
        <input
          type="text"
          className="gene-panel-input"
          placeholder="Type a gene symbol, e.g. MS4A1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Gene symbol"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending || !input.trim()}
        >
          {pending ? "Looking up…" : "Show"}
        </button>
      </div>
      {atCap && (
        <div className="gene-panel-hint">
          {MAX_GENES} genes displayed — remove one to add another.
        </div>
      )}
      <ul className="gene-chip-list" aria-label="Displayed genes">
        {genes.map((g) => (
          <li key={g.gene} className="gene-chip">
            <span className="gene-chip-name">{g.gene}</span>
            <span className="gene-chip-range">
              {formatFixed(g.min)}–{formatFixed(g.max)}
            </span>
            <button
              type="button"
              className="gene-chip-remove"
              aria-label={`Remove ${g.gene}`}
              onClick={() => removeGene(g.gene)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
