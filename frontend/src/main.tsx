import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AI3UIProvider } from "ai3ui";
import { App } from "./App";
import "./styles.css";

/** mcp-adapter backend. */
const SERVER_URL = "http://localhost:8123";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AI3UIProvider serverUrl={SERVER_URL}>
      <App />
    </AI3UIProvider>
  </StrictMode>,
);
