import { createHash } from 'node:crypto';
import {
  CanonicalBehaviorStage,
  CanonicalOperation,
  CanonicalResourceType,
  CanonicalSecurityEvent,
} from './streaming.types';
import { workspacePathFingerprint } from './supply-chain-normalizer';
import { JudgedEvent } from './types';

const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh\/(?:id_[^/]+|authorized_keys)|\.aws\/credentials|\.docker\/config\.json|\.env(?:\.[^/]+)?|credentials?|secrets?|tokens?|private[_-]?key)(?:$|[./_-])/i;
const ENCODE_TOOL = /^(?:base64|xxd|openssl)$/i;
const COMPRESS_TOOL = /^(?:tar|gzip|bzip2|xz|zip|7z)$/i;
const COPY_TOOL = /^(?:cp|scp|rsync|dd)$/i;
const EGRESS_TOOL = /^(?:curl|wget|nc|ncat|netcat|socat|ftp|sftp)$/i;
const SHELL_TOOL = /^(?:ba|z|fi|da)?sh$|^(?:powershell|pwsh)$/i;
const DANGEROUS_COMMAND = /(?:\bcurl\b|\bwget\b).*(?:\|\s*(?:sh|bash)\b)|\b(?:rm\s+-rf|mkfifo|chmod\s+\+x|nc\s+-e)\b/i;
const GENERIC_SESSION = /^(?:bash|sh|zsh|fish|git|curl|wget|cat|base64|openssl|tar|gzip|python\d*|node|tokio-rt-worker|codex-linux-san|getconf|unknown)$/i;
const PLATFORM_SANDBOX_TOOL = /^(?:bwrap|bubblewrap|landlock-restrict)$/i;
const PLATFORM_SANDBOX_FLAGS = /(?:--unshare-(?:user|pid|net|ipc|uts|cgroup)|--ro-bind|--remount-ro|--die-with-parent|--new-session)/;

function hash(prefix: string, ...parts: Array<string | number | undefined>): string {
  return `${prefix}_${createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 24)}`;
}

function text(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}
function canonicalWorkspacePath(value: unknown): string {
  const workspacePath = text(value);
  if (!workspacePath || workspacePath.toLowerCase().startsWith('agent://')) return '';
  if (workspacePath === '/') return workspacePath;
  return workspacePath.replace(new RegExp('/+$'), '');
}
function parseObserverLine(line: string): { kind?: string; inner?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(line) as { event?: Record<string, Record<string, unknown>> };
    const kind = Object.keys(parsed.event ?? {})[0];
    return { kind, inner: kind ? parsed.event?.[kind] : undefined };
  } catch {
    return {};
  }
}

function argv(inner: Record<string, unknown> | undefined, event: JudgedEvent): string[] {
  if (Array.isArray(inner?.argv)) return inner.argv.map(String);
  const attribute = text(event.attributes.argv);
  return attribute ? attribute.split(/\s+/) : [];
}

function executable(args: string[]): string {
  return (args[0] ?? '').split('/').pop() ?? '';
}

function safeCommand(args: string[], fallback: string): string {
  const raw = args.length ? args.join(' ') : fallback;
  return raw
    .replace(/((?:authorization|api[-_]?key|token|password|secret)\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .slice(0, 4_096);
}

function processScopedIdentifier(event: JudgedEvent, value: string): boolean {
  if (GENERIC_SESSION.test(value)) return true;
  const normalized = value.toLowerCase();
  const processNames = [
    event.agentId,
    event.runId,
    event.process?.comm,
    event.process?.exe?.split('/').pop(),
  ]
    .map((candidate) => text(candidate)?.toLowerCase())
    .filter((candidate): candidate is string => Boolean(candidate));
  if (processNames.includes(normalized)) return true;
  const processIds = [event.process?.pid, event.process?.ppid]
    .filter((candidate): candidate is number => Number.isInteger(candidate))
    .map(String);
  return processIds.includes(value);
}

function explicitAgentTaskId(event: JudgedEvent): string | undefined {
  const attributes = event.attributes;
  const candidates = [
    attributes.agentTaskId,
    attributes.agentRunId,
    attributes.agentInstanceId,
    attributes.rootInstanceId,
    attributes.taskId,
    event.taskId,
    event.sessionId,
    event.runId,
  ];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value && !processScopedIdentifier(event, value)) return value;
  }
  return undefined;
}

type LogicalSessionContext = {
  trustedSourceId: string;
  tenantId: string;
  environmentId: string;
  agentCorrelationId: string;
  hostId?: string;
  containerId?: string;
  rootPid?: number;
};

function logicalSessionId(event: JudgedEvent, context: LogicalSessionContext): string {
  const attributed = text(event.attribution?.agentSessionId);
  if (attributed && !processScopedIdentifier(event, attributed)) return attributed;

  const taskId = explicitAgentTaskId(event);
  if (taskId) return taskId;

  if (context.rootPid) {
    return hash(
      'ags',
      context.tenantId,
      context.environmentId,
      context.trustedSourceId,
      context.agentCorrelationId,
      context.hostId,
      context.containerId,
      context.rootPid,
    );
  }

  const traceId = text(event.traceId);
  return traceId ? `trace:${traceId}` : 'unassigned';
}

function peerFromArgs(args: string[]): string | undefined {
  for (const arg of args.slice(1)) {
    if (!/^(?:https?|ftp):\/\//i.test(arg)) continue;
    try {
      const url = new URL(arg);
      return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
      return arg.slice(0, 240);
    }
  }
  return undefined;
}

function privateAddress(value: string): boolean {
  const host = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
}

function containerId(cgroup?: string): string | undefined {
  if (!cgroup) return undefined;
  return cgroup.match(/(?:docker[-/]|cri-containerd[-/])([a-f0-9]{12,64})/i)?.[1]
    ?? cgroup.match(/([a-f0-9]{64})(?:\.scope)?$/i)?.[1];
}

function semantic(
  event: JudgedEvent,
  observerLine: string,
): {
  operation: CanonicalOperation;
  resourceType: CanonicalResourceType;
  resource?: string;
  destination?: string;
  sensitiveResource: boolean;
  externalDestination: boolean;
  dangerous: boolean;
  failed: boolean;
  command?: string;
  executable?: string;
  argvTruncated: boolean;
  argvSource?: string;
  behaviorStage: CanonicalBehaviorStage;
  platformRuntime: boolean;
  synthetic: boolean;
} {
  const parsed = parseObserverLine(observerLine);
  const inner = parsed.inner;
  const args = argv(inner, event);
  const tool = executable(args);
  const path = text(inner?.path) ?? text(event.attributes.path);
  const peer = text(inner?.peer) ?? text(inner?.query) ?? text(event.attributes.peer) ?? text(event.attributes.query) ?? peerFromArgs(args);
  let operation: CanonicalOperation = 'observe';
  let resourceType: CanonicalResourceType = 'unknown';
  let resource: string | undefined;
  let destination: string | undefined;

  if (event.eventKind === 'FileAccess') {
    operation = 'file_read';
    resourceType = 'file';
    resource = path ?? event.subject.replace(/^file\s+/i, '');
  } else if (event.eventKind === 'FileDelete') {
    operation = 'file_write';
    resourceType = 'file';
    resource = path;
  } else if (event.eventKind === 'Egress' || event.eventKind === 'Dns' || EGRESS_TOOL.test(tool)) {
    operation = 'egress';
    resourceType = 'network';
    destination = peer;
  } else if (ENCODE_TOOL.test(tool)) {
    operation = 'encode';
    resourceType = 'process';
    resource = args.slice(1).join(' ').slice(0, 500);
  } else if (COMPRESS_TOOL.test(tool)) {
    operation = 'compress';
    resourceType = 'process';
    resource = args.slice(1).join(' ').slice(0, 500);
  } else if (COPY_TOOL.test(tool)) {
    operation = 'copy';
    resourceType = 'process';
    resource = args.slice(1).join(' ').slice(0, 500);
  } else if (event.eventKind === 'ToolExec') {
    operation = 'execute';
    resourceType = 'process';
    resource = args.join(' ').slice(0, 500) || event.subject;
  }

  const sensitiveResource = Boolean(resource && SENSITIVE_PATH.test(resource));
  const externalDestination = Boolean(destination && !privateAddress(destination));
  const command = safeCommand(args, event.subject);
  const dangerous = event.riskCategory === 'command_danger' || DANGEROUS_COMMAND.test(command);
  const status = text(inner?.status) ?? text(event.attributes.status);
  const failed = status === 'failed' || status === 'error' || event.decisionStatus === 'failed' || event.decisionStatus === 'timeout';
  const platformRuntime = event.eventKind === 'ToolExec'
    && PLATFORM_SANDBOX_TOOL.test(tool)
    && PLATFORM_SANDBOX_FLAGS.test(command)
    && /^(?:codex|a3s code)(?:\b|$)/i.test(event.attribution?.agentScopeId ?? event.agentId);
  const synthetic = event.source === 'synthetic'
    || event.attributes.synthetic === true
    || event.attributes.testFixture === true
    || /^flink-\d+-/i.test(event.agentId);
  let behaviorStage: CanonicalBehaviorStage = 'none';
  if (operation === 'file_read' && sensitiveResource) behaviorStage = 'credential_access';
  else if (operation === 'copy' && sensitiveResource) behaviorStage = 'staging';
  else if (operation === 'encode' || operation === 'compress') behaviorStage = 'transform';
  else if (operation === 'egress' && externalDestination) behaviorStage = 'external_egress';
  else if (event.eventKind === 'FileDelete') behaviorStage = 'destructive_action';
  else if (dangerous) behaviorStage = 'dangerous_exec';
  else if (operation === 'execute' && SHELL_TOOL.test(tool)) behaviorStage = 'shell_execution';
  return {
    operation,
    resourceType,
    resource,
    destination,
    sensitiveResource,
    externalDestination,
    dangerous,
    failed,
    command,
    executable: tool || undefined,
    argvTruncated: inner?.argv_truncated === true || event.attributes.argv_truncated === true,
    argvSource: text(inner?.argv_source) ?? text(event.attributes.argv_source),
    behaviorStage,
    platformRuntime,
    synthetic,
  };
}

function sourceEventId(event: JudgedEvent): string {
  return text(event.sourceEventId)
    ?? text(event.attributes.sourceEventId)
    ?? text(event.attributes.cloudEventId)
    ?? event.eventId;
}

export function canonicalizeEvent(event: JudgedEvent, observerLine: string, receivedAt = Date.now()): CanonicalSecurityEvent {
  const trustedSourceId = event.sourceId ?? event.collectorId ?? 'local';
  const sourceId = sourceEventId(event);
  const eventId = hash('evt', trustedSourceId, sourceId);
  const tenantId = text(event.attributes.tenantId) ?? process.env.ANYSENTRY_TENANT_ID ?? 'default';
  const environmentId = text(event.attributes.environmentId) ?? process.env.ANYSENTRY_ENVIRONMENT_ID ?? 'local';
  const agentType = event.attribution?.agentScopeId ?? event.agentId ?? 'unknown';
  const workspacePath = canonicalWorkspacePath(event.workspacePath);
  // Logical workspace identifiers such as repo://... remain valid for stream
  // correlation, but only absolute local paths can be matched to a registered
  // supply-chain scan workspace.
  const localWorkspacePath = workspacePath.startsWith('/') ? workspacePath : '';
  const workspaceIdentity = workspacePath || 'unassigned:' + agentType;
  const workspaceId = text(event.attributes.workspaceId) ?? hash('ws', tenantId, environmentId, workspaceIdentity);
  const agentCorrelationId = hash('agc', tenantId, environmentId, workspaceId, agentType);
  const processIdentity = {
    hostId: event.process?.hostId ?? text(event.attributes.collectorNode),
    containerId: containerId(event.process?.cgroup),
    pid: event.process?.pid,
    ppid: event.process?.ppid,
    rootPid: event.attribution?.rootPid,
    startTimeNs: event.process?.startTimeNs,
  };
  const explicitRootInstanceId = text(event.attributes.agentInstanceId)
    ?? text(event.attributes.rootInstanceId);
  const agentInstanceId = explicitRootInstanceId
    ? hash('agi', trustedSourceId, agentCorrelationId, explicitRootInstanceId)
    : processIdentity.rootPid
      ? hash(
        'agi',
        trustedSourceId,
        agentCorrelationId,
        processIdentity.hostId,
        processIdentity.containerId,
        processIdentity.rootPid,
      )
      : hash(
        'agi',
        trustedSourceId,
        agentCorrelationId,
        processIdentity.hostId,
        processIdentity.containerId,
        processIdentity.pid,
        processIdentity.startTimeNs,
      );
  return {
    schemaVersion: 'anysentry.canonical_event.v1',
    eventId,
    sourceEventId: sourceId,
    sourceRecordId: event.eventId,
    eventTime: event.at,
    receivedAt,
    tenantId,
    environmentId,
    workspaceId,
    workspacePath,
    workspacePathFingerprint: localWorkspacePath
      ? workspacePathFingerprint(localWorkspacePath)
      : '',
    trustedSourceId,
    claimedAgentId: event.agentId,
    agentType,
    agentInstanceId,
    agentCorrelationId,
    sessionId: logicalSessionId(event, {
      trustedSourceId,
      tenantId,
      environmentId,
      agentCorrelationId,
      hostId: processIdentity.hostId,
      containerId: processIdentity.containerId,
      rootPid: processIdentity.rootPid,
    }),
    traceId: event.traceId,
    spanId: event.spanId,
    eventKind: event.eventKind,
    ...semantic(event, observerLine),
    subject: event.subject.slice(0, 500),
    processIdentity,
    runtimeVulnerabilities: [],
  };
}
