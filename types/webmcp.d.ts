/**
 * Ambient declarations for the parts of WebMCP the TypeScript DOM library does not know about
 * yet. The shapes here match what was measured in Chrome 152, not what the docs describe —
 * see `docs/webmcp-findings.md`.
 */

interface WebMcpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: string;
  origin: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

interface WebMcpModelContext extends EventTarget {
  registerTool(definition: unknown, options?: { signal?: AbortSignal }): Promise<void>;
  getTools(): Promise<WebMcpToolDescriptor[]>;
  executeTool(tool: WebMcpToolDescriptor, args: string): Promise<string>;
  ontoolchange: ((this: WebMcpModelContext, event: Event) => void) | null;
}

interface Document {
  readonly modelContext?: WebMcpModelContext;
}

/**
 * The declarative form API adds these to the submit event: `agentInvoked` says the agent
 * triggered the submit rather than a person, and `respondWith` hands the agent a result
 * instead of letting the form navigate.
 */
interface SubmitEvent {
  readonly agentInvoked?: boolean;
  respondWith?: (result: Promise<string> | string) => void;
}
