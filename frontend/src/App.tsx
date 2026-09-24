import { useState } from "react";
import { useContext, useRegistry, useTool } from "ai3ui";
import { z } from "zod";

export function App() {
  const [count, setCount] = useState(0);

  // State registration: the model reads this slice on every message.
  useContext({
    key: "counter",
    description: "The current counter value shown on screen.",
    value: String(count),
    volatile: true,
  });

  // Tool registration: lets the model act on the app.
  useTool({
    name: "increment_counter",
    description: "Increments the on-screen counter.",
    params: z.object({
      by: z.number().int().min(1).default(1).describe("How much to add."),
    }),
    handler: ({ by }) => {
      setCount((c) => c + by);
      return `Added ${by}.`;
    },
  });

  // Tool masking: hidden from the model until the counter reaches 10.
  useTool({
    name: "reset_counter",
    description: "Resets the counter to zero.",
    params: z.object({}),
    available: count >= 10,
    handler: () => {
      setCount(0);
      return "Counter reset.";
    },
  });

  // Live view of the local registry plus the bridge connection. Tools and
  // context registered above stream to the adapter automatically; masked
  // tools stay listed here but are hidden from MCP clients server-side.
  const { tools, context, sessionId, mcpUrl, docsUrl, status, error } = useRegistry();

  return (
    <main className="app">
      <header>
        <h1>ai3ui scaffold</h1>
      </header>

      <section className="counter">
        <p className="count">{count}</p>
        <button onClick={() => setCount((c) => c + 1)}>+1</button>
      </section>

      <section className="debug">
        <h2>Bridge</h2>
        <p>
          {status}
          {error && <em> ({error.message})</em>}
        </p>
        {sessionId && (
          <p>
            session <code>{sessionId}</code>
            <br />
            MCP endpoint <code>{mcpUrl}</code>
            {docsUrl && (
              <>
                {" — "}
                <a href={docsUrl} target="_blank" rel="noreferrer">
                  docs
                </a>
              </>
            )}
          </p>
        )}

        <h2>Registered tools</h2>
        <ul>
          {tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              {t.available === false && <em> (masked)</em>}
            </li>
          ))}
        </ul>

        <h2>Registered context</h2>
        <ul>
          {context.map((c) => (
            <li key={c.key}>
              <code>{c.key}</code>: {c.value}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
