/**
 * Every decision here follows from behaviour measured in Chrome 152 rather than from the
 * published documentation — see `docs/webmcp-findings.md`. The three that shape this file:
 *
 *   1. The browser does not validate `inputSchema` at all. Missing required properties, wrong
 *      types and undeclared extras all reach the handler. So we validate here, every call.
 *   2. Throwing inside a handler reaches the agent as an opaque `UnknownError` with the real
 *      message stripped, leaving it no way to recover. So nothing throws; failures come back
 *      as a structured error inside the normal envelope.
 *   3. There is no `unregisterTool`, and a duplicate name is rejected with `InvalidStateError`.
 *      Unregistration happens only by aborting a signal handed in at registration time, so we
 *      keep one `AbortController` per tool and diff the desired surface against the live one.
 *
 * The envelope itself is specified in `docs/agent-interface.md`.
 */

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

export type JsonSchema = {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
};

export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  items?: { type: 'string' | 'number' | 'integer' };
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, PropertySchema>;
  default?: unknown;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  /**
   * Set on anything returning content this application did not author — population labels
   * curated elsewhere, free text a user typed into a note. The platform's own signal that a
   * payload is data and must never be read as instructions.
   */
  untrustedContentHint?: boolean;
}

export interface NextAction {
  why: string;
  call: string;
  args?: Record<string, unknown>;
}

export interface ToolError {
  code: string;
  message: string;
  /** The call that repairs this failure. An error must always name its own way out. */
  fix?: { call: string; args?: Record<string, unknown> };
}

export interface ToolOutcome {
  data?: unknown;
  /** What this call changed on the human's screen. Empty for reads and dry runs. */
  did?: string[];
  next?: NextAction[];
  error?: ToolError;
  scanned?: number;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome;
}

export interface EnvelopeContext {
  revision(): number;
  view(): unknown;
  /** Changes with `from < rev <= to`, so a call's own effects appear in `did`, not `since`. */
  since(from: number, to: number): unknown[];
  suggest(): NextAction[];
}

interface ModelContext {
  registerTool(
    definition: {
      name: string;
      title?: string;
      description: string;
      inputSchema: JsonSchema;
      annotations?: ToolAnnotations;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  getTools(): Promise<{ name: string }[]>;
  addEventListener(type: 'toolchange', listener: () => void): void;
}

function modelContext(): ModelContext | null {
  const candidate = (document as unknown as { modelContext?: ModelContext }).modelContext;
  return candidate ?? null;
}

export const webmcpAvailable = (): boolean => modelContext() !== null;

// --- outcome helpers -------------------------------------------------------

export function ok(data: unknown, extra: Omit<ToolOutcome, 'data' | 'error'> = {}): ToolOutcome {
  return { data, ...extra };
}

export function fail(
  code: string,
  message: string,
  fix?: ToolError['fix'],
  next?: NextAction[],
): ToolOutcome {
  return { error: { code, message, fix }, next };
}

/**
 * Across twenty fields and forty rows the nulls and empty strings are most of the payload,
 * and none of them carry information a model needs. Zero and `false` are kept.
 */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = compact(raw);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  if (value === null || value === undefined || value === '') return undefined;
  return value;
}

// --- validation ------------------------------------------------------------

export interface ValidationFailure {
  ok: false;
  message: string;
  hint: string;
}

export type Validated<T> = { ok: true; value: T } | ValidationFailure;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function coerceProperty(
  key: string,
  value: unknown,
  schema: PropertySchema,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return { ok: false, message: `"${key}" must be a string, received ${describe(value)}` };
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return {
          ok: false,
          message: `"${key}" must be one of ${schema.enum.join(', ')}, received "${value}"`,
        };
      }
      return { ok: true, value };
    }
    case 'number':
    case 'integer': {
      const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
        return { ok: false, message: `"${key}" must be a number, received ${describe(value)}` };
      }
      let result = schema.type === 'integer' ? Math.round(numeric) : numeric;
      // Clamp rather than reject: an out-of-range bound is almost always a model guessing at
      // the extent of the data, and clamping keeps the session moving.
      if (schema.minimum !== undefined) result = Math.max(schema.minimum, result);
      if (schema.maximum !== undefined) result = Math.min(schema.maximum, result);
      return { ok: true, value: result };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true') return { ok: true, value: true };
      if (value === 'false') return { ok: true, value: false };
      return { ok: false, message: `"${key}" must be a boolean, received ${describe(value)}` };
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return { ok: false, message: `"${key}" must be an array, received ${describe(value)}` };
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return { ok: false, message: `"${key}" needs at least ${schema.minItems} items` };
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return { ok: false, message: `"${key}" accepts at most ${schema.maxItems} items` };
      }
      const itemType = schema.items?.type ?? 'string';
      const items: unknown[] = [];
      for (const [i, entry] of value.entries()) {
        const coerced = coerceProperty(`${key}[${i}]`, entry, { type: itemType, description: '' });
        if (!coerced.ok) return coerced;
        items.push(coerced.value);
      }
      return { ok: true, value: items };
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, message: `"${key}" must be an object, received ${describe(value)}` };
      }
      if (!schema.properties) return { ok: true, value };
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [childKey, childSchema] of Object.entries(schema.properties)) {
        if (record[childKey] === undefined) continue;
        const coerced = coerceProperty(`${key}.${childKey}`, record[childKey], childSchema);
        if (!coerced.ok) return coerced;
        out[childKey] = coerced.value;
      }
      return { ok: true, value: out };
    }
  }
}

/** Chrome 152 forwards tool arguments without applying the declared schema. */
export function validate<T>(args: Record<string, unknown>, schema: JsonSchema): Validated<T> {
  const out: Record<string, unknown> = {};
  const known = Object.keys(schema.properties);

  // Reject undeclared arguments rather than dropping them. The browser forwards them
  // unchecked, so silently ignoring one turns a plausible-but-wrong call — `region` passed to
  // a tool that has no region — into a confident answer over the wrong rows. An agent that is
  // told the argument does not exist can correct itself; one that is not, cannot.
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"${key}"`).join(', ')}`,
      hint: known.length > 0
        ? `Accepted arguments: ${known.join(', ')}`
        : 'This tool takes no arguments.',
    };
  }

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      return {
        ok: false,
        message: `Missing required argument "${key}"`,
        hint: `This tool requires: ${(schema.required ?? []).join(', ')}`,
      };
    }
  }

  for (const [key, property] of Object.entries(schema.properties)) {
    const raw = args[key];
    if (raw === undefined || raw === null) {
      if (property.default !== undefined) out[key] = property.default;
      continue;
    }
    const coerced = coerceProperty(key, raw, property);
    if (!coerced.ok) {
      return { ok: false, message: coerced.message, hint: `Accepted arguments: ${known.join(', ')}` };
    }
    out[key] = coerced.value;
  }

  return { ok: true, value: out as T };
}

// --- activity --------------------------------------------------------------

export interface ToolCallRecord {
  id: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  at: number;
}

type ActivityListener = (record: ToolCallRecord) => void;
type SurfaceListener = (names: string[]) => void;

// --- registry --------------------------------------------------------------

/**
 * `sync()` is given the tools that should exist right now; it registers what is missing and
 * unregisters what no longer applies. That diff is the point: the page teaches the agent what
 * is possible *at this moment*, which a static tool manifest structurally cannot do.
 */
export class ToolRegistry {
  #controllers = new Map<string, AbortController>();
  #activity: ActivityListener[] = [];
  #surface: SurfaceListener[] = [];
  #sequence = 0;
  #pending: Promise<void> = Promise.resolve();
  #context: EnvelopeContext | null = null;
  /** The revision the agent last observed, so `since` can report what it missed. */
  #lastSeenRev = 0;

  setContext(context: EnvelopeContext): void {
    this.#context = context;
  }

  onCall(listener: ActivityListener): void {
    this.#activity.push(listener);
  }

  onSurfaceChange(listener: SurfaceListener): void {
    this.#surface.push(listener);
  }

  get liveToolNames(): string[] {
    return [...this.#controllers.keys()].toSorted();
  }

  reset(): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#lastSeenRev = 0;
    for (const listener of this.#surface) listener([]);
  }

  sync(definitions: ToolDefinition[]): Promise<void> {
    this.#pending = this.#pending.then(() => this.#sync(definitions)).catch((error: unknown) => {
      console.error('[webmcp] tool sync failed', error);
    });
    return this.#pending;
  }

  async #sync(definitions: ToolDefinition[]): Promise<void> {
    const context = modelContext();
    if (!context) return;

    const desired = new Map(definitions.map((definition) => [definition.name, definition]));

    // Collect first, then mutate: aborting while iterating the live map would be a footgun.
    const stale = [...this.#controllers.keys()].filter((name) => !desired.has(name));
    for (const name of stale) {
      this.#controllers.get(name)?.abort();
      this.#controllers.delete(name);
    }

    for (const [name, definition] of desired) {
      if (this.#controllers.has(name)) continue;
      const controller = new AbortController();
      try {
        // Deliberately sequential. `getTools()` reports tools in registration order, and a
        // stable order is what lets the model see the read/find/set/explain layering.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await context.registerTool(
          {
            name: definition.name,
            title: definition.title,
            description: definition.description,
            inputSchema: definition.inputSchema,
            annotations: definition.annotations,
            execute: (args) => this.#invoke(definition, args),
          },
          { signal: controller.signal },
        );
        this.#controllers.set(name, controller);
      } catch (error) {
        console.error(`[webmcp] could not register "${name}"`, error);
      }
    }

    const names = this.liveToolNames;
    for (const listener of this.#surface) listener(names);
  }

  async #invoke(
    definition: ToolDefinition,
    rawArgs: Record<string, unknown>,
  ): Promise<ToolResult> {
    const started = performance.now();
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const context = this.#context;
    const beforeRev = context?.revision() ?? 0;
    let outcome: ToolOutcome;

    const checked = validate<Record<string, unknown>>(args, definition.inputSchema);
    if (checked.ok) {
      try {
        outcome = await definition.execute(checked.value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[webmcp] "${definition.name}" failed`, error);
        outcome = fail('tool_failed', `The tool "${definition.name}" failed: ${message}`, {
          call: 'read_state',
        });
      }
    } else {
      outcome = fail('bad_arguments', `${checked.message}. ${checked.hint}`, {
        call: definition.name,
      });
    }

    const afterRev = context?.revision() ?? 0;
    const envelope = {
      rev: afterRev,
      ok: outcome.error === undefined,
      did: outcome.did,
      since: context?.since(this.#lastSeenRev, beforeRev),
      view: context?.view(),
      data: outcome.data,
      error: outcome.error,
      cost: {
        scanned: outcome.scanned,
        ms: Math.round(performance.now() - started),
      },
      next: (outcome.next ?? context?.suggest() ?? []).slice(0, 3),
    };
    this.#lastSeenRev = afterRev;

    const serialised = compact(envelope) ?? { ok: envelope.ok };
    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify(serialised) }],
      isError: outcome.error !== undefined,
    };

    const record: ToolCallRecord = {
      id: ++this.#sequence,
      name: definition.name,
      args,
      result: result.content[0].text,
      isError: result.isError === true,
      durationMs: performance.now() - started,
      at: Date.now(),
    };
    for (const listener of this.#activity) listener(record);
    return result;
  }
}
