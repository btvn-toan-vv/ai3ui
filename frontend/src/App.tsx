import { useState } from "react";
import { useContext, useRegistry, useTool } from "ai3ui";
import { z } from "zod";

/** mcp-adapter backend — not implemented yet. */
const REGISTRY_SERVER_URL = "http://localhost:8000";

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

  // Streams the registry from the backend over SSE — masked tools included.
  const { tools, context, status, error } = useRegistry(REGISTRY_SERVER_URL);

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
        <h2>Registry server</h2>
        <p>
          <code>{REGISTRY_SERVER_URL}</code> — {status}
          {error && <em> ({error.message})</em>}
        </p>

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
