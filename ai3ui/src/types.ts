/**
 * Core vocabulary for the hooks, ported from ai2ui's core types.
 *
 * Schema-agnostic on purpose: `params` accepts any zod-like schema without a
 * hard zod dependency — `SchemaOutput` reads the schema's inferred output
 * structurally, the same thing `z.infer` does.
 */

/** Pulls the output type out of a zod-like schema (the shape of `z.infer`). */
export type SchemaOutput<S> = S extends { _output: infer O } ? O : unknown;

export type ToolResult<T = unknown> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string; hint?: string; endTurn?: true };

export type ToolHandlerCtx = {
  signal: AbortSignal;
  route?: string;
};

/** Everything `useTool` takes. */
export type ToolDefinition<S = any> = {
  name: string;
  description: string;
  params: S;
  handler: (
    args: SchemaOutput<S>,
    ctx: ToolHandlerCtx,
  ) => ToolResult | string | void | Promise<ToolResult | string | void>;
  /**
   * The masking field. `false` hides the tool from the model without
   * unmounting the hook. Re-read on every render, so gating it on component
   * state masks and unmasks the tool live.
   */
  available?: boolean;
  // Card customisation (render/header/content/footer/title/…) lands with the
  // UI layer — declared later.
};

/** Everything `useContext` takes: one slice of app state the model reads on every message. */
export type ContextDefinition = {
  key: string;
  description: string;
  value: string;
  volatile: boolean;
};

/** A tool as it crosses the wire to mcp-adapter (`schema` is plain JSON Schema). */
export type ToolWire = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  available: boolean;
};

/** A context slice as it crosses the wire to mcp-adapter. */
export type SliceWire = {
  key: string;
  description: string;
  value: string;
  volatile: boolean;
};
