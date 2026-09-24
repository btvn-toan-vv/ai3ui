import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AI3UIProvider } from "ai3ui";
import { App } from "./App";
import "./styles.css";

/**
 * mcp-adapter backend. Empty = same origin: nginx (prod) and the vite proxy
 * (dev) forward /sessions and /{sessionId}/mcp to the adapter, so the page
 * never makes a cross-origin call regardless of how the UI itself is
 * reached (tunnels, forwarded ports, remote hosts). VITE_SERVER_URL
 * overrides when the adapter lives on another origin entirely.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AI3UIProvider serverUrl={SERVER_URL}>
      <App />
    </AI3UIProvider>
  </StrictMode>,
);
