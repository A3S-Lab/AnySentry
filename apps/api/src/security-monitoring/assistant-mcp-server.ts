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
    description: 'Preview or save a candidate runtime-signature draft. confirm=false previews only. confirm=true writes a draft and does not enforce it. For a containerized workload pass container AND image together (plus placement when inspect_workloads reports it): the composite matcher survives container recreates and wins over broad built-in image-family templates. An exact duplicate of an enforced rule is rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
        comm: { type: 'string', description: 'Host process comm from inspect_workloads; only for host processes with a specific binary name, never a generic interpreter.' },
        exeBasename: { type: 'string', description: 'Host process executable basename from inspect_workloads.' },
        container: { type: 'string', description: 'Container or pod name from inspect_workloads.' },
        image: { type: 'string', description: 'Container image from the same inspect_workloads entry; pass together with container for a composite matcher.' },
        placement: { type: 'string', description: 'docker or kubernetes, as reported by the inspect_workloads entry source.' },
        confirm: { type: 'boolean' },
      },
    },
  },
  {
    name: 'apply_identity_rule',
    description: 'Create, preview, and enforce a runtime-signature identity rule as the current user. Requires confirm=true and an explicit user request; container/image/placement/comm/exeBasename must come from inspect_workloads output. For a containerized workload pass container AND image together for a robust composite matcher. An exact duplicate of an enforced rule is rejected. After enforcement the tool waits for observer delivery and reports the observed workload classification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
        comm: { type: 'string', description: 'Host process comm from inspect_workloads; only for host processes with a specific binary name, never a generic interpreter.' },
        exeBasename: { type: 'string', description: 'Host process executable basename from inspect_workloads.' },
        container: { type: 'string', description: 'Container or pod name from inspect_workloads.' },
        image: { type: 'string', description: 'Container image from the same inspect_workloads entry; pass together with container for a composite matcher.' },
        placement: { type: 'string', description: 'docker or kubernetes, as reported by the inspect_workloads entry source.' },
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
  {
    name: 'review_agent_candidate',
    description: 'Human-review a discovered agent: decision=confirmed_agent confirms it, non_agent excludes it, unknown returns it to observation, clear removes a prior review. confirm=false previews the transition without persisting. confirm=true applies the review as the current chat user (the assistant drafts, the user approves) and requires an explicit user request. Confirming admits the workload to plaintext LLM capture on both http and https, so never confirm on your own initiative. Target the agent by agentId from a prior tool result, or by container/pod name from inspect_workloads. After applying, the tool waits and reports the observed classification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: { type: 'string', description: 'Agent id from the agents inventory, e.g. "candidate my-service".' },
        container: { type: 'string', description: 'Container or pod name from inspect_workloads; used to locate the inventory entry when agentId is unknown.' },
        decision: { type: 'string', description: 'confirmed_agent, non_agent, unknown, or clear. Default confirmed_agent.' },
        note: { type: 'string', description: 'Short review note recorded in the audit trail.' },
        confirm: { type: 'boolean' },
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
