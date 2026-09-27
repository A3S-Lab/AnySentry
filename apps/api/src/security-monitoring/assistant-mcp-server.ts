/**
 * Stdio MCP server for the assistant tool loop.
 * Code spawns this process and speaks newline-delimited JSON-RPC.
 * Tool bodies are executed by the parent bridge; this process has no shell.
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function note(message: string): void {
  try {
    appendFileSync('/tmp/anysentry-assistant-mcp.log', `${new Date().toISOString()} ${message}\n`);
  } catch {
    // The tool loop must still answer when the diagnostic file is not writable.
  }
}

const bridge = process.env.ANYSENTRY_ASSISTANT_TOOL_BRIDGE?.replace(/\/$/u, '');
const token = process.env.ANYSENTRY_ASSISTANT_TOOL_TOKEN ?? '';

const tools = [
  {
    name: 'inspect_workloads',
    description: 'Read host-side workload inventory: container name, image, classification, main-process signatures, and why a running service may be unmatched. Does not open a shell inside a container.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Port, container, image, pod, or process text to match.' },
        classification: { type: 'string', description: 'unknown, probable_agent, confirmed_agent, or non_agent.' },
        source: { type: 'string', description: 'kubernetes or docker.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'propose_identity_rule',
    description: 'Preview or save a candidate runtime-signature draft. confirm=false previews only. confirm=true writes a draft and does not enforce it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
        comm: { type: 'string' },
        exeBasename: { type: 'string' },
        container: { type: 'string' },
        confirm: { type: 'boolean' },
      },
    },
  },
  {
    name: 'apply_identity_rule',
    description: 'Create, preview, and enforce a runtime-signature identity rule as the current user. Requires confirm=true and an explicit user request; comm/exeBasename must come from inspect_workloads output.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
        comm: { type: 'string' },
        exeBasename: { type: 'string' },
        container: { type: 'string' },
        confirm: { type: 'boolean' },
      },
    },
  },
  {
    name: 'explain_rule_decision',
    description: 'Read-only: explain why a workload (by container name or process comm) or an event (by eventId) is identified, filtered, or retained; shows the winning rule at each stage F0-F3.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        eventId: { type: 'string' },
        container: { type: 'string', description: 'Container or pod name reported by inspect_workloads.' },
        comm: { type: 'string', description: 'Main-process comm reported by inspect_workloads.' },
      },
    },
  },
];

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callBridge(name: string, args: unknown): Promise<unknown> {
  if (!bridge || !token) throw new Error('assistant tool bridge is not configured');
  const response = await fetch(`${bridge}/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-anysentry-assistant-tool-token': token,
    },
    body: JSON.stringify(args ?? {}),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof raw?.message === 'string' ? raw.message : `tool bridge HTTP ${response.status}`);
  }
  return raw;
}

async function handle(message: { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } }): Promise<void> {
  note(`${message.method ?? 'notification'} ${message.params?.name ?? ''}`);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'anysentry-assistant', version: '1' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    try {
      if (name !== 'inspect_workloads' && name !== 'propose_identity_rule' && name !== 'apply_identity_rule' && name !== 'explain_rule_decision') {
        throw new Error(`unknown tool ${name ?? ''}`);
      }
      const result = await callBridge(name, message.params?.arguments);
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'tool failed' }],
          isError: true,
        },
      });
    }
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {},
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handle(JSON.parse(trimmed));
  } catch {
    // Ignore malformed client frames. The code client writes one JSON object per line.
  }
});
