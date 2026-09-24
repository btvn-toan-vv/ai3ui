import { toJsonSchema } from "./schema";
import type {
  ContextDefinition,
  SliceWire,
  ToolDefinition,
  ToolHandlerCtx,
  ToolResult,
  ToolWire,
} from "./types";

/**
 * A tool as the registry sees it. The hooks register thin wrappers whose
 * getters re-read the latest render, so every field except `name` may change
 * under the registry's feet — the registry never caches them.
 */
export type RegisteredTool = {
  name: string;
  description: string;
  params: unknown;
  available: boolean;
  handler: (
    args: unknown,
    ctx: ToolHandlerCtx,
  ) => unknown | Promise<unknown>;
};

/** Outcome of executing one tool call, shaped for the `call_result` wire message. */
export type CallResult = {
  ok: boolean;
  message: string;
  data?: unknown;
  hint?: string;
};

/** Full registry state, as pushed to the adapter after (re)connect. */
export type RegistrySnapshot = {
  tools: ToolWire[];
  context: SliceWire[];
};

type RegistryListener = () => void;

type ZodIssue = { path: ReadonlyArray<string | number>; message: string };
type ZodParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { issues: ZodIssue[] } };
type ZodLike = { safeParse: (input: unknown) => ZodParseResult };

function isZodLike(params: unknown): params is ZodLike {
  return (
    typeof params === "object" &&
    params !== null &&
    typeof (params as ZodLike).safeParse === "function"
  );
}

function formatZodIssues(issues: ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.join(".") || "(root)";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * The local registry: the frontend's source of truth for tools and context
 * slices. Pure data + notification — it knows nothing about the network; the
 * connection layer diffs consecutive versions and pushes changes.
 */
export class Registry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly context = new Map<string, ContextDefinition>();
  private readonly listeners = new Set<RegistryListener>();

  /**
   * Bumped on every mutation. Its value is also all the subscription state
   * `useSyncExternalStore` needs: same version ⇒ same snapshot.
   */
  get version(): number {
    return this._version;
  }
  private _version = 0;

  /** Cache for `getLists` — stable identity while `version` is unchanged. */
  private listsCache: {
    version: number;
    value: { tools: ToolDefinition[]; context: ContextDefinition[] };
  } = { version: -1, value: { tools: [], context: [] } };

  // Arrow properties: `subscribe`/`getLists` double as stable
  // `useSyncExternalStore` arguments, so they must keep their identity.
  readonly subscribe = (listener: RegistryListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Lists of currently registered tools/slices (masked tools included). */
  readonly getLists = (): {
    tools: ToolDefinition[];
    context: ContextDefinition[];
  } => {
    if (this.listsCache.version !== this._version) {
      this.listsCache = {
        version: this._version,
        value: {
          // RegisteredTool is structurally a ToolDefinition with unknown args.
          tools: [...this.tools.values()] as ToolDefinition[],
          context: [...this.context.values()],
        },
      };
    }
    return this.listsCache.value;
  };

  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
    this.bump();
  }

  /**
   * Removes a tool by name. When `expected` is given, the entry is only
   * removed if it is still that exact registration — a stale teardown must
   * not clobber a same-named replacement.
   */
  unregisterTool(name: string, expected?: RegisteredTool): void {
    const current = this.tools.get(name);
    if (current === undefined) return;
    if (expected !== undefined && current !== expected) return;
    this.tools.delete(name);
    this.bump();
  }

  registerContext(slice: ContextDefinition): void {
    this.context.set(slice.key, slice);
    this.bump();
  }

  unregisterContext(key: string, expected?: ContextDefinition): void {
    const current = this.context.get(key);
    if (current === undefined) return;
    if (expected !== undefined && current !== expected) return;
    this.context.delete(key);
    this.bump();
  }

  /** Wire-shaped snapshot: live reads of every tool/slice, schemas converted. */
  snapshot(): RegistrySnapshot {
    return {
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: toJsonSchema(tool.params, tool.name),
        available: tool.available,
      })),
      context: [...this.context.values()].map((slice) => ({
        key: slice.key,
        description: slice.description,
        value: slice.value,
        volatile: slice.volatile,
      })),
    };
  }

  /**
   * Execution entry point for inbound `tool_call` events. Never rejects:
   * every failure mode is a structured `{ ok: false, ... }`.
   */
  async execute(
    callName: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<CallResult> {
    const tool = this.tools.get(callName);
    if (tool === undefined) {
      return { ok: false, message: `Tool "${callName}" is not registered` };
    }

    let parsed: unknown = args;
    if (isZodLike(tool.params)) {
      const result = tool.params.safeParse(args);
      if (!result.success) {
        return {
          ok: false,
          message:
            `Invalid arguments for tool "${callName}": ` +
            formatZodIssues(result.error.issues),
        };
      }
      parsed = result.data;
    }

    let result: ToolResult | string | void;
    try {
      result = (await tool.handler(parsed, { signal })) as
        | ToolResult
        | string
        | void;
    } catch (err) {
      return { ok: false, message: String(err) };
    }
    if (signal.aborted) {
      // The connection drops aborted results anyway; keep execute honest.
      return { ok: false, message: `Tool "${callName}" was cancelled` };
    }
    if (typeof result === "string") {
      return { ok: true, message: result };
    }
    if (result === undefined) {
      return { ok: true, message: "Done." };
    }
    const out: CallResult = {
      ok: result.ok,
      message: result.message,
    };
    if (result.ok && result.data !== undefined) out.data = result.data;
    if (!result.ok && result.hint !== undefined) out.hint = result.hint;
    return out;
  }

  private bump(): void {
    this._version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
