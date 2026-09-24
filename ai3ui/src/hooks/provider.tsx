import {
  createContext,
  useContext as useReactContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { BridgeConnection } from "../connection";
import type { ConnectionState } from "../connection";
import { Registry } from "../registry";

export type BridgeContextValue = {
  registry: Registry;
  connection: BridgeConnection;
  /** Live connection snapshot (status, error, sessionId, mcpUrl, postUrl). */
  connectionState: ConnectionState;
};

const BridgeContext = createContext<BridgeContextValue | null>(null);

export type AI3UIProviderProps = {
  /** Base URL of the mcp-adapter server, e.g. `http://localhost:8080`. */
  serverUrl: string;
  children: ReactNode;
};

/**
 * Owns the registry and the bridge connection for a subtree. Exactly one
 * `Registry` + `BridgeConnection` pair is created per mounted provider; they
 * survive re-renders and StrictMode double effects (connect/close are
 * idempotent).
 */
export function AI3UIProvider({ serverUrl, children }: AI3UIProviderProps) {
  const [bridge] = useState(() => {
    const registry = new Registry();
    return { registry, connection: new BridgeConnection(registry, serverUrl) };
  });

  useEffect(() => {
    bridge.connection.setServerUrl(serverUrl);
    bridge.connection.connect();
    return () => bridge.connection.close();
  }, [bridge.connection, serverUrl]);

  const connectionState = useSyncExternalStore(
    bridge.connection.subscribe,
    bridge.connection.getSnapshot,
  );

  const value = useMemo<BridgeContextValue>(
    () => ({
      registry: bridge.registry,
      connection: bridge.connection,
      connectionState,
    }),
    [bridge, connectionState],
  );

  return (
    <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>
  );
}

/** Registry + connection for the enclosing {@link AI3UIProvider}. */
export function useBridgeContext(): BridgeContextValue {
  const value = useReactContext(BridgeContext);
  if (value === null) {
    throw new Error(
      "ai3ui hooks must be used inside an <AI3UIProvider serverUrl={...}>.",
    );
  }
  return value;
}
