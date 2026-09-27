import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import {
  CanonicalBehaviorStage,
  CanonicalFileIdentity,
  CanonicalOperation,
  CanonicalProcessIdentity,
  CanonicalResourceType,
  CanonicalSecurityEvent,
} from './streaming.types';
import { workspacePathFingerprint } from './supply-chain-normalizer';
import { JudgedEvent } from './types';
import { correlationCaptureRollout } from './correlation-rollout';
import { parseTrustedCorrelation } from './trusted-correlation';
import { visibleClassificationSemantics } from './classification-semantics';
import { canonicalContainerId, canonicalProcessInstanceId } from './process-instance-identity';

const SENSITIVE_PATH = /(?:^|\/)(?:etc\/(?:shadow|sudoers)|\.ssh\/(?:id_[^/]+|authorized_keys)|\.aws\/credentials|\.docker\/config\.json|\.env(?:\.[^/]+)?|credentials?|secrets?|tokens?|private[_-]?key)(?:$|[./_-])/i;
const PERSISTENCE_PATH = /(?:^|\/)(?:etc\/(?:cron(?:\.d|\.daily|\.hourly|\.weekly|\.monthly)?|crontab|systemd\/system|init\.d)\/?|var\/spool\/cron\/|\.config\/autostart\/|\.ssh\/authorized_keys$|(?:\.bashrc|\.bash_profile|\.profile|\.zshrc)$)/i;
const ENCODE_TOOL = /^(?:base64|xxd|openssl)$/i;
const COMPRESS_TOOL = /^(?:tar|gzip|bzip2|xz|zip|7z)$/i;
const COPY_TOOL = /^(?:cp|scp|rsync|dd)$/i;
const READ_TOOL = /^(?:cat|head|tail|less|more)$/i;
const EGRESS_TOOL = /^(?:curl|wget|nc|ncat|netcat|socat|ftp|sftp)$/i;
const SHELL_TOOL = /^(?:ba|z|fi|da)?sh$|^(?:powershell|pwsh)$/i;
const DANGEROUS_COMMAND = /(?:\bcurl\b|\bwget\b).*(?:\|\s*(?:sh|bash)\b)|\b(?:rm\s+-rf|mkfifo|chmod\s+\+x|nc\s+-e)\b/i;
const GENERIC_SESSION = /^(?:bash|sh|zsh|fish|git|curl|wget|cat|base64|openssl|tar|gzip|python\d*|node|tokio-rt-worker|codex-linux-san|getconf|unknown)$/i;
const PLATFORM_SANDBOX_TOOL = /^(?:bwrap|bubblewrap|landlock-restrict)$/i;
const PLATFORM_SANDBOX_FLAGS = /(?:--unshare-(?:user|pid|net|ipc|uts|cgroup)|--ro-bind|--remount-ro|--die-with-parent|--new-session)/;
const PERSISTENCE_TOOL = /^(?:crontab|systemctl|update-rc\.d|chkconfig|launchctl|schtasks)$/i;
const SANDBOX_PROBE_TOOL = /^(?:nsenter|unshare|chroot|mount|setns)$/i;
const PRIVILEGE_TOOL = /^(?:sudo|su|setcap|capsh)$/i;
const DISCOVERY_TOOL = /^(?:find|fd|locate|ls|du)$/i;
const DESTRUCTIVE_TOOL = /^(?:rm|shred|truncate|wipefs)$/i;
const REMOTE_TOOL = /^(?:ssh|scp|sftp|rsync)$/i;

function hash(prefix: string, ...parts: Array<string | number | undefined>): string {
  return `${prefix}_${createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 24)}`;
}

function text(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function numericAttribute(
  event: JudgedEvent,
  keys: readonly string[],
  fallback: number,
): number {
  for (const key of keys) {
    const raw = event.attributes[key];
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function aggregationMetadata(event: JudgedEvent): {
  repeatCount: number;
  firstEventAt: number;
  lastEventAt: number;
  aggregationWindowMs: number;
} {
  const repeatCount = Math.max(1, Math.trunc(numericAttribute(event, ['repeatCount', 'repeat_count'], 1)));
  const firstEventAt = Math.max(0, Math.trunc(numericAttribute(event, ['firstEventAt', 'first_event_at'], event.at)));
  const lastEventAt = Math.max(firstEventAt, Math.trunc(numericAttribute(event, ['lastEventAt', 'last_event_at'], event.at)));
  const aggregationWindowMs = Math.max(
    0,
    Math.trunc(numericAttribute(event, ['aggregationWindowMs', 'aggregation_window_ms'], 0)),
  );
  return { repeatCount, firstEventAt, lastEventAt, aggregationWindowMs };
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

function canonicalFilePath(value: string | undefined, cwd: string | undefined): string | undefined {
  if (!value || value.startsWith('-') || /^(?:https?|ftp):\/\//i.test(value)) return undefined;
  if (value.startsWith('/')) return value.replace(/\/+/g, '/');
  return cwd?.startsWith('/') ? resolvePath(cwd, value) : undefined;
}

function operandPath(
  args: string[],
  cwd: string | undefined,
  start = 1,
): string | undefined {
  for (const arg of args.slice(start)) {
    const path = canonicalFilePath(arg, cwd);
    if (path) return path;
  }
  return undefined;
}

function downloadPath(args: string[], tool: string, cwd: string | undefined): string | undefined {
  const outputPath = (value: string | undefined): string | undefined => {
    const path = canonicalFilePath(value, cwd);
    return path && !/^\/dev\/(?:null|stdout|stderr)$/i.test(path) ? path : undefined;
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if ((tool === 'curl' && (arg === '-o' || arg === '--output'))
      || (tool === 'wget' && (arg === '-O' || arg === '--output-document'))) {
      return outputPath(args[index + 1]);
    }
    if (tool === 'curl' && arg.startsWith('--output=')) {
      return outputPath(arg.slice('--output='.length));
    }
    if (tool === 'wget' && arg.startsWith('--output-document=')) {
      return outputPath(arg.slice('--output-document='.length));
    }
  }
  return undefined;
}

function chmodPath(args: string[], cwd: string | undefined): string | undefined {
  for (let index = args.length - 1; index >= 1; index -= 1) {
    const path = canonicalFilePath(args[index], cwd);
    if (path) return path;
  }
  return undefined;
}

function executedFilePath(args: string[], cwd: string | undefined, tool: string): string | undefined {
  const executableArgument = args[0];
  const explicitExecutablePath = Boolean(
    executableArgument
    && (executableArgument.startsWith('/')
      || executableArgument.startsWith('./')
      || executableArgument.startsWith('../')
      || executableArgument.includes('/')),
  );
  const executablePath = explicitExecutablePath
    ? canonicalFilePath(executableArgument, cwd)
    : undefined;
  if (executablePath && candidatePayloadPath(executablePath, cwd)) return executablePath;
  if (SHELL_TOOL.test(tool)) {
    if (args.slice(1).some((arg) => arg === '-c' || arg === '--command')) return undefined;
    const scriptPath = operandPath(args, cwd);
    return scriptPath && candidatePayloadPath(scriptPath, cwd) ? scriptPath : undefined;
  }
  return undefined;
}

function candidatePayloadPath(path: string, cwd: string | undefined): boolean {
  if (/^\/(?:tmp|var\/tmp|dev\/shm)\//.test(path)) return true;
  return Boolean(cwd?.startsWith('/') && cwd !== '/' && (path === cwd || path.startsWith(`${cwd}/`)));
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
  rootStartTime?: string;
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
      context.rootStartTime,
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

function persistenceTarget(args: string[], tool: string, cwd: string | undefined): string | undefined {
  if (tool === 'systemctl') {
    const action = args.findIndex((arg) => /^(?:enable|reenable|link|start)$/i.test(arg));
    if (action < 0) return undefined;
    const target = args.slice(action + 1).find((arg) => !arg.startsWith('-'));
    return canonicalFilePath(target, cwd) ?? target;
  }
  if (tool === 'crontab') return operandPath(args, cwd);
  const target = args.slice(1).find((arg) => !arg.startsWith('-') && !/^(?:enable|add|load|create)$/i.test(arg));
  return canonicalFilePath(target, cwd) ?? target;
}

function remoteArguments(
  args: string[],
  tool: string,
  cwd: string | undefined,
): { destination?: string; identityFile?: string; hasAction: boolean; copy: boolean } {
  let identityFile: string | undefined;
  let destinationIndex = -1;
  const consumesValue = new Set(['-i', '-p', '-o', '-F', '-J', '-S', '-l', '-b', '-c']);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-i') {
      identityFile = canonicalFilePath(args[index + 1], cwd);
      index += 1;
      continue;
    }
    if (consumesValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (tool === 'scp' || tool === 'rsync') {
      const remoteIndex = args.findIndex((candidate, candidateIndex) =>
        candidateIndex >= index && /^[^@\s]+@[^:\s]+:/.test(candidate));
      if (remoteIndex >= 0) destinationIndex = remoteIndex;
      break;
    }
    destinationIndex = index;
    break;
  }
  const remote = destinationIndex >= 0 ? args[destinationIndex] : undefined;
  const destination = remote
    ?.replace(/^[^@\s]+@/, '')
    .replace(/:.*$/, '')
    .replace(/^\[|\]$/g, '');
  const copy = tool === 'scp' || tool === 'sftp' || tool === 'rsync';
  const hasAction = copy || (destinationIndex >= 0
    && !args.includes('-N')
    && args.slice(destinationIndex + 1).some((arg) => !arg.startsWith('-')));
  return { destination, identityFile, hasAction, copy };
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
  const normalizedTool = tool.toLowerCase();
  const cwd = text(inner?.cwd) ?? event.process?.cwd;
  const path = text(inner?.path) ?? text(event.attributes.path);
  const peer = text(inner?.peer) ?? text(inner?.query) ?? text(event.attributes.peer) ?? text(event.attributes.query) ?? peerFromArgs(args);
  let operation: CanonicalOperation = 'observe';
  let resourceType: CanonicalResourceType = 'unknown';
  let resource: string | undefined;
  let destination: string | undefined;

  if (event.eventKind === 'FileAccess') {
    operation = inner?.write === true || event.attributes.write === true ? 'file_write' : 'file_read';
    resourceType = 'file';
    resource = canonicalFilePath(path ?? event.subject.replace(/^file\s+/i, ''), cwd)
      ?? path
      ?? event.subject.replace(/^file\s+/i, '');
  } else if (event.eventKind === 'FileDelete') {
    operation = 'destroy';
    resourceType = 'file';
    resource = canonicalFilePath(path, cwd) ?? path;
  } else if (event.eventKind === 'Egress' || event.eventKind === 'Dns') {
    operation = 'egress';
    resourceType = 'network';
    destination = peer;
  } else if (event.eventKind === 'ToolExec' && EGRESS_TOOL.test(tool) && downloadPath(args, normalizedTool, cwd)) {
    operation = 'download';
    resourceType = 'file';
    resource = downloadPath(args, normalizedTool, cwd);
    destination = peer;
  } else if (event.eventKind === 'ToolExec' && normalizedTool === 'chmod') {
    operation = 'chmod';
    resourceType = 'file';
    resource = chmodPath(args, cwd);
  } else if (event.eventKind === 'ToolExec' && READ_TOOL.test(tool)) {
    operation = 'file_read';
    resourceType = 'file';
    resource = operandPath(args, cwd);
  } else if (event.eventKind === 'ToolExec' && EGRESS_TOOL.test(tool)) {
    operation = 'egress';
    resourceType = 'network';
    destination = peer;
  } else if (ENCODE_TOOL.test(tool)) {
    operation = 'encode';
    resourceType = 'file';
    resource = operandPath(args, cwd) ?? args.slice(1).join(' ').slice(0, 500);
  } else if (COMPRESS_TOOL.test(tool)) {
    operation = 'compress';
    resourceType = 'file';
    resource = operandPath(args, cwd) ?? args.slice(1).join(' ').slice(0, 500);
  } else if (event.eventKind === 'ToolExec' && REMOTE_TOOL.test(tool)) {
    const remote = remoteArguments(args, normalizedTool, cwd);
    operation = remote.copy ? 'remote_copy' : remote.hasAction ? 'remote_execute' : 'remote_connect';
    destination = remote.destination;
    resource = remote.identityFile;
    resourceType = remote.identityFile ? 'file' : 'network';
  } else if (COPY_TOOL.test(tool)) {
    operation = 'copy';
    resourceType = 'file';
    resource = operandPath(args, cwd) ?? args.slice(1).join(' ').slice(0, 500);
  } else if (event.eventKind === 'ToolExec' && PERSISTENCE_TOOL.test(tool)) {
    operation = 'persistence_activate';
    resource = persistenceTarget(args, normalizedTool, cwd);
    resourceType = resource?.startsWith('/') ? 'file' : 'process';
  } else if (event.eventKind === 'ToolExec' && SANDBOX_PROBE_TOOL.test(tool)) {
    operation = 'sandbox_probe';
    resourceType = 'process';
    resource = args.slice(1).join(' ').slice(0, 500) || event.subject;
  } else if (event.eventKind === 'ToolExec' && PRIVILEGE_TOOL.test(tool)) {
    operation = 'privilege_change';
    resourceType = 'process';
    resource = args.slice(1).join(' ').slice(0, 500) || event.subject;
  } else if (event.eventKind === 'ToolExec' && DISCOVERY_TOOL.test(tool)) {
    operation = 'target_discovery';
    resourceType = 'file';
    resource = operandPath(args, cwd) ?? cwd;
  } else if (event.eventKind === 'ToolExec' && DESTRUCTIVE_TOOL.test(tool)) {
    operation = 'destroy';
    resourceType = 'file';
    resource = operandPath(args, cwd);
  } else if (event.eventKind === 'ToolExec') {
    operation = 'execute';
    const executedFile = executedFilePath(args, cwd, tool);
    resourceType = executedFile ? 'file' : 'process';
    resource = executedFile ?? (args.join(' ').slice(0, 500) || event.subject);
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
  if (operation === 'download' && resource) behaviorStage = 'download';
  else if (operation === 'file_write' && resource && PERSISTENCE_PATH.test(resource)) behaviorStage = 'persistence_write';
  else if (operation === 'file_write' && event.eventKind === 'FileAccess') behaviorStage = 'file_written';
  else if (operation === 'chmod' && resource) behaviorStage = 'permission_change';
  else if (operation === 'execute' && resourceType === 'file') behaviorStage = 'file_execution';
  else if (operation === 'file_read' && sensitiveResource) behaviorStage = 'credential_access';
  else if (operation === 'copy' && sensitiveResource) behaviorStage = 'staging';
  else if (operation === 'encode' || operation === 'compress') behaviorStage = 'transform';
  else if (operation === 'egress' && externalDestination) behaviorStage = 'external_egress';
  else if (operation === 'persistence_activate') behaviorStage = 'persistence_activation';
  else if (operation === 'sandbox_probe') behaviorStage = 'sandbox_probe';
  else if (operation === 'privilege_change') behaviorStage = 'privilege_change';
  else if (operation === 'target_discovery') behaviorStage = 'target_discovery';
  else if (operation === 'destroy') behaviorStage = 'destructive_action';
  else if (operation === 'remote_connect') behaviorStage = 'lateral_connect';
  else if (operation === 'remote_execute' || operation === 'remote_copy') behaviorStage = 'lateral_action';
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
  // Only the resolver-owned attribution object may cross this canonical boundary. Raw producer
  // attributes and top-level convenience claims are intentionally not consulted here.
  const correlation = correlationCaptureRollout().trustedCorrelation === 'off'
    ? undefined
    : parseTrustedCorrelation(event.attribution?.correlation);
  const classificationSemantics = visibleClassificationSemantics(event.classificationSemantics);
  const eventId = hash('evt', trustedSourceId, sourceId);
  const tenantId = text(event.attributes.tenantId) ?? process.env.ANYSENTRY_TENANT_ID ?? 'default';
  const environmentId = text(event.attributes.environmentId) ?? process.env.ANYSENTRY_ENVIRONMENT_ID ?? 'local';
  const agentType = event.attribution?.agentScopeId ?? event.agentId ?? 'unknown';
  const workspacePath = canonicalWorkspacePath(event.workspacePath);
  // Logical workspace identifiers such as repo://... remain valid for stream
  // correlation. Supply-chain matching may use an attested Observer process cwd as an additive,
  // more-specific resource scope (for example Agent root `/repo` executing inside
  // `/repo/service-a`), but never trusts an application/adapter producer's cwd claim.
  const processWorkspacePath = (
    correlation?.authority === 'attested_observer' ||
    correlation?.authority === 'server_process_graph'
  ) && event.process?.cwd?.startsWith('/')
    ? canonicalWorkspacePath(event.process.cwd)
    : '';
  const localWorkspacePath = processWorkspacePath || (workspacePath.startsWith('/') ? workspacePath : '');
  const workspaceIdentity = workspacePath || 'unassigned:' + agentType;
  const workspaceId = text(event.attributes.workspaceId) ?? hash('ws', tenantId, environmentId, workspaceIdentity);
  const agentCorrelationId = hash('agc', tenantId, environmentId, workspaceId, agentType);
  const bootId = event.process?.bootId ?? text(event.attributes.bootId);
  const startTimeTicks = event.process?.startTimeTicks;
  const startTimeNs = event.process?.startTimeNs;
  const stableStartTime = startTimeTicks ?? startTimeNs;
  const stableStartTimeKind = startTimeTicks ? 'ticks' : startTimeNs ? 'ns' : undefined;
  const mountNamespace = event.process?.mountNamespace
    ?? (Number.isFinite(Number(event.attributes.mountNamespace))
      ? Number(event.attributes.mountNamespace)
      : undefined);
  const processIdentityConfidence: CanonicalProcessIdentity['identityConfidence'] = bootId && stableStartTime && event.process?.pid
    ? 'strong'
    : stableStartTime && event.process?.pid
      ? 'medium'
      : 'weak';
  const processIdentity: CanonicalProcessIdentity = {
    hostId: event.process?.hostId ?? text(event.attributes.collectorNode),
    bootId,
    containerId: canonicalContainerId(event.process?.cgroup),
    cgroupId: event.process?.cgroupId,
    pid: event.process?.pid,
    ppid: event.process?.ppid,
    rootPid: event.attribution?.rootPid,
    rootStartTime: event.attribution?.rootStartTime,
    startTimeTicks,
    startTimeNs,
    mountNamespace,
    processInstanceId: canonicalProcessInstanceId({
      trustedSourceId,
      bootId,
      hostId: event.process?.hostId,
      collectorNode: event.attributes.collectorNode,
      cgroup: event.process?.cgroup,
      cgroupId: event.process?.cgroupId,
      pid: event.process?.pid,
      startTimeTicks,
      startTimeNs,
    }),
    identityConfidence: processIdentityConfidence,
  };
  const semantics = semantic(event, observerLine);
  const aggregation = aggregationMetadata(event);
  let fileIdentity: CanonicalFileIdentity | undefined;
  if (semantics.resourceType === 'file' && semantics.resource?.startsWith('/')) {
    const device = scalarText(event.attributes.device);
    const inode = scalarText(event.attributes.inode);
    const strong = Boolean(device && inode);
    fileIdentity = {
      fileInstanceId: strong
        ? hash('fli', trustedSourceId, bootId, mountNamespace, device, inode)
        : hash(
          'flp',
          trustedSourceId,
          bootId,
          workspaceId,
          agentCorrelationId,
          semantics.resource,
        ),
      path: semantics.resource,
      device,
      inode,
      mountNamespace,
      identityBasis: strong ? 'device_inode' : 'scoped_path',
      identityConfidence: strong
        ? 'strong'
        : bootId && workspaceId && agentCorrelationId
          ? 'medium'
          : 'weak',
    };
  }
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
        processIdentity.rootStartTime,
      )
      : hash(
        'agi',
        trustedSourceId,
        agentCorrelationId,
        processIdentity.hostId,
        processIdentity.containerId,
        processIdentity.pid,
        processIdentity.startTimeTicks ? 'ticks' : processIdentity.startTimeNs ? 'ns' : undefined,
        processIdentity.startTimeTicks ?? processIdentity.startTimeNs,
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
      rootStartTime: processIdentity.rootStartTime,
    }),
    traceId: event.traceId,
    ...(correlation?.invocationId ? { invocationId: correlation.invocationId } : {}),
    ...(correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    ...(correlation ? { correlation } : {}),
    ...(classificationSemantics ? { classificationSemantics } : {}),
    spanId: event.spanId,
    eventKind: event.eventKind,
    ...semantics,
    ...aggregation,
    subject: event.subject.slice(0, 500),
    processIdentity,
    fileIdentity,
    runtimeVulnerabilities: [],
  };
}
