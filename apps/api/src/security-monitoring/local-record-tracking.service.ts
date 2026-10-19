import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Dirent, watch, type FSWatcher } from 'node:fs';
import {
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { LocalRecordResourceSampler, LocalRecordResources } from './local-record-resources';
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  LocalRecordAdapter,
  LocalRecordDetail,
  LocalRecordDetailMetrics,
  LocalRecordList,
  LocalRecordMetricScope,
  LocalRecordProcessEvidence,
  LocalRecordProcessStatus,
  LocalRecordSummary,
  LocalRecordTimelineEvent,
  LocalRecordTokenUsage,
  LocalRecordTrackingStatus,
} from './local-record-tracking.types';
import {
  parseA3sCodeRecord,
  type ParsedA3sCodeRecord,
} from './local-record-a3s-code.adapter';
import {
  parseClaudeCodeRecord,
  type ParsedClaudeCodeRecord,
} from './local-record-claude-code.adapter';
import {
  parseGeminiCliRecord,
  type ParsedGeminiCliRecord,
} from './local-record-gemini-cli.adapter';
import { parseKimiCliRecord, type ParsedKimiCliRecord } from './local-record-kimi-cli.adapter';
import { discoverOpenCodeSessions, parseOpenCodeRecord, type ParsedOpenCodeRecord } from './local-record-opencode.adapter';
import { InteractionService } from './interaction.service';
import { canonicalProcessLifecycleIdentity } from './process-lifecycle';
import { SessionEventAttributionService } from './session-event-attribution.service';
import { buildLocalToolEvidence } from './local-tool-evidence';
import type { SessionProcessBindingCandidate } from './session-event-attribution.types';
import type { InteractionInstructionRecord } from './interaction.types';

// Codex Session metadata is the first JSONL record (currently < 32 KiB in the supported
// runtimes). Keep a safety margin without paying a multi-megabyte bind-mount read per record.
const SUMMARY_HEAD_BYTES = 128 * 1024;
// The latest cumulative token record is within 320 KiB of EOF in the verified local corpus.
const SUMMARY_TAIL_BYTES = 384 * 1024;
const DETAIL_INITIAL_WINDOW_BYTES = 2 * 1024 * 1024;
const DETAIL_WINDOW_BYTES = 24 * 1024 * 1024;
const FIRST_USER_HEAD_MAX_BYTES = 4 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_CONTENT_CHARS = 64 * 1024;
const DEFAULT_LIST_LIMIT = 120;
const DEFAULT_DETAIL_LIMIT = 200;
const DISCOVERY_CACHE_MS = 5_000;
// The list/detail views poll every 15s.  A process scan walks bounded windows of many /proc
// file-descriptor directories, so repeating it for every concurrent request only adds latency
// without making the status materially fresher.  Keep a short liveness cache and allow operators
// to lower/raise it with ANYSENTRY_LOCAL_PROCESS_CACHE_MS when needed.
const PROCESS_CACHE_MS = 15_000;
// A detail request may be followed immediately by the System Evidence tab (which asks for the
// same Session tail).  Cache the compact parsed result for a short interval so that tab switches,
// polling and evidence requests do not reread/JSON-parse up to 24 MiB of a large JSONL file.
const DETAIL_WINDOW_CACHE_MS = 10_000;
const MAX_DETAIL_WINDOW_CACHE_ENTRIES = 64;
const SUMMARY_CONCURRENCY = 12;
const ACTIVE_WINDOW_MS = 5 * 60 * 1_000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_ATTRIBUTION_LOOKBACK_MS = 2 * 60 * 1_000;
const ACTIVE_ATTRIBUTION_OVERLAP_MS = 5 * 1_000;
const ACTIVE_ATTRIBUTION_RECONCILE_MS = 60 * 1_000;
const ATTRIBUTION_TAIL_RETENTION_MS = 10 * 60 * 1_000;
const MAX_ATTRIBUTION_GENERATIONS = 256;
const MAX_INTERACTIVE_GENERATIONS = 4;
// A long-lived native Session can be resumed by a new Codex process while an older process still
// has the same file descriptor open.  Interactive evidence should follow the latest observed
// Rustls request generation; replaying every historical generation makes one tab switch trigger a
// full process-family walk per stale PID.  Keep a small overlap so two helper processes serving the
// same recent turn are retained together.
const ACTIVE_PROCESS_GENERATION_OVERLAP_MS = 10 * 60 * 1_000;
// The list endpoint must remain a lightweight liveness view.  Background reconciliation still
// persists the complete relation/result set, but it does not need to hydrate hundreds of wide
// event rows that are only rendered by the explicit System Evidence tab.  Keeping this small also
// prevents two active Sessions from competing with an interactive evidence request for the same
// ClickHouse read slot.
const ACTIVE_ATTRIBUTION_EVENT_LIMIT = 32;
const SYSTEM_EVIDENCE_TURN_MARGIN_MS = 5 * 60 * 1_000;
// The Codex process is observable before the first Native Session JSONL item: it resolves the
// platform, loads configuration and establishes the provider connection before appending
// `session_meta`/`turn_context`. Those events are part of the same exact OS process generation,
// so retain only a small setup head instead of reporting them as unexplained evidence.
const SESSION_PROCESS_STARTUP_GRACE_MS = 5 * 1_000;
// Codex appends the final Native Session item just before the Responses connection and short-lived
// helper processes finish draining. Kernel Egress/ProcessExit timestamps therefore commonly trail
// the JSONL mtime by a few milliseconds to roughly two seconds. Keep a small, fixed tail on a
// PID-generation-safe binding so those completion events remain part of the Session without
// widening the whole interactive evidence window.
const SESSION_PROCESS_DRAIN_GRACE_MS = 5 * 1_000;
const MAX_SYSTEM_EVIDENCE_TIME_WINDOWS = 32;
// Interactive evidence should explain the current Session activity without replaying every idle
// turn in a multi-day JSONL file. Older evidence remains available to the background reconciler;
// the detail response explicitly reports `partial` when this bounded view is used.
const INTERACTIVE_SYSTEM_EVIDENCE_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
// Active Sessions keep receiving writes; a full day of lifecycle/event scans competes with
// Observer ingest for ClickHouse and is the main source of System Evidence detail timeouts.
const ACTIVE_INTERACTIVE_SYSTEM_EVIDENCE_LOOKBACK_MS = 2 * 60 * 60 * 1_000;
const MAX_A3S_RECORD_CACHE_ENTRIES = 64;
const MAX_A3S_RECORD_CACHE_BYTES = 64 * 1024 * 1024;
// A long-lived A3S TUI can keep thousands of sockets/eventfds open. Reading every `/proc/PID/fd`
// symlink on every dashboard refresh makes an otherwise bounded process scan take tens of
// seconds. Read a rotating bounded window: low descriptors are checked first, while later refreshes
// eventually cover a rare Session file opened at a high descriptor number.
const MAX_CODEX_FDS_TO_SCAN = 1_024;
const MAX_A3S_FDS_TO_SCAN = 512;
const PROCESS_FD_READ_BATCH = 64;

type JsonRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

type JsonObject = Record<string, unknown>;

interface ParsedLine {
  offset: number;
  value: JsonRecord;
}

interface ReadWindow {
  lines: ParsedLine[];
  fromOffset: number;
  toOffset: number;
  firstCompleteOffset: number;
  scannedBytes: number;
  truncatedLines: number;
}

interface LocalRecordEntry {
  recordId: string;
  adapter: LocalRecordAdapter;
  root: string;
  hostRoot?: string;
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  fileIdentity?: string;
  nativeSessionId?: string;
}

interface DiscoveryResult {
  root: string;
  adapters: LocalRecordAdapter[];
  entries: LocalRecordEntry[];
}

interface LocalRecordRoot {
  adapter: LocalRecordAdapter;
  path: string;
  hostPath?: string;
  harborJobs?: boolean;
}

interface SummaryCacheEntry {
  size: number;
  mtimeMs: number;
  summary: LocalRecordSummary;
}

interface A3sRecordCacheEntry {
  size: number;
  mtimeMs: number;
  parsed: ParsedA3sCodeRecord;
}

interface ClaudeRecordCacheEntry {
  size: number;
  mtimeMs: number;
  parsed: ParsedClaudeCodeRecord;
}

interface GeminiRecordCacheEntry {
  size: number;
  mtimeMs: number;
  parsed: ParsedGeminiCliRecord;
}

interface DetailWindowSnapshot {
  fromOffset: number;
  toOffset: number;
  firstCompleteOffset: number;
  scannedBytes: number;
  truncatedLines: number;
}

interface DetailWindowCacheEntry {
  size: number;
  mtimeMs: number;
  toOffset: number;
  expiresAt: number;
  parsedEventCount: number;
  terminal: boolean;
  result: {
    window: DetailWindowSnapshot;
    parsed: { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics };
  };
}

interface ProcessIdentity {
  pid: number;
  startTimeTicks: string;
}

interface ExactProcessMatch extends ProcessIdentity {
  bindingMethod?: 'proc_fd' | 'observer_request' | 'ebpf_session_file' | 'controlled_launch' | 'tool_exec_exact';
  matchedPid: number;
  matchedStartTimeTicks: string;
  recordId: string;
}

interface KnownProcessBinding extends ExactProcessMatch {
  state: 'running' | 'exited';
  endEvidence?: Extract<
    LocalRecordProcessEvidence,
    'observed_exit' | 'binding_replaced'
  >;
}

interface ProcessScanResult {
  available: boolean;
  observedAt: number;
  exactByRecordId: Map<string, ExactProcessMatch[]>;
  liveRoots: Map<number, string>;
  liveAgents?: LiveAgentObservation[];
  lastError?: string;
}

interface LiveAgentObservation {
  adapter: LocalRecordAdapter;
  pid: number;
  startTimeTicks: string;
  startMs?: number;
  cwd?: string;
  ppid?: number;
  openPaths: string[];
}

interface ProcessCandidateObservation {
  root: ProcessIdentity;
  matchedPid: number;
  matchedStartTimeTicks: string;
  recordIds: string[];
  adapter: LocalRecordAdapter;
  cwd?: string;
  ppid?: number;
  openPaths: string[];
}

interface ProcessState {
  processStatus: LocalRecordProcessStatus;
  processEvidence: LocalRecordProcessEvidence;
  processPid?: number;
  processObservedAt?: number;
}

interface ParsedMetrics {
  userMessageCount: number;
  assistantMessageCount: number;
  completeTurnCount: number;
  turnCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolFailureCount: number;
  completedDurationMs: number;
  ttftValues: number[];
  tokenUsage: LocalRecordTokenUsage;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|on|yes)$/iu.test(value?.trim() ?? '');
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function processStat(value: string): {
  ppid: number;
  startTimeTicks: string;
} | undefined {
  const commandEnd = value.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fields = value.slice(commandEnd + 1).trim().split(/\s+/u);
  const ppid = Number(fields[1]);
  const startTimeTicks = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !startTimeTicks) {
    return undefined;
  }
  return { ppid, startTimeTicks };
}

const PROCESS_CLOCK_TICKS = 100;
const LIVE_AGENT_CWD_SKEW_MS = 30_000;
// Some Agents (kimi-code) open their session file only for a moment per append. A periodic
// /proc fd walk almost never catches that transient writable FD, so recently-written Sessions
// get an inotify watch instead: a write event triggers a targeted FD re-scan immediately.
const TRANSIENT_FD_WATCH_WINDOW_MS = 30 * 60_000;
const TRANSIENT_FD_CATCH_TTL_MS = 10 * 60_000;
const TRANSIENT_FD_WATCH_MAX = 32;
const TRANSIENT_FD_SCAN_DEBOUNCE_MS = 250;
// A live process whose only evidence is "same cwd as a Session" is a hint, not identity. When
// several Sessions of that adapter were written recently, the hint is ambiguous by construction.
const LIVE_AGENT_ACTIVE_WINDOW_MS = 5 * 60_000;
// Persisted bindings (proc_fd class) survive API restarts in PostgreSQL. Recently active
// Sessions without a live FD match are rehydrated from that store and revalidated against the
// current /proc generation, so a restart cannot silently downgrade them to the cwd heuristic.
const PERSISTED_BINDING_HYDRATE_WINDOW_MS = 6 * 3_600_000;
const PERSISTED_BINDING_HYDRATE_MAX_PER_SCAN = 8;
const PERSISTED_BINDING_HYDRATE_COOLDOWN_MS = 60_000;

function processStartMs(bootMs: number, startTimeTicks: string): number | undefined {
  const ticks = Number(startTimeTicks);
  if (!Number.isSafeInteger(ticks) || ticks < 0) return undefined;
  return bootMs + Math.round((ticks * 1_000) / PROCESS_CLOCK_TICKS);
}

function commandArguments(value: string): string[] {
  return value.split('\u0000').filter(Boolean);
}

function isCodexRuntimeProcess(comm: string, argv: string[]): boolean {
  const executable = basename(argv[0] ?? comm).toLocaleLowerCase();
  const command = comm.trim().toLocaleLowerCase();
  return executable === 'codex' || command === 'codex';
}

function isCodexNodeLauncher(argv: string[]): boolean {
  const executable = basename(argv[0] ?? '').toLocaleLowerCase();
  const script = basename(argv[1] ?? '').toLocaleLowerCase();
  return (executable === 'node' || executable.startsWith('node-'))
    && script === 'codex';
}

function isA3sCodeRuntimeProcess(comm: string, argv: string[]): boolean {
  const executable = basename(argv[0] ?? comm).toLocaleLowerCase();
  const command = comm.trim().toLocaleLowerCase();
  if (executable === 'a3s-code' || command === 'a3s-code') return true;
  // Align with Observer runtime signatures: Tokio renames `comm` while exe stays `a3s`.
  if (command === 'tokio-rt-worker' && executable === 'a3s') return true;
  if (executable !== 'a3s') return false;
  const sub = (argv[1] ?? '').trim().toLocaleLowerCase();
  // `a3s code ...` is the coding runtime. Bare `a3s` is not the TUI entrypoint.
  // Reject platform-admin subcommands that may briefly open session files.
  if (sub !== 'code') return false;
  return true;
}

function isClaudeCodeRuntimeProcess(comm: string, argv: string[]): boolean {
  const executable = basename(argv[0] ?? comm).toLocaleLowerCase();
  const command = comm.trim().toLocaleLowerCase();
  if (executable === 'claude' || command === 'claude') return true;
  // Older npm-distributed Claude Code releases use a Node launcher. Require the
  // script basename to be Claude so unrelated Node processes are never absorbed.
  const script = basename(argv[1] ?? '').toLocaleLowerCase();
  return (executable === 'node' || executable.startsWith('node-'))
    && (script === 'claude' || script === 'claude.js');
}

function isKimiCliRuntimeProcess(comm: string, argv: string[]): boolean {
  const names = ['kimi', 'kimi-cli', 'kimi-code', 'kimi code'];
  if (names.includes(comm.trim().toLowerCase()) || names.includes(basename(argv[0] ?? '').toLowerCase())) return true;
  if (!/^python(?:3(?:\.\d+)?)?$/u.test(basename(argv[0] ?? ''))) return false;
  return names.includes(basename(argv[1] ?? '').toLowerCase())
    || (argv[1] === '-m' && ['kimi_cli', 'kimi_cli.cli'].includes(argv[2] ?? ''));
}

function isGeminiCliRuntimeProcess(comm: string, argv: string[]): boolean {
  const executable = basename(argv[0] ?? comm).toLocaleLowerCase();
  const command = comm.trim().toLocaleLowerCase();
  if (
    executable === 'gemini'
    || executable === 'gemini-cli'
    || command === 'gemini'
    || command === 'gemini-cli'
  ) return true;
  if (executable !== 'node' && !executable.startsWith('node-')) return false;
  // npm/npx shims eventually execute Node with the package entrypoint in argv. Require the
  // package path; a model name or prompt containing "gemini" must never classify generic Node.
  return argv.slice(1).some((value) => {
    const normalized = value.replaceAll('\\', '/').toLocaleLowerCase();
    return normalized.includes('/@google/gemini-cli/')
      || normalized.includes('/node_modules/@google/gemini-cli/');
  });
}

function normalizedRelativePath(value: string): string {
  return value.split(sep).join('/').replace(/^\/+/u, '');
}

function sessionRelativePathFromFd(
  targetValue: string,
  hostSessionsRoot?: string,
): string | undefined {
  const target = targetValue
    .replace(/ \(deleted\)$/u, '')
    .replaceAll('\\', '/');
  const configuredHostRoot = hostSessionsRoot
    ?.replaceAll('\\', '/')
    .replace(/\/+$/u, '');
  if (configuredHostRoot && target.startsWith(`${configuredHostRoot}/`)) {
    return target.slice(configuredHostRoot.length + 1);
  }
  const a3sMarker = '/.a3s/tui/sessions/';
  const a3sIndex = target.lastIndexOf(a3sMarker);
  if (a3sIndex >= 0) {
    // Preserve the v1/sessions/... relative layout used by discovery.
    return target.slice(a3sIndex + a3sMarker.length);
  }
  const codexMarker = '/.codex/sessions/';
  const codexIndex = target.lastIndexOf(codexMarker);
  if (codexIndex >= 0) {
    return target.slice(codexIndex + codexMarker.length);
  }
  const claudeMarker = '/.claude/projects/';
  const claudeIndex = target.lastIndexOf(claudeMarker);
  if (claudeIndex >= 0) {
    return target.slice(claudeIndex + claudeMarker.length);
  }
  const geminiMarker = '/.gemini/tmp/';
  const geminiIndex = target.lastIndexOf(geminiMarker);
  if (geminiIndex >= 0) {
    return target.slice(geminiIndex + geminiMarker.length);
  }
  // Generic fallback only for flat Session trees (Codex-style). Prefer the first
  // `/sessions/` segment so nested A3S `.../sessions/v1/sessions/<file>` is not
  // collapsed to a bare filename that no longer matches discovery.
  const genericMarker = '/sessions/';
  const genericIndex = target.indexOf(genericMarker);
  if (genericIndex >= 0) {
    return target.slice(genericIndex + genericMarker.length);
  }
  return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanText(value: unknown, limit = MAX_EVENT_CONTENT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\u0000/gu, '').trim();
  if (!clean) return undefined;
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…（内容已截断）`;
}

function toolOutputText(value: unknown): string | undefined {
  const direct = cleanText(value);
  if (direct) return direct;

  // Current Codex versions encode custom tool output as an array of content
  // blocks, while older Sessions store one string. Normalize both shapes so
  // exit codes remain visible and tool failures are counted correctly.
  if (Array.isArray(value)) {
    const blocks = value.flatMap((item) => {
      const block = objectValue(item);
      const text =
        cleanText(block?.text)
        ?? cleanText(block?.content)
        ?? cleanText(block?.output);
      return text ? [text] : [];
    });
    return cleanText(blocks.join('\n'));
  }

  const object = objectValue(value);
  if (!object) return undefined;
  return (
    cleanText(object.text)
    ?? cleanText(object.content)
    ?? cleanText(object.output)
    ?? cleanText(JSON.stringify(object, null, 2))
  );
}

function preview(value: unknown, limit = 180): string | undefined {
  const clean = cleanText(value, Math.max(limit * 4, 800))
    ?.replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function payloadType(record: JsonRecord): string | undefined {
  return stringValue(objectValue(record.payload)?.type);
}

function payloadOf(record: JsonRecord): JsonObject {
  return objectValue(record.payload) ?? {};
}

function recordTimestamp(record: JsonRecord): number | undefined {
  return timestampMs(record.timestamp);
}

function emptyTokenUsage(): LocalRecordTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function tokenUsageFrom(record: JsonRecord): LocalRecordTokenUsage | undefined {
  if (payloadType(record) !== 'token_count') return undefined;
  const payload = payloadOf(record);
  const info = objectValue(payload.info);
  const usage = objectValue(info?.total_token_usage);
  if (!usage) return undefined;
  const contextWindow =
    finiteNumber(info?.model_context_window)
    ?? finiteNumber(payload.model_context_window);
  return {
    inputTokens: Math.max(0, finiteNumber(usage.input_tokens) ?? 0),
    cachedInputTokens: Math.max(0, finiteNumber(usage.cached_input_tokens) ?? 0),
    outputTokens: Math.max(0, finiteNumber(usage.output_tokens) ?? 0),
    reasoningOutputTokens: Math.max(
      0,
      finiteNumber(usage.reasoning_output_tokens) ?? 0,
    ),
    totalTokens: Math.max(0, finiteNumber(usage.total_tokens) ?? 0),
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
  };
}

function turnIdFrom(record: JsonRecord): string | undefined {
  const payload = payloadOf(record);
  const metadata = objectValue(payload.internal_chat_message_metadata_passthrough);
  return (
    stringValue(payload.turn_id)
    ?? stringValue(metadata?.turn_id)
  );
}

function userMessage(record: JsonRecord): string | undefined {
  return payloadType(record) === 'user_message'
    ? cleanText(payloadOf(record).message)
    : undefined;
}

function assistantMessage(record: JsonRecord): string | undefined {
  return payloadType(record) === 'agent_message'
    ? cleanText(payloadOf(record).message)
    : undefined;
}

function responseMessage(record: JsonRecord, role: 'user' | 'assistant'): string | undefined {
  if (record.type !== 'response_item' || payloadType(record) !== 'message') {
    return undefined;
  }
  const payload = payloadOf(record);
  if (payload.role !== role) return undefined;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const texts = content
    .map((item) => objectValue(item))
    .filter((item): item is JsonObject => Boolean(item))
    .map((item) => cleanText(item.text))
    .filter((item): item is string => Boolean(item));
  return cleanText(texts.join('\n'));
}

function usefulUserMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (
    /^<(?:environment_context|permissions(?:[_\s]+instructions)?|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins|collaboration_mode|multi_agent_mode)>/iu.test(message)
    || /^You are .*?(?:assistant|Codex)/iu.test(message)
  ) {
    return undefined;
  }
  return message;
}

function toolResultStatus(output: string | undefined): 'success' | 'failure' | 'unknown' {
  if (!output) return 'unknown';
  const failed =
    /(?:process exited with code|exit(?:_code| code)?["':=\s]+)(?!0\b)-?\d+/iu.test(output)
    || /\b(?:fatal|uncaught|traceback|permission denied)\b/iu.test(output);
  if (failed) return 'failure';
  if (
    /(?:process exited with code|exit(?:_code| code)?["':=\s]+)0\b/iu.test(output)
    || /\b(?:script completed|completed successfully|success)\b/iu.test(output)
  ) {
    return 'success';
  }
  return 'unknown';
}

function parseToolArguments(value: unknown): {
  content?: string;
  command?: string;
  workdir?: string;
} {
  if (typeof value !== 'string') {
    return {
      content: value === undefined
        ? undefined
        : cleanText(JSON.stringify(value, null, 2)),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { content: cleanText(value) };
  }
  const object = objectValue(parsed);
  return {
    content: cleanText(JSON.stringify(parsed, null, 2)),
    command:
      cleanText(object?.cmd, 16 * 1024)
      ?? cleanText(object?.command, 16 * 1024),
    workdir: cleanText(object?.workdir, 2_000),
  };
}

function eventId(recordId: string, offset: number, kind: string): string {
  return createHash('sha256')
    .update(`${recordId}:${offset}:${kind}`)
    .digest('hex')
    .slice(0, 24);
}

function createMetrics(): ParsedMetrics {
  return {
    userMessageCount: 0,
    assistantMessageCount: 0,
    completeTurnCount: 0,
    turnCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    toolFailureCount: 0,
    completedDurationMs: 0,
    ttftValues: [],
    tokenUsage: emptyTokenUsage(),
  };
}

@Injectable()
export class LocalRecordTrackingService {
  private readonly logger = new Logger(LocalRecordTrackingService.name);
  private discoveryCache?: {
    expiresAt: number;
    configurationKey: string;
    result: DiscoveryResult;
  };
  private discoveryInFlight?: {
    configurationKey: string;
    promise: Promise<DiscoveryResult>;
  };

  private readonly summaryCache = new Map<string, SummaryCacheEntry>();
  private readonly summaryInFlight = new Map<string, {
    size: number;
    mtimeMs: number;
    promise: Promise<LocalRecordSummary>;
  }>();
  private readonly a3sRecordCache = new Map<string, A3sRecordCacheEntry>();
  private readonly claudeRecordCache = new Map<string, ClaudeRecordCacheEntry>();
  private readonly geminiRecordCache = new Map<string, GeminiRecordCacheEntry>();
  private readonly detailWindowCache = new Map<string, DetailWindowCacheEntry>();
  private readonly detailWindowInFlight = new Map<string, {
    size: number;
    mtimeMs: number;
    toOffset: number;
    eventLimit: number;
    promise: Promise<{
      window: ReadWindow;
      parsed: { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics };
    }>;
  }>();
  private processCache?: {
    refreshedAt: number;
    expiresAt: number;
    configurationKey: string;
    result: ProcessScanResult;
  };
  private processInFlight?: {
    configurationKey: string;
    promise: Promise<ProcessScanResult>;
  };
  private readonly processFdScanOffsets = new Map<string, number>();
  private readonly processBindings = new Map<string, KnownProcessBinding>();
  private readonly liveAgentBindings = new Map<string, ProcessIdentity>();
  // Last seen summaries across list/detail calls, so single-record paths apply the same
  // cwd-collision guards as the full list view.
  private readonly latestSummaries = new Map<string, LocalRecordSummary>();
  private readonly resourceSampler = new LocalRecordResourceSampler();

  async recordResources(recordId: string): Promise<LocalRecordResources> {
    if (!this.isEnabled()) throw new ServiceUnavailableException('local record tracking is disabled');
    const discovery = await this.discover();
    if (!discovery.entries.some(entry => entry.recordId === recordId)) throw new NotFoundException('local record not found');
    const base = { recordId, source: 'host_proc' as const, scope: 'session_process' as const, samples: [] };
    const root = this.configuredProcessRoot();
    const scan = await this.scanProcesses(discovery.entries, await this.processObservationStatus());
    if (!root || !scan.available) return { ...base, state: 'unavailable' };
    const matches = this.exactProcessMatches(scan, recordId);
    const identities = new Map(matches.map(match => [`${match.matchedPid}:${match.matchedStartTimeTicks}`, match]));
    if (identities.size !== 1) return { ...base, state: 'unbound' };
    const match = [...identities.values()][0];
    const shared = [...scan.exactByRecordId].some(([id, values]) => id !== recordId && values.some(value =>
      value.matchedPid === match.matchedPid && value.matchedStartTimeTicks === match.matchedStartTimeTicks));
    if (shared) return { ...base, state: 'shared' };
    return this.resourceSampler.read(recordId, root, match.matchedPid, match.matchedStartTimeTicks);
  }
  private activeAttributionInFlight?: Promise<void>;
  private activeAttributionLastStartedAt = 0;
  private activeAttributionCheckpoint = 0;
  private readonly attributionGenerations = new Map<string, {
    summary: LocalRecordSummary;
    exact: ExactProcessMatch;
    lastSeenAt: number;
    initialSince: number;
    checkpoint?: number;
    tailSince?: number;
    tailVerified?: boolean;
    observedOnly?: boolean;
    runtimeRecord?: InteractionInstructionRecord;
  }>();
  private attributionTimer?: ReturnType<typeof setInterval>;
  private attributionPollInFlight = false;
  private transientFdWatchers = new Map<string, FSWatcher>();
  private transientFdDebounce = new Map<string, ReturnType<typeof setTimeout>[]>();
  private transientFdCatches = new Map<string, (ExactProcessMatch & { caughtAt: number })[]>();
  private transientFdScanInFlight = new Set<string>();
  private persistedBindingHydration = new Map<string, number>();
  private lastError?: string;

  constructor(
    private readonly interactions: InteractionService,
    @Optional()
    private readonly sessionAttribution?: SessionEventAttributionService,
  ) {}

  onModuleInit(): void {
    // Finalization must not depend on a browser remaining open after the CLI exits.
    if (!this.sessionAttribution || this.attributionTimer) return;
    this.attributionTimer = setInterval(() => {
      if (this.attributionPollInFlight || !this.isEnabled()
        || /^(?:0|false|off|no)$/iu.test(process.env.ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND?.trim() ?? '')) return;
      this.attributionPollInFlight = true;
      void this.listRecords({ limit: 1 }).catch(error => {
        this.logger.warn(`Session attribution discovery poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { this.attributionPollInFlight = false; });
    }, 30_000);
    this.attributionTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.attributionTimer) clearInterval(this.attributionTimer);
    this.attributionTimer = undefined;
    for (const watcher of this.transientFdWatchers.values()) watcher.close();
    this.transientFdWatchers.clear();
    for (const timers of this.transientFdDebounce.values()) for (const timer of timers) clearTimeout(timer);
    this.transientFdDebounce.clear();
  }

  async status(): Promise<LocalRecordTrackingStatus> {
    const configuredRoots = this.configuredRoots();
    const isEnabled = this.isEnabled();
    const processObservation = await this.processObservationStatus();
    if (!isEnabled || configuredRoots.length === 0) {
      return this.statusValue({
        enabled: isEnabled,
        rootConfigured: configuredRoots.length > 0,
        rootAccessible: false,
        rootDisplay: configuredRoots.map((root) => root.path).join(', ') || undefined,
        adapters: configuredRoots.map((root) => root.adapter),
        recordCount: 0,
        processObservation,
      });
    }
    try {
      const discovery = await this.discover();
      this.lastError = undefined;
      return this.statusValue({
        enabled: true,
        rootConfigured: true,
        rootAccessible: true,
        rootDisplay: discovery.root,
        adapters: discovery.adapters,
        recordCount: discovery.entries.length,
        processObservation,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.statusValue({
        enabled: true,
        rootConfigured: true,
        rootAccessible: false,
        rootDisplay: configuredRoots.map((root) => root.path).join(', '),
        adapters: configuredRoots.map((root) => root.adapter),
        recordCount: 0,
        lastError: this.lastError,
        processObservation,
      });
    }
  }

  async listRecords(query: {
    limit?: number;
    search?: string;
    activityStatus?: string;
    processStatus?: string;
  } = {}): Promise<LocalRecordList> {
    const status = await this.status();
    if (!status.enabled || !status.rootAccessible) {
      return {
        schemaVersion: 'anysentry.local-record-list.v1',
        status,
        items: [],
        total: 0,
        aggregates: {
          runningProcesses: 0,
          exitedRecords: 0,
          unknownProcessRecords: 0,
          activeRecords: 0,
          recentRecords: 0,
          totalBytes: 0,
          observedTokens: 0,
          observedToolCalls: 0,
        },
        updateTime: new Date().toISOString(),
      };
    }

    const discovery = await this.discover();
    const fileSummaries: LocalRecordSummary[] = [];
    // A3S Code's companion records are heavier to parse, but their presence must not throttle
    // the independent Codex JSONL summaries. Mixed deployments therefore use the normal bounded
    // pool; an A3S-only deployment keeps the conservative pool for its larger JSON documents.
    const summaryConcurrency = discovery.entries.length > 0
      && discovery.entries.every((entry) => entry.adapter === 'a3s_code')
      ? Math.min(3, SUMMARY_CONCURRENCY)
      : SUMMARY_CONCURRENCY;
    for (let index = 0; index < discovery.entries.length; index += summaryConcurrency) {
      const batch = discovery.entries.slice(index, index + summaryConcurrency);
      const values = await Promise.allSettled(batch.map((entry) => this.summary(entry)));
      for (const [offset, result] of values.entries()) {
        if (result.status === 'fulfilled') {
          fileSummaries.push(result.value);
        } else if (result.reason instanceof NotFoundException) {
          // An empty, incomplete or rotated journal must not hide unrelated Sessions.
          // Keep the source intact and retry it on the next discovery pass.
          this.logger.warn(`Skipping unavailable local record ${batch[offset].recordId}: ${result.reason.message}`);
        } else {
          throw result.reason;
        }
      }
    }
    const processScan = await this.scanProcesses(
      discovery.entries,
      status.processObservation,
    );
    this.refreshTransientFdWatchers(discovery.entries, processScan);
    await this.hydratePersistedProcessBindings(fileSummaries, processScan);
    const summaries = this.enrichProcessStates(fileSummaries, processScan);
    const effectiveStatus = this.statusWithProcessScan(status, processScan);
    this.scheduleActiveSessionAttribution(summaries, processScan);

    const search = query.search?.trim().toLocaleLowerCase();
    const requestedStatus = query.activityStatus?.trim();
    const requestedProcessStatus = query.processStatus?.trim();
    const filtered = summaries.filter((item) => {
      if (
        requestedStatus
        && requestedStatus !== 'all'
        && item.activityStatus !== requestedStatus
      ) {
        return false;
      }
      if (
        requestedProcessStatus
        && requestedProcessStatus !== 'all'
        && item.processStatus !== requestedProcessStatus
      ) {
        return false;
      }
      if (!search) return true;
      return [
        item.title,
        item.cwd,
        item.model,
        item.modelProvider,
        item.sessionId,
        item.originator,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
    const ordered = [...filtered].sort((left, right) => {
      const leftRunning = left.processStatus === 'running' ? 0 : 1;
      const rightRunning = right.processStatus === 'running' ? 0 : 1;
      return (
        leftRunning - rightRunning
        || right.updatedAt - left.updatedAt
        || left.recordId.localeCompare(right.recordId)
      );
    });
    const limit = Math.min(500, Math.max(1, query.limit ?? DEFAULT_LIST_LIMIT));
    return {
      schemaVersion: 'anysentry.local-record-list.v1',
      status: effectiveStatus,
      items: ordered.slice(0, limit),
      total: filtered.length,
      aggregates: {
        runningProcesses: new Set(
          summaries
            .filter((item) => item.processStatus === 'running')
            .map((item) => item.processPid)
            .filter((pid): pid is number => pid !== undefined),
        ).size,
        exitedRecords: summaries.filter((item) => item.processStatus === 'exited').length,
        unknownProcessRecords: summaries.filter((item) => item.processStatus === 'unknown').length,
        activeRecords: summaries.filter((item) => item.activityStatus === 'active').length,
        recentRecords: summaries.filter((item) => item.activityStatus !== 'stopped').length,
        totalBytes: summaries.reduce((sum, item) => sum + item.fileBytes, 0),
        observedTokens: summaries.reduce(
          (sum, item) => sum + item.tokenUsage.totalTokens,
          0,
        ),
        observedToolCalls: summaries.reduce(
          (sum, item) => sum + item.toolCallCount,
          0,
        ),
      },
      updateTime: new Date().toISOString(),
    };
  }

  async recordDetail(
    recordIdValue: string,
    query: {
      limit?: number;
      beforeOffset?: number;
      evidenceLimit?: number;
      includeSystemEvidence?: boolean;
      /** Internal detail projection switch. System Evidence only needs the attribution tree;
       * returning every captured request body again can turn a small page into multi-megabytes. */
      includeObservedLlmRequests?: boolean;
      /** Keep Observer metadata on the fast path, and load encrypted request bodies only when
       * the semantic/process-tree view is opened. */
      includeObservedLlmRequestContent?: boolean;
    } = {},
  ): Promise<LocalRecordDetail> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('local record tracking is disabled');
    }
    const discovery = await this.discover();
    const entry = discovery.entries.find((item) => item.recordId === recordIdValue);
    if (!entry) throw new NotFoundException('local record not found');

    const limit = Math.min(500, Math.max(1, query.limit ?? DEFAULT_DETAIL_LIMIT));
    const evidenceLimit = Math.min(
      5_000,
      Math.max(1, Math.trunc(query.evidenceLimit ?? 250)),
    );
    const includeSystemEvidence = query.includeSystemEvidence !== false;
    const includeObservedLlmRequests = query.includeObservedLlmRequests !== false;
    const includeObservedLlmRequestContent =
      query.includeObservedLlmRequestContent !== false;
    let parsed: { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics };
    let selectedEvents: LocalRecordTimelineEvent[];
    let nextBeforeOffset: number;
    let hasMore: boolean;
    let toOffset: number;
    let window: ReadWindow;
    let metrics: LocalRecordDetailMetrics;
    if (
      entry.adapter === 'a3s_code'
      || entry.adapter === 'claude_code'
      || entry.adapter === 'gemini_cli'
      || entry.adapter === 'kimi_cli'
      || entry.adapter === 'opencode'
    ) {
      const structured = entry.adapter === 'a3s_code'
        ? await this.a3sRecord(entry)
        : entry.adapter === 'claude_code'
          ? await this.claudeRecord(entry)
          : entry.adapter === 'opencode' ? await this.openCodeRecord(entry)
            : entry.adapter === 'kimi_cli' ? await this.kimiRecord(entry) : await this.geminiRecord(entry);
      const logicalEnd = (structured.events.at(-1)?.sourceOffset ?? 0) + 1;
      toOffset = Math.min(logicalEnd, Math.max(0, query.beforeOffset ?? logicalEnd));
      const eligible = structured.events.filter((event) => event.sourceOffset < toOffset);
      selectedEvents = eligible.slice(-limit);
      nextBeforeOffset = selectedEvents[0]?.sourceOffset ?? 0;
      hasMore = eligible.length > selectedEvents.length;
      window = {
        lines: [],
        fromOffset: hasMore ? nextBeforeOffset : 0,
        toOffset,
        firstCompleteOffset: nextBeforeOffset,
        scannedBytes: structured.metrics.scannedBytes,
        truncatedLines: 'partial' in structured && structured.partial ? 1 : 0,
      };
      parsed = {
        events: structured.events,
        metrics: {
          userMessageCount: structured.metrics.userMessageCount,
          assistantMessageCount: structured.metrics.assistantMessageCount,
          completeTurnCount: structured.metrics.completeTurnCount,
          turnCount: structured.metrics.turnCount,
          toolCallCount: structured.metrics.toolCallCount,
          toolResultCount: structured.metrics.toolResultCount,
          toolFailureCount: structured.metrics.toolFailureCount,
          completedDurationMs: structured.metrics.completedDurationMs,
          ttftValues: [],
          tokenUsage: structured.metrics.tokenUsage,
        },
      };
      metrics = structured.metrics;
    } else {
      const requestedEnd = query.beforeOffset ?? entry.size;
      toOffset = Math.min(entry.size, Math.max(0, requestedEnd));
      ({ window, parsed } = await this.readDetailWindow(entry, toOffset, limit));
      // Detail pages are read from the tail so a multi-gigabyte Session can render promptly.
      // The first user instruction is still the session's primary context, however, and it is
      // often far outside that tail. Keep one bounded head probe for the initial page and pin
      // that instruction alongside the latest events. The pagination cursor intentionally stays
      // anchored to the tail page; older-page requests will eventually return the same event and
      // the web client de-duplicates it by eventId.
      const pageEvents = parsed.events.slice(-limit);
      let firstUserEvent: LocalRecordTimelineEvent | undefined;
      if (
        pageEvents.every((event) => event.kind !== 'user_message')
        && toOffset === entry.size
        && query.beforeOffset === undefined
      ) {
        firstUserEvent = await this.readFirstUserEvent(entry);
      }
      if (firstUserEvent && !pageEvents.some((event) => event.eventId === firstUserEvent?.eventId)) {
        const tailLimit = Math.max(0, limit - 1);
        selectedEvents = [firstUserEvent, ...pageEvents.slice(-tailLimit)];
      } else {
        selectedEvents = pageEvents;
      }
      const earliestReturnedOffset = pageEvents[0]?.sourceOffset;
      nextBeforeOffset = earliestReturnedOffset ?? window.firstCompleteOffset;
      hasMore = nextBeforeOffset > 0;
      const metricScope: LocalRecordMetricScope =
        window.fromOffset === 0 && window.toOffset === entry.size
          ? 'full_record'
          : 'recent_window';
      const averageTimeToFirstTokenMs = parsed.metrics.ttftValues.length > 0
        ? Math.round(
            parsed.metrics.ttftValues.reduce((sum, value) => sum + value, 0)
            / parsed.metrics.ttftValues.length,
          )
        : undefined;
      metrics = {
        scope: metricScope,
        scannedBytes: window.scannedBytes,
        fileBytes: entry.size,
        messageCount:
          parsed.metrics.userMessageCount + parsed.metrics.assistantMessageCount,
        userMessageCount: parsed.metrics.userMessageCount,
        assistantMessageCount: parsed.metrics.assistantMessageCount,
        turnCount: parsed.metrics.turnCount,
        completeTurnCount: parsed.metrics.completeTurnCount,
        toolCallCount: parsed.metrics.toolCallCount,
        toolResultCount: parsed.metrics.toolResultCount,
        toolFailureCount: parsed.metrics.toolFailureCount,
        completedDurationMs: parsed.metrics.completedDurationMs,
        ...(averageTimeToFirstTokenMs !== undefined
          ? { averageTimeToFirstTokenMs }
          : {}),
        tokenUsage: parsed.metrics.tokenUsage,
      };
      if (firstUserEvent && metrics.userMessageCount === 0) {
        metrics = {
          ...metrics,
          messageCount: metrics.messageCount + 1,
          userMessageCount: 1,
        };
      }
    }
    const fileSummary = await this.summary(entry);
    const processObservation = await this.processObservationStatus();
    const processScan = await this.scanProcesses(
      discovery.entries,
      processObservation,
    );
    await this.hydratePersistedProcessBindings([fileSummary], processScan);
    let summary =
      this.enrichProcessStates([fileSummary], processScan)[0]
      ?? fileSummary;
    let observerRequestEvidence:
      LocalRecordDetail['provenance']['observerRequestEvidence'] =
        'unavailable';
    let observedLlmRequests: LocalRecordDetail['observedLlmRequests'] = [];
    let runtimeBindingRecord: InteractionInstructionRecord | undefined;
    let runtimeBindingRecords: InteractionInstructionRecord[] = [];
    try {
      const interactionStatus = this.interactions.status();
      const projectionAvailable =
        interactionStatus.enabled
        && (
          interactionStatus.projection.postgresql
          || interactionStatus.projection.clickhouse
        );
      if (projectionAvailable) {
        // Kimi's chat-completions requests carry no runtime Session id; the Observer binds them
        // to the exact Process generation, so hand the Session's own exact process identities
        // (live scan plus persisted binding) to the interaction query as the attribution key.
        const exactProcesses = this.exactProcessMatches(processScan, summary.recordId);
        const knownBinding = this.processBindings.get(summary.recordId);
        const processIdentities: { pid: number; startTime: string }[] = [
          ...exactProcesses.map((match) => ({
            pid: match.matchedPid,
            startTime: `ticks:${match.matchedStartTimeTicks}`,
          })),
          ...(knownBinding
            ? [{
                pid: knownBinding.matchedPid,
                startTime: `ticks:${knownBinding.matchedStartTimeTicks}`,
              }]
            : []),
        ];
        if (
          processIdentities.length === 0
          && entry.adapter === 'kimi_cli'
          && this.sessionAttribution
        ) {
          // A containerized Kimi (Harbor) leaves neither a live process nor a persisted binding
          // by the time the detail is read. Resolve the Session-file writer generation first so
          // the process-scoped interaction records can be attributed in the same pass.
          const sessionFileBinding = await this.sessionAttribution
            .resolveBindingFromSessionFile({
              runtimeType: entry.adapter,
              nativeSessionId: summary.sessionId,
              sessionPaths: [
                entry.path,
                join(entry.root, entry.relativePath),
                ...(entry.hostRoot
                  ? [join(entry.hostRoot, entry.relativePath)]
                  : []),
              ],
              pathMarkers: summary.sessionId.length >= 8
                ? [`/${summary.sessionId}/`]
                : [],
              validFrom: Math.max(
                1,
                summary.startedAt - SESSION_PROCESS_STARTUP_GRACE_MS,
              ),
              ...(summary.processStatus === 'exited'
                ? { validTo: summary.updatedAt + SESSION_PROCESS_DRAIN_GRACE_MS }
                : {}),
            }, {
              since: Math.max(1, summary.startedAt - 5 * 60 * 1_000),
              until: summary.activityStatus === 'active'
                ? Date.now() + 1_000
                : summary.updatedAt + 5 * 60 * 1_000,
            }, { persist: false });
          if (sessionFileBinding) {
            processIdentities.push({
              pid: sessionFileBinding.matchedPid,
              startTime: sessionFileBinding.matchedStartTime,
            });
          }
        }
        const observations =
          await this.interactions.instructionsForRuntimeSession(
            summary.sessionId,
            {
              since: Math.max(1, summary.startedAt - 5 * 60 * 1_000),
              // Do not turn a historical Session into an unbounded "start until now" query just
              // because its long-lived CLI process still exists. Only a Session whose file is
              // actively being written can receive a model request after its latest record.
              until: summary.activityStatus === 'active'
                ? Date.now() + 1_000
                : summary.updatedAt + 5 * 60 * 1_000,
              limit: 500,
              // This is a read-only detail path. The interaction projection in ClickHouse is
              // sufficient for Observer captures and avoids blocking on a busy PostgreSQL pool.
              projection: 'clickhouse',
              includeContent:
                includeObservedLlmRequests && includeObservedLlmRequestContent,
              processIdentities,
            },
          );
        const recordsWithProcess = observations
          .map((observation) => observation.record)
          .filter((record) => Boolean(
            record.process && canonicalProcessLifecycleIdentity(record.process),
          ));
        runtimeBindingRecords = recordsWithProcess;
        runtimeBindingRecord = recordsWithProcess.find((record) => {
          const observedIdentity = canonicalProcessLifecycleIdentity(record.process);
          return exactProcesses.some((match) =>
            observedIdentity?.pid === match.matchedPid
            && observedIdentity.startTime === `ticks:${match.matchedStartTimeTicks}`);
        }) ?? recordsWithProcess.find((record) =>
          exactProcesses.some((match) => match.matchedPid === record.process?.pid))
          // A parsed Rustls request carries the native Session id and an exact, PID-reuse-safe
          // process generation. Keep it as the durable bridge after the process and Session FD
          // have disappeared (including after an API restart).
          ?? recordsWithProcess[0];
        observedLlmRequests = observations.flatMap((observation) => {
          const { record } = observation;
          if (
            !record.process
            || (
              record.input.protocol !== 'responses_api'
              && record.input.protocol !== 'messages_api'
              && record.input.protocol !== 'chat_completions_api'
            )
            || ![
              'ebpf_rustls',
              'ebpf_openssl',
              'ebpf_boringssl',
            ].includes(record.capture.captureMethod)
            || ![
              'exact_pid_runtime',
              'exact_binary_runtime',
            ].includes(record.capture.captureProfile)
            || record.capture.parseStatus !== 'parsed'
          ) {
            return [];
          }
          return [{
            interactionId: record.interactionId,
            observedAt: record.observedAt,
            pid: record.process.pid,
            ...(record.process.tid !== undefined
              ? { tid: record.process.tid }
              : {}),
            protocol: record.input.transportProtocol,
            providerHost: record.input.providerHost,
            requestPath: record.input.requestPath,
            endpointAttribution: record.input.endpointAttribution,
            ...(record.runtime?.modelProvider
              ? { provider: record.runtime.modelProvider }
              : {}),
            ...(record.input.model ? { model: record.input.model } : {}),
            sessionId: record.runtime?.sessionId ?? summary.sessionId,
            threadId: record.runtime?.threadId ?? summary.sessionId,
            ...(record.turn?.sourceTurnId
              ? { turnId: record.turn.sourceTurnId }
              : {}),
            ...(record.input.windowId
              ? { windowId: record.input.windowId }
              : {}),
            ...(record.input.requestKind
              ? { requestKind: record.input.requestKind }
              : {}),
            ...(observation.content !== undefined
              ? { content: observation.content }
              : {}),
            contentBytes: record.userInstruction.contentBytes,
            contentSha256: record.userInstruction.contentSha256,
            contentAvailability: observation.contentAvailability,
            capture: {
              method: record.capture.captureMethod as
                | 'ebpf_rustls'
                | 'ebpf_openssl'
                | 'ebpf_boringssl',
              // Runtime filter above already rejected runtime_adapter; narrow for LocalObservedLlmRequest.
              profile: record.capture.captureProfile as
                | 'exact_pid_runtime'
                | 'exact_binary_runtime',
              completeness: record.capture.captureCompleteness,
              parseStatus: 'parsed' as const,
            },
          }];
        });
        observerRequestEvidence =
          observedLlmRequests.length > 0 ? 'observed' : 'not_observed';
      }
    } catch {
      observerRequestEvidence = 'unavailable';
      observedLlmRequests = [];
    }

    let systemEvidence: LocalRecordDetail['systemEvidence'];
    if (includeSystemEvidence) {
      // System attribution can scan and reconcile thousands of lifecycle facts. Keep it outside
      // the fast Session-detail path so conversation/timeline tabs are not held behind a
      // database-heavy evidence projection. The web client requests this branch only when the
      // System Evidence tab is opened.
      const liveExactProcesses = this.exactProcessMatches(processScan, summary.recordId);
      const knownBinding = this.processBindings.get(summary.recordId);
      const knownExactProcess = knownBinding
        ? this.exactProcessView(knownBinding)
        : undefined;
      const observedExactProcesses = runtimeBindingRecords.flatMap((record) => {
        const identity = canonicalProcessLifecycleIdentity(record.process);
        if (!identity?.startTime.startsWith('ticks:')) return [];
        const startTimeTicks = identity.startTime.slice('ticks:'.length);
        return [{
          bindingMethod: 'observer_request',
          pid: identity.pid,
          startTimeTicks,
          matchedPid: identity.pid,
          matchedStartTimeTicks: startTimeTicks,
          recordId: summary.recordId,
        } satisfies ExactProcessMatch];
      });
      const exactProcesses = this.sortExactProcessMatches([...new Map(
        [
          ...observedExactProcesses,
          ...(knownExactProcess ? [knownExactProcess] : []),
          // Map keeps the last value: a live FD match retains its launcher/root identity when the
          // same runtime generation is also present in a persisted Observer request.
          ...liveExactProcesses,
        ].map((item) => [
          `${item.matchedPid}:${item.matchedStartTimeTicks}`,
          item,
        ]),
      ).values()]);
      const preferredIdentity = canonicalProcessLifecycleIdentity(runtimeBindingRecord?.process);
      const preferredExactProcess = exactProcesses.find((match) =>
        preferredIdentity?.pid === match.matchedPid
        && preferredIdentity.startTime === `ticks:${match.matchedStartTimeTicks}`)
        ?? exactProcesses[0];
      const orderedExactProcesses = preferredExactProcess
        ? [
            preferredExactProcess,
            ...exactProcesses.filter((item) => item !== preferredExactProcess),
          ]
        : exactProcesses;
      const attributionWindow = {
        since: Math.max(1, summary.startedAt - 5 * 60 * 1_000),
        // A long-lived CLI can keep an old Session FD open while later turns belong to other
        // Session files. Process liveness alone must not keep widening historical evidence up to
        // "now"; only a Session that is itself still being written has an open-ended window.
        until: summary.processStatus === 'running'
          && summary.activityStatus === 'active'
          ? Date.now() + 1_000
          : summary.updatedAt + 5 * 60 * 1_000,
      };
      const evidenceTimeWindows = this.systemEvidenceTimeWindows(
        parsed.events,
        observedLlmRequests,
        attributionWindow,
      );
      const interactiveEvidence = this.interactiveSystemEvidenceWindow(
        attributionWindow,
        evidenceTimeWindows,
        summary.activityStatus === 'active'
          ? ACTIVE_INTERACTIVE_SYSTEM_EVIDENCE_LOOKBACK_MS
          : INTERACTIVE_SYSTEM_EVIDENCE_LOOKBACK_MS,
      );
      const interactiveExactProcesses = this.interactiveExactProcessMatches(
        orderedExactProcesses,
        runtimeBindingRecords,
        summary.activityStatus === 'active',
        liveExactProcesses,
      );
      const generationsOmitted = interactiveExactProcesses.length < orderedExactProcesses.length;
      // Binding discovery only needs to identify the process generation that produced the
      // interactive evidence page. For a Session that is still receiving writes, using the full
      // lifetime here made a multi-week PID lookup scan the entire lifecycle projection before
      // the already-bounded evidence walk could begin. Keep the historical window for stopped
      // records (so an old exit can still be recovered), but use the latest bounded activity
      // window for active records. The candidate's Session start is still preserved as
      // `validFrom` inside resolveBinding, so this does not shorten attribution semantics.
      const bindingResolutionWindow = summary.activityStatus === 'active'
        ? interactiveEvidence.window
        : attributionWindow;
      if (
        this.sessionAttribution
        && interactiveExactProcesses.length === 0
        && (
          entry.adapter === 'a3s_code'
          || entry.adapter === 'claude_code'
          || entry.adapter === 'gemini_cli'
      || entry.adapter === 'kimi_cli'
        )
      ) {
        const fileName = basename(entry.path);
        const sessionIdFile = `${summary.sessionId}.${entry.adapter === 'claude_code' ? 'jsonl' : 'json'}`;
        // A3S v1 stores the canonical document under v1/sessions/ while companion
        // runs/traces remain keyed by session.id at the sessions root. Include both
        // container-visible and host paths so FileAccess events can resolve either view.
        const sessionPaths = entry.adapter === 'a3s_code' ? [
          entry.path,
          join(entry.root, entry.relativePath),
          join(dirname(entry.path), 'runs', fileName),
          join(dirname(entry.path), 'traces', fileName),
          join(entry.root, 'runs', fileName),
          join(entry.root, 'traces', fileName),
          join(entry.root, 'runs', sessionIdFile),
          join(entry.root, 'traces', sessionIdFile),
          ...(entry.hostRoot ? [
            join(entry.hostRoot, entry.relativePath),
            join(entry.hostRoot, 'runs', fileName),
            join(entry.hostRoot, 'traces', fileName),
            join(entry.hostRoot, 'runs', sessionIdFile),
            join(entry.hostRoot, 'traces', sessionIdFile),
          ] : []),
        ] : [
          entry.path,
          join(entry.root, entry.relativePath),
          ...(entry.hostRoot ? [join(entry.hostRoot, entry.relativePath)] : []),
        ];
        const sessionBinding = await this.sessionAttribution.resolveBindingFromSessionFile({
          runtimeType: entry.adapter,
          nativeSessionId: summary.sessionId,
          sessionPaths,
          // Containerized runs (Harbor) write through a mount whose in-container view
          // (/logs/agent/.kimi-code/...) never equals the host path; the Session-id directory
          // is a globally unique marker that aligns both views without a path map.
          pathMarkers: summary.sessionId.length >= 8 ? [`/${summary.sessionId}/`] : [],
          validFrom: Math.max(1, summary.startedAt - SESSION_PROCESS_STARTUP_GRACE_MS),
          ...(summary.processStatus === 'exited'
            ? { validTo: summary.updatedAt + SESSION_PROCESS_DRAIN_GRACE_MS }
            : {}),
        }, bindingResolutionWindow, { persist: false });
        if (sessionBinding) {
          systemEvidence = await this.sessionAttribution.evidence(
            sessionBinding,
            interactiveEvidence.window,
            interactiveEvidence.timeWindows,
            evidenceLimit,
            {
              coveragePartial: interactiveEvidence.coveragePartial || generationsOmitted,
              // Interactive evidence must remain responsive even when PostgreSQL is degraded;
              // the background reconciler persists the same lineage asynchronously.
              persist: false,
            },
          );
          summary = {
            ...summary,
            processEvidence: 'ebpf_session_file',
            processPid: sessionBinding.matchedPid,
            processObservedAt: sessionBinding.observedAt,
          };
        }
      }
      if (this.sessionAttribution && interactiveExactProcesses.length > 0) {
        const resolvedEvidence: NonNullable<LocalRecordDetail['systemEvidence']>[] = [];
        for (const exactProcess of interactiveExactProcesses) {
          const matchingRuntimeRecord = runtimeBindingRecords.find((record) => {
            const identity = canonicalProcessLifecycleIdentity(record.process);
            return identity?.pid === exactProcess.matchedPid
              && identity.startTime === `ticks:${exactProcess.matchedStartTimeTicks}`;
          });
          const sessionBinding = await this.sessionAttribution.resolveBinding(
            this.sessionProcessBindingCandidate(
              summary,
              exactProcess,
              matchingRuntimeRecord,
            ),
            bindingResolutionWindow,
            { persist: false },
          );
          if (!sessionBinding) continue;
          resolvedEvidence.push(await this.sessionAttribution.evidence(
            sessionBinding,
            interactiveEvidence.window,
            interactiveEvidence.timeWindows,
            evidenceLimit,
            {
              coveragePartial: interactiveEvidence.coveragePartial || generationsOmitted,
              // Keep the detail request read-only. Persistence is handled by the background pass.
              persist: false,
            },
          ));
        }
        systemEvidence = this.mergeSystemEvidence(resolvedEvidence, evidenceLimit);
        if (systemEvidence && (generationsOmitted || resolvedEvidence.length < interactiveExactProcesses.length)) {
          systemEvidence.completeness = 'partial';
          if (systemEvidence.page) systemEvidence.page.hasMore = true;
        }
      }

      let currentRelationCount = systemEvidence
        ? systemEvidence.counts.direct + systemEvidence.counts.lineage
        : 0;
      if (
        currentRelationCount === 0
        && this.sessionAttribution
        && typeof this.sessionAttribution.historicalEvidenceForNativeSession === 'function'
      ) {
        // A resumed Session can outlive Observer capture. Failure to resolve its newest OS
        // generation must not hide durable relations from older, already-proven generations.
        // Read the latest historical page by Native Session identity; this path uses indexed
        // PostgreSQL relations plus bounded event-id hydration and never scans the events table.
        try {
          const historicalEvidence = await this.sessionAttribution
            .historicalEvidenceForNativeSession({
            nativeSessionId: summary.sessionId,
            runtimeType: entry.adapter,
            since: Math.max(1, summary.startedAt - SESSION_PROCESS_STARTUP_GRACE_MS),
            until: attributionWindow.until,
            eventLimit: evidenceLimit,
          });
          if (historicalEvidence?.length) {
            systemEvidence = this.mergeSystemEvidence(historicalEvidence, evidenceLimit);
            currentRelationCount = systemEvidence
              ? systemEvidence.counts.direct + systemEvidence.counts.lineage
              : 0;
          }
        } catch (error) {
          // Historical recovery is a read-only enhancement. A degraded relation store must not
          // turn the otherwise usable Native Session detail into a 500 response.
          this.logger.warn(
            `Historical Session evidence read failed for ${summary.sessionId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (
        currentRelationCount === 0
        && entry.adapter !== 'codex'
        && this.sessionAttribution
        && typeof this.sessionAttribution.resolveBindingsFromExactToolExec === 'function'
      ) {
        // Some adapters execute each tool in a short-lived sandbox and never expose the Native
        // Session file to that child. Recover only from an exact Native Tool Call -> eBPF
        // ToolExec match. The attribution service rejects repeated/concurrent process candidates;
        // workspace or time proximity alone is never sufficient.
        const anchors = parsed.events.flatMap((event, index) => {
          const command = event.kind === 'tool_call' ? event.command : undefined;
          if (!command?.trim() || !Number.isSafeInteger(event.timestamp)) return [];
          const result = parsed.events.slice(index + 1).find((candidate) =>
            candidate.kind === 'tool_result'
            && candidate.timestamp >= event.timestamp
            && (!event.callId || candidate.callId === event.callId)
            && (!event.turnId || candidate.turnId === event.turnId));
          return [{
            command,
            since: Math.max(attributionWindow.since, event.timestamp - 250),
            until: Math.min(
              attributionWindow.until,
              Math.min(event.timestamp + 60_000, (result?.timestamp ?? event.timestamp + 30_000) + 1_000),
            ),
          }];
        });
        if (anchors.length > 0) {
          try {
            const bindings = await this.sessionAttribution.resolveBindingsFromExactToolExec({
              runtimeType: entry.adapter,
              nativeSessionId: summary.sessionId,
              ...(summary.cwd && entry.adapter !== 'opencode' ? { workspacePath: summary.cwd } : {}),
              validFrom: attributionWindow.since,
              validTo: attributionWindow.until,
              anchors,
            }, { persist: false });
            const reconstructed: NonNullable<LocalRecordDetail['systemEvidence']>[] = [];
            let remaining = evidenceLimit;
            for (const binding of bindings) {
              if (remaining <= 0 || binding.validTo === undefined) break;
              const value = await this.sessionAttribution.evidence(
                binding,
                { since: binding.validFrom, until: binding.validTo },
                [{ sinceMs: binding.validFrom, untilMs: binding.validTo }],
                remaining,
                { persist: false, coveragePartial: true },
              );
              value.evidenceScope = 'historical_reconstructed';
              reconstructed.push(value);
              remaining -= Math.max(1, value.page.returnedEvents);
            }
            if (reconstructed.length > 0) {
              systemEvidence = this.mergeSystemEvidence(reconstructed, evidenceLimit);
            }
          } catch (error) {
            this.logger.warn(
              `Exact ToolExec Session evidence read failed for ${summary.sessionId}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      // A short-lived Codex process can open and close its Session between two /proc scans. In
      // that case the Native reader honestly starts at `unknown`, while the Observer can still
      // provide a PID-generation-safe binding plus the root generation's ProcessExit.
      if (summary.processStatus === 'unknown' && systemEvidence?.binding) {
        const rootExit = systemEvidence.events.find((event) =>
          event.relation === 'DIRECT'
          && event.eventKind === 'ProcessExit'
          && event.processInstanceKey
            === systemEvidence?.binding?.matchedOsProcessInstanceKey);
        const exact = interactiveExactProcesses.find((item) =>
          item.matchedPid === systemEvidence?.binding?.matchedPid);
        if (rootExit) {
          if (exact) this.processBindings.set(summary.recordId, {
            ...exact,
            state: 'exited',
            endEvidence: 'observed_exit',
          });
          summary = {
            ...summary,
            processStatus: 'exited',
            processEvidence: 'observed_exit',
            processPid: systemEvidence.binding.matchedPid,
            processObservedAt: rootExit.at,
          };
        }
      }
    }

    return {
      schemaVersion: 'anysentry.local-record-detail.v1',
      record: summary,
      events: selectedEvents,
      ...(includeObservedLlmRequests ? { observedLlmRequests } : { observedLlmRequests: [] }),
      ...(systemEvidence ? { systemEvidence } : {}),
      ...(includeSystemEvidence ? {
        toolEvidence: buildLocalToolEvidence(summary.sessionId, selectedEvents, systemEvidence, hasMore || window.truncatedLines > 0),
      } : {}),
      metrics,
      page: {
        beforeOffset: toOffset,
        ...(hasMore ? { nextBeforeOffset } : {}),
        hasMore,
        returnedEvents: selectedEvents.length,
        scannedFromOffset: window.fromOffset,
        scannedToOffset: window.toOffset,
        truncatedLines: window.truncatedLines,
      },
      provenance: {
        source: entry.adapter === 'a3s_code'
          ? 'a3s_code_local_session'
          : entry.adapter === 'claude_code'
            ? 'claude_code_local_session'
            : entry.adapter === 'gemini_cli'
              ? 'gemini_cli_local_session'
              : entry.adapter === 'opencode' ? 'opencode_local_session'
                : entry.adapter === 'kimi_cli' ? 'kimi_cli_local_session' : 'codex_local_session',
        captureMethod: 'local_file_read',
        readOnly: true,
        ebpfIncluded: observedLlmRequests.length > 0 || Boolean(systemEvidence?.events.length),
        observerRequestEvidence,
        observerSource: 'anysentry_observer',
        toolSemantics: 'agent_declared',
      },
      updateTime: new Date().toISOString(),
    };
  }

  private sessionProcessBindingCandidate(
    summary: LocalRecordSummary,
    exact: ExactProcessMatch,
    record?: InteractionInstructionRecord,
  ): SessionProcessBindingCandidate {
    const observedIdentity = record?.process
      ? canonicalProcessLifecycleIdentity(record.process)
      : undefined;
    const exactObservedIdentity = observedIdentity?.pid === exact.matchedPid
      && observedIdentity.startTime === `ticks:${exact.matchedStartTimeTicks}`
      ? observedIdentity
      : undefined;
    return {
      ...(record?.tenantId ? { tenantId: record.tenantId } : {}),
      ...(record?.environmentId ? { environmentId: record.environmentId } : {}),
      ...(record?.collectorId ? { collectorId: record.collectorId } : {}),
      runtimeType: record?.runtime?.runtimeType
        ?? summary.adapter,
      nativeSessionId: summary.sessionId,
      ...(record?.conversationId ? { conversationId: record.conversationId } : {}),
      // Runtime/Agent identities belong to one exact OS process generation. A native Session can
      // be resumed by another Codex process, so a record for the same nativeSessionId is not
      // sufficient evidence for copying process-scoped identities into this FD binding.
      ...(exactObservedIdentity && record?.processInstanceId
        ? { runtimeProcessInstanceId: record.processInstanceId }
        : {}),
      matchedPid: exact.matchedPid,
      matchedStartTime: `ticks:${exact.matchedStartTimeTicks}`,
      ...(exact.pid !== exact.matchedPid ? {
        launcherPid: exact.pid,
        launcherStartTime: `ticks:${exact.startTimeTicks}`,
      } : {}),
      ...(exactObservedIdentity && record?.agentInstanceId
        ? { agentInstanceId: record.agentInstanceId }
        : {}),
      validFrom: Math.max(1, summary.startedAt - SESSION_PROCESS_STARTUP_GRACE_MS),
      method: exact.bindingMethod ?? 'proc_fd',
      confidence: 1,
      ...(summary.processStatus === 'exited'
        ? { validTo: summary.updatedAt + SESSION_PROCESS_DRAIN_GRACE_MS }
        : {}),
      ...(exactObservedIdentity ? {
        observedIdentity: {
          processInstanceKey: exactObservedIdentity.processInstanceKey,
          hostId: exactObservedIdentity.hostId ?? record?.collectorId ?? '',
          bootId: exactObservedIdentity.bootId,
          ...(exactObservedIdentity.pidNamespace
            ? { pidNamespace: exactObservedIdentity.pidNamespace }
            : {}),
        },
      } : {}),
    };
  }

  private exactProcessMatches(
    scan: ProcessScanResult,
    recordId: string,
  ): ExactProcessMatch[] {
    const matches = [...(scan.exactByRecordId.get(recordId) ?? [])];
    // A caught transient FD is the same evidence class as the periodic scan: a verified
    // writable handle to the Session file. It stays usable while that process generation
    // is alive and the catch is fresh; dead or stale catches are dropped.
    const caught = this.transientFdCatches.get(recordId) ?? [];
    if (caught.length > 0) {
      const now = Date.now();
      const live = caught.filter((match) =>
        now - match.caughtAt <= TRANSIENT_FD_CATCH_TTL_MS
        && scan.liveRoots.get(match.matchedPid) === match.matchedStartTimeTicks);
      if (live.length > 0) this.transientFdCatches.set(recordId, live);
      else this.transientFdCatches.delete(recordId);
      for (const match of live) {
        if (!matches.some((item) =>
          item.matchedPid === match.matchedPid
          && item.matchedStartTimeTicks === match.matchedStartTimeTicks)) {
          matches.push(match);
        }
      }
    }
    return this.sortExactProcessMatches(matches);
  }

  private sortExactProcessMatches(
    matches: ExactProcessMatch[],
  ): ExactProcessMatch[] {
    return matches.sort((left, right) => {
      const leftStart = BigInt(left.matchedStartTimeTicks);
      const rightStart = BigInt(right.matchedStartTimeTicks);
      if (leftStart !== rightStart) return leftStart > rightStart ? -1 : 1;
      return right.matchedPid - left.matchedPid;
    });
  }

  private exactProcessView(binding: KnownProcessBinding): ExactProcessMatch {
    return {
      bindingMethod: binding.bindingMethod,
      pid: binding.pid,
      startTimeTicks: binding.startTimeTicks,
      matchedPid: binding.matchedPid,
      matchedStartTimeTicks: binding.matchedStartTimeTicks,
      recordId: binding.recordId,
    };
  }

  private interactiveExactProcessMatches(
    matches: readonly ExactProcessMatch[],
    runtimeRecords: readonly InteractionInstructionRecord[],
    active: boolean,
    liveMatches: readonly ExactProcessMatch[] = [],
  ): ExactProcessMatch[] {
    const ordered = [...matches];
    if (ordered.length <= 1) return ordered;

    const observedAtByGeneration = new Map<string, number>();
    for (const record of runtimeRecords) {
      const identity = canonicalProcessLifecycleIdentity(record.process);
      if (!identity || !identity.startTime.startsWith('ticks:')) continue;
      const observedAt = Math.trunc(record.observedAt);
      if (!Number.isSafeInteger(observedAt) || observedAt <= 0) continue;
      const key = `${identity.pid}:${identity.startTime.slice('ticks:'.length)}`;
      observedAtByGeneration.set(
        key,
        Math.max(observedAtByGeneration.get(key) ?? 0, observedAt),
      );
    }
    ordered.sort((a, b) => (observedAtByGeneration.get(`${b.matchedPid}:${b.matchedStartTimeTicks}`) ?? 0)
      - (observedAtByGeneration.get(`${a.matchedPid}:${a.matchedStartTimeTicks}`) ?? 0));
    if (!active || observedAtByGeneration.size === 0) return ordered.slice(0, MAX_INTERACTIVE_GENERATIONS);

    const latestObservedAt = Math.max(...observedAtByGeneration.values());
    const selected = ordered.filter((match) => {
      const observedAt = observedAtByGeneration.get(
        `${match.matchedPid}:${match.matchedStartTimeTicks}`,
      );
      return observedAt !== undefined
        && observedAt >= latestObservedAt - ACTIVE_PROCESS_GENERATION_OVERLAP_MS;
    });
    // A resumed process can already own the exact Session FD before its first observed TLS
    // request arrives. Historical request metadata must never exclude that live generation.
    // Keep PID + start ticks together: a recycled numeric PID is not the same process.
    const liveKeys = new Set(liveMatches.map(match => `${match.matchedPid}:${match.matchedStartTimeTicks}`));
    const current = this.sortExactProcessMatches(ordered.filter(match =>
      liveKeys.has(`${match.matchedPid}:${match.matchedStartTimeTicks}`)));
    const visible = [...new Set([...current, ...selected])];
    // A resumed Session can have both old and new generations within one visible Turn window.
    // Query a bounded set, live owners first; the caller marks omitted generations partial.
    if (visible.length > 0) return visible.slice(0, MAX_INTERACTIVE_GENERATIONS);
    return ordered.slice(0, MAX_INTERACTIVE_GENERATIONS);
  }

  private preferredExactProcess(
    scan: ProcessScanResult,
    recordId: string,
    record?: InteractionInstructionRecord,
  ): ExactProcessMatch | undefined {
    const matches = this.exactProcessMatches(scan, recordId);
    if (!record?.process) return matches[0];
    const observedIdentity = canonicalProcessLifecycleIdentity(record.process);
    return matches.find((match) =>
      observedIdentity?.pid === match.matchedPid
      && observedIdentity.startTime === `ticks:${match.matchedStartTimeTicks}`)
      ?? matches.find((match) => match.matchedPid === record.process?.pid)
      ?? matches[0];
  }

  private mergeSystemEvidence(
    evidence: NonNullable<LocalRecordDetail['systemEvidence']>[],
    eventLimit = 250,
  ): LocalRecordDetail['systemEvidence'] {
    if (evidence.length === 0) return undefined;
    const primary = evidence[0];
    const events = [...new Map(
      evidence.flatMap((item) => item.events).map((item) => [item.eventId, item]),
    ).values()]
      .sort((left, right) => right.at - left.at || right.eventId.localeCompare(left.eventId))
      .slice(0, eventLimit);
    const lineage = [...new Map(
      evidence.flatMap((item) => item.lineage).map((item) => [item.edgeId, item]),
    ).values()];
    const exceptions = [...new Map(
      evidence.flatMap((item) => item.exceptions).map((item) => [item.resultId, item]),
    ).values()];
    const evidenceScopes = new Set(
      evidence.map((item) => item.evidenceScope ?? 'current_generation'),
    );
    return {
      ...primary,
      evidenceScope: evidenceScopes.size > 1
        ? 'mixed'
        : [...evidenceScopes][0],
      persistence: evidence.every((item) => item.persistence === 'persisted')
        ? 'persisted'
        : evidence.some((item) => item.persistence === 'degraded') ? 'degraded' : 'not_checked',
      completeness: evidence.every((item) => item.completeness === 'complete_as_observed')
        ? 'complete_as_observed'
        : evidence.some((item) => item.completeness === 'partial')
          ? 'partial'
          : 'unavailable',
      counts: {
        direct: evidence.reduce((sum, item) => sum + item.counts.direct, 0),
        lineage: evidence.reduce((sum, item) => sum + item.counts.lineage, 0),
        ambiguous: evidence.reduce((sum, item) => sum + item.counts.ambiguous, 0),
        conflict: evidence.reduce((sum, item) => sum + item.counts.conflict, 0),
        unattributed: evidence.reduce((sum, item) => sum + item.counts.unattributed, 0),
      },
      page: {
        requestedLimit: eventLimit,
        totalRelations: evidence.reduce(
          (sum, item) => sum + (
            item.page?.totalRelations ?? item.counts.direct + item.counts.lineage
          ),
          0,
        ),
        loadedRelations: evidence.reduce(
          (sum, item) => sum + (item.page?.loadedRelations ?? item.events.length),
          0,
        ),
        returnedEvents: events.length,
        unavailableEvents: evidence.reduce(
          (sum, item) => sum + (item.page?.unavailableEvents ?? 0),
          0,
        ),
        totalLineageEdges: evidence.reduce(
          (sum, item) => sum + (item.page?.totalLineageEdges ?? item.lineage.length),
          0,
        ),
        returnedLineageEdges: lineage.length,
        processFamilyTruncated: evidence.some((item) => item.page?.processFamilyTruncated),
        hasMore: evidence.some((item) => item.page?.hasMore ?? false)
          || new Set(evidence.flatMap(item => item.events.map(event => event.eventId))).size > events.length,
      },
      lineage,
      events,
      exceptions,
      calculatedAt: Math.max(...evidence.map((item) => item.calculatedAt)),
    };
  }

  /**
   * A Native Session may be resumed after hours or days while the same Codex process remains
   * alive. System evidence belongs to the Turn activity intervals, not every idle millisecond
   * between the first and latest write. Include a five-minute capture margin on both sides for
   * process setup, delayed exits and forwarder lag, then merge/compact without dropping coverage.
   */
  private systemEvidenceTimeWindows(
    events: readonly LocalRecordTimelineEvent[],
    requests: readonly LocalRecordDetail['observedLlmRequests'][number][],
    bounds: { since: number; until: number },
  ): Array<{ sinceMs: number; untilMs: number }> {
    const activityByTurn = new Map<string, { sinceMs: number; untilMs: number }>();
    const add = (key: string, timestamp: number) => {
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return;
      const current = activityByTurn.get(key);
      activityByTurn.set(key, {
        sinceMs: Math.min(current?.sinceMs ?? timestamp, timestamp),
        untilMs: Math.max(current?.untilMs ?? timestamp, timestamp),
      });
    };
    for (const event of events) {
      add(event.turnId ? `turn:${event.turnId}` : `event:${event.eventId}`, event.timestamp);
    }
    for (const request of requests) {
      add(
        request.turnId ? `turn:${request.turnId}` : `request:${request.interactionId}`,
        request.observedAt,
      );
    }
    const expanded = [...activityByTurn.values()]
      .map((window) => ({
        sinceMs: Math.max(bounds.since, window.sinceMs - SYSTEM_EVIDENCE_TURN_MARGIN_MS),
        untilMs: Math.min(bounds.until, window.untilMs + SYSTEM_EVIDENCE_TURN_MARGIN_MS),
      }))
      .filter((window) => window.sinceMs <= window.untilMs)
      .sort((left, right) => left.sinceMs - right.sinceMs || left.untilMs - right.untilMs);
    if (expanded.length === 0) {
      return [{ sinceMs: bounds.since, untilMs: bounds.until }];
    }
    const merged: Array<{ sinceMs: number; untilMs: number }> = [];
    for (const window of expanded) {
      const previous = merged.at(-1);
      if (previous && window.sinceMs <= previous.untilMs + 1) {
        previous.untilMs = Math.max(previous.untilMs, window.untilMs);
      } else {
        merged.push({ ...window });
      }
    }
    while (merged.length > MAX_SYSTEM_EVIDENCE_TIME_WINDOWS) {
      let closestIndex = 0;
      let closestGap = Number.POSITIVE_INFINITY;
      for (let index = 0; index < merged.length - 1; index += 1) {
        const gap = merged[index + 1].sinceMs - merged[index].untilMs;
        if (gap < closestGap) {
          closestGap = gap;
          closestIndex = index;
        }
      }
      merged.splice(closestIndex, 2, {
        sinceMs: merged[closestIndex].sinceMs,
        untilMs: merged[closestIndex + 1].untilMs,
      });
    }
    return merged;
  }

  /**
   * Bound the expensive process-family walk used by the interactive System Evidence tab. Native
   * Session files are append-only and can remain open for days, while the selected detail page
   * normally represents the latest few Turns. Keep a full bounds object for binding discovery,
   * but feed attribution only the latest bounded activity horizon. This avoids scanning idle
   * history and makes the completeness downgrade explicit in the response.
   */
  private interactiveSystemEvidenceWindow(
    bounds: { since: number; until: number },
    activityWindows: readonly { sinceMs: number; untilMs: number }[],
    lookbackMs = INTERACTIVE_SYSTEM_EVIDENCE_LOOKBACK_MS,
  ): {
    window: { since: number; until: number };
    timeWindows: Array<{ sinceMs: number; untilMs: number }>;
    coveragePartial: boolean;
  } {
    const normalizedBounds = {
      since: Math.max(1, Math.trunc(bounds.since)),
      until: Math.max(Math.max(1, Math.trunc(bounds.since)), Math.trunc(bounds.until)),
    };
    const normalizedActivity = activityWindows
      .map((activity) => ({
        sinceMs: Math.max(normalizedBounds.since, Math.trunc(activity.sinceMs)),
        untilMs: Math.min(normalizedBounds.until, Math.trunc(activity.untilMs)),
      }))
      .filter((activity) =>
        Number.isSafeInteger(activity.sinceMs)
        && Number.isSafeInteger(activity.untilMs)
        && activity.sinceMs <= activity.untilMs)
      .sort((left, right) => left.sinceMs - right.sinceMs || left.untilMs - right.untilMs);
    const latestActivityAt = normalizedActivity.length > 0
      ? Math.max(...normalizedActivity.map((activity) => activity.untilMs))
      : normalizedBounds.until;
    const boundedLookbackMs = Math.max(60_000, Math.trunc(lookbackMs));
    const since = Math.max(
      normalizedBounds.since,
      latestActivityAt - boundedLookbackMs,
    );
    const until = Math.min(normalizedBounds.until, latestActivityAt + SYSTEM_EVIDENCE_TURN_MARGIN_MS);
    const timeWindows = normalizedActivity
      .map((activity) => ({
        sinceMs: Math.max(since, activity.sinceMs),
        untilMs: Math.min(until, activity.untilMs),
      }))
      .filter((activity) => activity.sinceMs <= activity.untilMs);
    const boundedWindows = timeWindows.length > 0
      ? timeWindows
      : [{ sinceMs: since, untilMs: until }];
    return {
      window: { since, until },
      timeWindows: boundedWindows,
      coveragePartial: since > normalizedBounds.since
        || until < normalizedBounds.until
        || boundedWindows.length !== normalizedActivity.length,
    };
  }

  /**
   * Incrementally materialize recent Session relations without making the record-list request
   * wait for ClickHouse. Full history remains an explicit detail-page replay.
   */
  private scheduleActiveSessionAttribution(
    summaries: LocalRecordSummary[],
    processScan: ProcessScanResult,
  ): void {
    if (!this.sessionAttribution || !processScan.available) return;
    if (/^(?:0|false|off|no)$/iu.test(
      process.env.ANYSENTRY_SESSION_ATTRIBUTION_BACKGROUND?.trim() ?? '',
    )) return;
    const now = Date.now();
    const active = summaries.flatMap((summary) =>
      summary.processStatus === 'running'
        ? this.exactProcessMatches(processScan, summary.recordId)
          .map((exact) => ({ summary, exact }))
        : []);
    const unique = [...new Map(active.map((item) => [
      `${item.summary.sessionId}:${item.exact.matchedPid}:${item.exact.matchedStartTimeTicks}`,
      item,
    ])).values()];
    const liveKeys = new Set<string>();
    for (const { summary, exact } of unique) {
      const key = `${summary.sessionId}:${exact.matchedPid}:${exact.matchedStartTimeTicks}`;
      liveKeys.add(key);
      const previous = this.attributionGenerations.get(key);
      if (!previous && this.attributionGenerations.size >= MAX_ATTRIBUTION_GENERATIONS) {
        this.logger.warn('Session attribution generation queue full; discovery will retry');
        continue;
      }
      if (previous) Object.assign(previous, { summary, exact, lastSeenAt: now, tailSince: undefined, observedOnly: false });
      else this.attributionGenerations.set(key, { summary, exact, lastSeenAt: now,
        initialSince: Math.max(1, now - ACTIVE_ATTRIBUTION_LOOKBACK_MS) });
    }
    for (const [key, item] of this.attributionGenerations) {
      if (liveKeys.has(key)) continue;
      if (now - item.lastSeenAt > ATTRIBUTION_TAIL_RETENTION_MS) {
        if (!item.tailVerified) this.logger.warn(`Session tail replay expired without complete persistence: ${item.summary.sessionId} PID ${item.exact.matchedPid} ticks:${item.exact.matchedStartTimeTicks}`);
        this.attributionGenerations.delete(key);
        continue;
      }
      const latestSummary = summaries.find(summary => summary.recordId === item.summary.recordId);
      if (latestSummary) item.summary = latestSummary;
      // Freeze the replay head on disappearance. Late-arriving exit/exec facts must still be
      // revisited even after the first successful tail pass; never transfer to a reused PID.
      item.tailSince ??= item.checkpoint
        ? Math.max(1, item.checkpoint - ACTIVE_ATTRIBUTION_OVERLAP_MS)
        : item.initialSince;
    }
    if (this.activeAttributionInFlight
      || this.sessionAttribution.hasEvidenceInFlight?.()
      || now - this.activeAttributionLastStartedAt < ACTIVE_ATTRIBUTION_RECONCILE_MS
    ) return;
    this.activeAttributionLastStartedAt = now;
    const until = now + 1_000;
    const work = (async () => {
      let failed = false;
      // Short CLI generations can exit between two FD scans (or while the API restarts).
      // Admit only explicit Native Session + observed OS-generation evidence, never timestamps
      // or a recycled numeric PID alone. Discovery and replay stay bounded to the recent tail.
      const status = this.interactions.status();
      if (status.enabled && (status.projection.postgresql || status.projection.clickhouse)) {
        const recent = summaries.filter(s => now - s.updatedAt <= ATTRIBUTION_TAIL_RETENTION_MS)
          .sort((a,b) => b.updatedAt-a.updatedAt).slice(0,16);
        for (const summary of recent) {
          try {
            const observations = await this.interactions.instructionsForRuntimeSession(summary.sessionId, {
              since: Math.max(1,now-ATTRIBUTION_TAIL_RETENTION_MS), until, limit:32,
              projection:'clickhouse', includeContent:false,
            });
            for (const {record} of observations) {
              if (record.runtime?.sessionId !== summary.sessionId && record.runtime?.threadId !== summary.sessionId) continue;
              const identity = canonicalProcessLifecycleIdentity(record.process);
              if (!identity?.startTime.startsWith('ticks:') || !identity.hostId || !identity.bootId) continue;
              const ticks=identity.startTime.slice('ticks:'.length);
              const key=`${summary.sessionId}:${identity.pid}:${ticks}`;
              if (this.attributionGenerations.has(key) || this.attributionGenerations.size>=MAX_ATTRIBUTION_GENERATIONS) continue;
              const initialSince=Math.max(1,record.observedAt-ACTIVE_ATTRIBUTION_LOOKBACK_MS);
              this.attributionGenerations.set(key, {summary,
                exact:{recordId:summary.recordId,pid:identity.pid,matchedPid:identity.pid,
                  startTimeTicks:ticks,matchedStartTimeTicks:ticks,bindingMethod:'observer_request'},
                lastSeenAt:now,initialSince,tailSince:initialSince,observedOnly:true,runtimeRecord:record});
            }
          } catch(error) {
            failed=true;
            this.logger.warn(`Recent Session generation discovery failed: ${summary.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      for (const item of [...this.attributionGenerations.values()]) {
        const { exact } = item;
        const tail = item.tailSince !== undefined;
        const summary: LocalRecordSummary = item.observedOnly
          ? { ...item.summary, processStatus: 'unknown' }
          : tail
          ? { ...item.summary, processStatus: 'exited',
            updatedAt: Math.min(item.summary.updatedAt, item.lastSeenAt + PROCESS_CACHE_MS) }
          : item.summary;
        const since = item.tailSince ?? (item.checkpoint
          ? Math.max(1, item.checkpoint - ACTIVE_ATTRIBUTION_OVERLAP_MS)
          : item.initialSince);
        const through = item.observedOnly
          ? Math.min(until, Math.max(item.summary.updatedAt + SESSION_PROCESS_DRAIN_GRACE_MS,
            item.lastSeenAt + PROCESS_CACHE_MS + SESSION_PROCESS_DRAIN_GRACE_MS))
          : tail ? Math.min(until, item.lastSeenAt + PROCESS_CACHE_MS + SESSION_PROCESS_DRAIN_GRACE_MS) : until;
        try {
          // A parsed Observer request is the strongest bridge between a Native Session and an
          // exact OS process generation. Reuse it during background materialization just as the
          // interactive evidence path does. Without this bridge, a long-lived Codex root that
          // has no recent lifecycle row can be impossible to resolve from a two-minute window.
          let runtimeRecord = item.runtimeRecord;
          const interactionStatus = this.interactions.status();
          if (
            interactionStatus.enabled
            && (interactionStatus.projection.postgresql || interactionStatus.projection.clickhouse)
          ) {
            const observations = await this.interactions.instructionsForRuntimeSession(
              summary.sessionId,
              {
                since: Math.max(
                  1,
                  summary.startedAt - SYSTEM_EVIDENCE_TURN_MARGIN_MS,
                  now - ACTIVE_PROCESS_GENERATION_OVERLAP_MS,
                ),
                until,
                limit: 100,
                projection: 'clickhouse',
                includeContent: false,
              },
            );
            runtimeRecord = observations
              .map((observation) => observation.record)
              .find((record) => {
                const identity = canonicalProcessLifecycleIdentity(record.process);
                return identity?.pid === exact.matchedPid
                  && identity.startTime === `ticks:${exact.matchedStartTimeTicks}`;
              }) ?? runtimeRecord;
          }
          item.runtimeRecord = runtimeRecord;
          const binding = await this.sessionAttribution?.resolveBinding(
            this.sessionProcessBindingCandidate(summary, exact, runtimeRecord),
            { since, until: through },
          );
          if (!binding || !this.sessionAttribution) { failed = true; continue; }
          const result = await this.sessionAttribution.evidence(
            binding,
            { since, until: through },
            undefined,
            ACTIVE_ATTRIBUTION_EVENT_LIMIT,
          );
          if (result?.persistence === 'persisted' && result.completeness === 'complete_as_observed') {
            if (!tail) item.checkpoint = through;
            else item.tailVerified = true;
          } else {
            if (tail) item.tailVerified = false;
            failed = true;
          }
        } catch (error) {
          failed = true;
          this.logger.warn(
            `Background Session attribution failed for ${summary.sessionId} `
            + `(PID ${exact.matchedPid}, start ${exact.matchedStartTimeTicks}): `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Do not move the global checkpoint past a failed Session. Successful Sessions are already
      // idempotently persisted; the overlap retry will only revisit them while giving the failed
      // process generation another chance after ClickHouse/PostgreSQL recover.
      if (!failed) this.activeAttributionCheckpoint = until;
    })();
    this.activeAttributionInFlight = work;
    void work.catch((error) => {
      this.logger.warn(
        `Background Session attribution scheduler failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }).finally(() => {
      if (this.activeAttributionInFlight === work) this.activeAttributionInFlight = undefined;
    });
  }

  private isEnabled(): boolean {
    return enabled(process.env.ANYSENTRY_LOCAL_RECORD_TRACKING);
  }

  private configuredCodexRoot(): string | undefined {
    const explicit = process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR?.trim();
    if (explicit) return isAbsolute(explicit) ? resolve(explicit) : undefined;
    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome && isAbsolute(codexHome)) return resolve(codexHome, 'sessions');
    return resolve(homedir(), '.codex', 'sessions');
  }

  private configuredRoots(): LocalRecordRoot[] {
    const roots: LocalRecordRoot[] = [];
    const harborJobs = process.env.ANYSENTRY_LOCAL_HARBOR_JOBS_DIR?.trim();
    if (harborJobs && isAbsolute(harborJobs)) {
      roots.push({ adapter: 'codex', path: resolve(harborJobs), harborJobs: true });
    }
    const codexRoot = this.configuredCodexRoot();
    if (codexRoot) {
      roots.push({
        adapter: 'codex',
        path: codexRoot,
        ...(this.configuredHostSessionsRoot()
          ? { hostPath: this.configuredHostSessionsRoot() }
          : {}),
      });
    }
    const explicitRoots = [
      ...(process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_DIR?.trim() ?? '',
    ].filter(Boolean);
    const a3sRoots = explicitRoots.length > 0
      ? explicitRoots
      : process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR?.trim()
        ? []
        : [
          resolve(process.cwd(), '.a3s', 'tui', 'sessions'),
          resolve(homedir(), '.a3s', 'tui', 'sessions'),
          resolve(homedir(), '.a3s', 'tui-sessions'),
        ];
    const hostRoots = [
      ...(process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_HOST_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_A3S_SESSIONS_HOST_DIR?.trim() ?? '',
    ].filter(Boolean);
    for (const [index, rawPath] of a3sRoots.entries()) {
      if (!isAbsolute(rawPath)) continue;
      roots.push({
        adapter: 'a3s_code',
        path: resolve(rawPath),
        ...(hostRoots[index] && isAbsolute(hostRoots[index])
          ? { hostPath: resolve(hostRoots[index]) }
          : {}),
      });
    }
    const explicitClaudeRoots = [
      ...(process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_DIR?.trim() ?? '',
    ].filter(Boolean);
    const claudeRoots = explicitClaudeRoots.length > 0
      ? explicitClaudeRoots
      : [resolve(homedir(), '.claude', 'projects')];
    const claudeHostRoots = [
      ...(process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_HOST_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_CLAUDE_SESSIONS_HOST_DIR?.trim() ?? '',
    ].filter(Boolean);
    for (const [index, rawPath] of claudeRoots.entries()) {
      if (!isAbsolute(rawPath)) continue;
      roots.push({
        adapter: 'claude_code',
        path: resolve(rawPath),
        ...(claudeHostRoots[index] && isAbsolute(claudeHostRoots[index])
          ? { hostPath: resolve(claudeHostRoots[index]) }
          : {}),
      });
    }
    const explicitGeminiRoots = [
      ...(process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_DIR?.trim() ?? '',
    ].filter(Boolean);
    const geminiHome = process.env.GEMINI_CLI_HOME?.trim();
    const geminiRoots = explicitGeminiRoots.length > 0
      ? explicitGeminiRoots
      : [geminiHome && isAbsolute(geminiHome)
        ? resolve(geminiHome, '.gemini', 'tmp')
        : resolve(homedir(), '.gemini', 'tmp')];
    const geminiHostRoots = [
      ...(process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_HOST_DIRS ?? '')
        .split(delimiter)
        .map((value) => value.trim())
        .filter(Boolean),
      process.env.ANYSENTRY_LOCAL_GEMINI_SESSIONS_HOST_DIR?.trim() ?? '',
    ].filter(Boolean);
    for (const [index, rawPath] of geminiRoots.entries()) {
      if (!isAbsolute(rawPath)) continue;
      roots.push({
        adapter: 'gemini_cli',
        path: resolve(rawPath),
        ...(geminiHostRoots[index] && isAbsolute(geminiHostRoots[index])
          ? { hostPath: resolve(geminiHostRoots[index]) }
          : {}),
      });
    }
    const kimiRoots = [
      ...(process.env.ANYSENTRY_LOCAL_KIMI_SESSIONS_DIRS ?? '').split(delimiter),
      process.env.ANYSENTRY_LOCAL_KIMI_SESSIONS_DIR ?? '',
    ].map(value => value.trim()).filter(Boolean);
    // No implicit ~/.kimi-code default: tests and deployments pin roots explicitly via env.
    if (!kimiRoots.length) kimiRoots.push(resolve(process.env.KIMI_SHARE_DIR || join(homedir(), '.kimi'), 'sessions'));
    const kimiHostRoots = [
      ...(process.env.ANYSENTRY_LOCAL_KIMI_SESSIONS_HOST_DIRS ?? '').split(delimiter),
      process.env.ANYSENTRY_LOCAL_KIMI_SESSIONS_HOST_DIR ?? '',
    ].map(value => value.trim()).filter(Boolean);
    for (const [index, path] of kimiRoots.entries()) {
      if (!isAbsolute(path)) continue;
      roots.push({ adapter: 'kimi_cli', path: resolve(path),
        ...(kimiHostRoots[index] && isAbsolute(kimiHostRoots[index]) ? { hostPath: resolve(kimiHostRoots[index]) } : {}) });
    }
    const openCodeRoots = [
      ...(process.env.ANYSENTRY_LOCAL_OPENCODE_DATA_DIRS ?? '').split(delimiter),
      process.env.ANYSENTRY_LOCAL_OPENCODE_DATA_DIR ?? '',
    ].map(value => value.trim()).filter(Boolean);
    if (!openCodeRoots.length) openCodeRoots.push(resolve(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode'));
    for (const path of openCodeRoots) {
      if (isAbsolute(path)) roots.push({ adapter: 'opencode', path: resolve(path) });
    }
    return [...new Map(roots.map((root) => [
      `${root.adapter}:${root.path}`,
      root,
    ])).values()];
  }

  private isProcessTrackingEnabled(): boolean {
    return enabled(process.env.ANYSENTRY_LOCAL_PROCESS_TRACKING);
  }

  private configuredProcessRoot(): string | undefined {
    const explicit = process.env.ANYSENTRY_LOCAL_PROCESS_ROOT?.trim();
    if (!explicit) return this.isProcessTrackingEnabled() ? '/proc' : undefined;
    return isAbsolute(explicit) ? resolve(explicit) : undefined;
  }

  private configuredHostSessionsRoot(): string | undefined {
    const explicit =
      process.env.ANYSENTRY_LOCAL_CODEX_SESSIONS_HOST_DIR?.trim();
    return explicit && isAbsolute(explicit) ? resolve(explicit) : undefined;
  }

  private async processObservationStatus(): Promise<
    LocalRecordTrackingStatus['processObservation']
  > {
    if (!this.isProcessTrackingEnabled()) {
      return {
        enabled: false,
        available: false,
        source: 'not_configured',
      };
    }
    const root = this.configuredProcessRoot();
    if (!root) {
      return {
        enabled: true,
        available: false,
        source: 'unavailable',
        lastError: 'ANYSENTRY_LOCAL_PROCESS_ROOT must be an absolute path',
      };
    }
    try {
      const resolvedRoot = await realpath(root);
      const details = await stat(resolvedRoot);
      if (!details.isDirectory()) {
        throw new Error('configured process root is not a directory');
      }
      return {
        enabled: true,
        available: true,
        source: 'host_proc_fd',
        rootDisplay: resolvedRoot,
      };
    } catch (error) {
      return {
        enabled: true,
        available: false,
        source: 'unavailable',
        rootDisplay: root,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private statusValue(input: {
    enabled: boolean;
    rootConfigured: boolean;
    rootAccessible: boolean;
    rootDisplay?: string;
    adapters?: LocalRecordAdapter[];
    recordCount: number;
    lastError?: string;
    processObservation: LocalRecordTrackingStatus['processObservation'];
  }): LocalRecordTrackingStatus {
    const adapters = [...new Set(input.adapters ?? [])];
    return {
      schemaVersion: 'anysentry.local-record-tracking-status.v1',
      enabled: input.enabled,
      adapter: adapters.length > 1 ? 'multi' : adapters[0] ?? 'codex',
      adapters,
      rootConfigured: input.rootConfigured,
      rootAccessible: input.rootAccessible,
      ...(input.rootDisplay ? { rootDisplay: input.rootDisplay } : {}),
      recordCount: input.recordCount,
      readMode: 'bounded_read_only',
      contentSource: 'local_session_files',
      systemEvidence: input.processObservation.available
        ? 'host_proc_fd'
        : input.processObservation.enabled
          ? 'unavailable'
          : 'not_collected',
      processObservation: input.processObservation,
      ...(input.lastError ? { lastError: input.lastError } : {}),
      limitations: [
        '只读解析本机 Agent Session，不写入或修改源文件',
        input.processObservation.available
          ? '进程状态只由精确 Session FD 与已验证 PID 生命周期判定，不使用文件时间猜测'
          : '未获得宿主机进程证据时，进程状态保持未知',
        'Tool Call 是 Agent 声明的操作，不等同于 eBPF 证明的底层执行',
        '超大记录按有界字节窗口分页，窗口指标会明确标记',
      ],
      updateTime: new Date().toISOString(),
    };
  }

  private statusWithProcessScan(
    status: LocalRecordTrackingStatus,
    scan: ProcessScanResult,
  ): LocalRecordTrackingStatus {
    if (!status.processObservation.enabled || scan.available) return status;
    return {
      ...status,
      systemEvidence: 'unavailable',
      processObservation: {
        ...status.processObservation,
        available: false,
        source: 'unavailable',
        ...(scan.lastError ? { lastError: scan.lastError } : {}),
      },
    };
  }

  private refreshLiveAgentBindings(
    summaries: LocalRecordSummary[],
    scan: ProcessScanResult,
  ) {
    const agents = scan.liveAgents ?? [];
    for (const [recordId, binding] of this.liveAgentBindings) {
      if (scan.liveRoots.get(binding.pid) !== binding.startTimeTicks) {
        this.liveAgentBindings.delete(recordId);
        continue;
      }
      const agent = agents.find((item) =>
        item.pid === binding.pid && item.startTimeTicks === binding.startTimeTicks);
      const pathSessions = agent
        ? this.sessionsReferencedByPaths(summaries, agent)
        : [];
      if (pathSessions.length === 1 && pathSessions[0].recordId !== recordId) {
        this.liveAgentBindings.delete(recordId);
      }
    }

    const usedPids = new Set<number>();
    for (const matches of scan.exactByRecordId.values()) {
      for (const match of matches) usedPids.add(match.pid);
    }
    for (const binding of this.processBindings.values()) {
      if (
        binding.state === 'running'
        && scan.liveRoots.get(binding.pid) === binding.startTimeTicks
      ) usedPids.add(binding.pid);
    }
    for (const binding of this.liveAgentBindings.values()) usedPids.add(binding.pid);
    const boundRecords = new Set<string>([
      ...scan.exactByRecordId.keys(),
      ...[...this.processBindings.entries()]
        .filter(([, binding]) => binding.state === 'running')
        .map(([recordId]) => recordId),
      ...this.liveAgentBindings.keys(),
    ]);
    // cwd is a shared launch directory, not Session identity. When a bound record of the same
    // adapter already occupies this cwd, an unbound process there may belong to that record's
    // process tree, so a cwd guess would risk attaching the wrong process (wrong PID display).
    const boundCwdByAdapter = new Set<string>();
    for (const summary of summaries) {
      if (!summary.cwd || !boundRecords.has(summary.recordId)) continue;
      boundCwdByAdapter.add(`${summary.adapter}:${normalize(summary.cwd)}`);
    }

    // Process-side ambiguity: several unbound live processes of one adapter on the same cwd
    // that do not form a single process tree cannot share one cwd guess — the guess could
    // attach a foreign Session's process. Parent/child chains of one tree stay eligible.
    const agentByPid = new Map(agents.map((agent) => [agent.pid, agent]));
    const ambiguousCwd = new Set<string>();
    const cwdGroups = new Map<string, LiveAgentObservation[]>();
    for (const agent of agents) {
      if (!agent.cwd || usedPids.has(agent.pid)) continue;
      if (boundCwdByAdapter.has(`${agent.adapter}:${normalize(agent.cwd)}`)) continue;
      const key = `${agent.adapter}:${normalize(agent.cwd)}`;
      cwdGroups.set(key, [...(cwdGroups.get(key) ?? []), agent]);
    }
    for (const [key, group] of cwdGroups) {
      if (group.length < 2) continue;
      const members = new Set(group.map((agent) => agent.pid));
      const roots = new Set<number>();
      for (const agent of group) {
        let cursor = agent;
        const seen = new Set<number>([agent.pid]);
        while (cursor.ppid !== undefined
          && cursor.ppid !== cursor.pid
          && !seen.has(cursor.ppid)
          && members.has(cursor.ppid)) {
          seen.add(cursor.ppid);
          cursor = agentByPid.get(cursor.ppid)!;
        }
        roots.add(cursor.pid);
      }
      if (roots.size > 1) ambiguousCwd.add(key);
    }

    for (const agent of agents) {
      if (usedPids.has(agent.pid)) continue;
      if (agent.cwd && boundCwdByAdapter.has(`${agent.adapter}:${normalize(agent.cwd)}`)) continue;
      const pathSessions = this.sessionsReferencedByPaths(summaries, agent)
        .filter((summary) => !boundRecords.has(summary.recordId));
      const chosen = pathSessions.length === 1
        ? pathSessions[0]
        : pathSessions.length === 0
          && !(agent.cwd && ambiguousCwd.has(`${agent.adapter}:${normalize(agent.cwd)}`))
          ? this.liveAgentCwdSession(summaries, agent, boundRecords)
          : undefined;
      if (!chosen) continue;
      this.liveAgentBindings.set(chosen.recordId, {
        pid: agent.pid,
        startTimeTicks: agent.startTimeTicks,
      });
      usedPids.add(agent.pid);
      boundRecords.add(chosen.recordId);
    }
  }

  private sessionsReferencedByPaths(
    summaries: LocalRecordSummary[],
    agent: LiveAgentObservation,
  ): LocalRecordSummary[] {
    return summaries.filter((summary) =>
      summary.adapter === agent.adapter
      && summary.sessionId.length >= 8
      && agent.openPaths.some((path) => path.includes(summary.sessionId)));
  }

  private liveAgentCwdSession(
    summaries: LocalRecordSummary[],
    agent: LiveAgentObservation,
    boundRecords: Set<string>,
  ): LocalRecordSummary | undefined {
    if (!agent.cwd || agent.startMs === undefined) return undefined;
    const cwd = normalize(agent.cwd);
    const candidates = summaries
      .filter((summary) =>
        summary.adapter === agent.adapter
        && summary.cwd
        && normalize(summary.cwd) === cwd
        && !boundRecords.has(summary.recordId)
        && summary.updatedAt + LIVE_AGENT_CWD_SKEW_MS >= agent.startMs!)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.recordId.localeCompare(right.recordId));
    if (candidates.length === 0) return undefined;
    // Multiple recently-active Sessions on one cwd cannot be separated by cwd at all.
    const activeCandidates = candidates.filter(
      (summary) => Date.now() - summary.updatedAt <= LIVE_AGENT_ACTIVE_WINDOW_MS,
    );
    if (activeCandidates.length > 1) return undefined;
    if (activeCandidates.length === 1) return activeCandidates[0];
    if (
      candidates.length > 1
      && candidates[0].updatedAt === candidates[1].updatedAt
    ) return undefined;
    return candidates[0];
  }

  private async hydratePersistedProcessBindings(
    summaries: LocalRecordSummary[],
    scan: ProcessScanResult,
  ): Promise<void> {
    if (!scan.available || !this.sessionAttribution) return;
    const now = Date.now();
    const candidates = summaries
      .filter((summary) =>
        !this.processBindings.has(summary.recordId)
        && !(scan.exactByRecordId.get(summary.recordId) ?? []).length
        && !this.transientFdCatches.has(summary.recordId)
        && now - summary.updatedAt <= PERSISTED_BINDING_HYDRATE_WINDOW_MS
        && now - (this.persistedBindingHydration.get(summary.recordId) ?? 0)
          >= PERSISTED_BINDING_HYDRATE_COOLDOWN_MS)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, PERSISTED_BINDING_HYDRATE_MAX_PER_SCAN);
    for (const summary of candidates) {
      this.persistedBindingHydration.set(summary.recordId, now);
      try {
        const binding = await this.sessionAttribution.persistedBindingForNativeSession(
          summary.sessionId,
          summary.adapter,
        );
        if (!binding || !binding.matchedStartTime.startsWith('ticks:')) continue;
        if (binding.validTo !== undefined && binding.validTo <= now) continue;
        const startTimeTicks = binding.matchedStartTime.slice('ticks:'.length);
        // PID reuse guard: only the exact process generation the binding was proven against.
        if (scan.liveRoots.get(binding.matchedPid) !== startTimeTicks) continue;
        this.processBindings.set(summary.recordId, {
          recordId: summary.recordId,
          pid: binding.matchedPid,
          startTimeTicks,
          matchedPid: binding.matchedPid,
          matchedStartTimeTicks: startTimeTicks,
          bindingMethod: binding.method,
          state: 'running',
        });
      } catch {
        // The store may be degraded; the cwd heuristic remains as the fallback.
      }
    }
  }

  private enrichProcessStates(
    summaries: LocalRecordSummary[],
    scan: ProcessScanResult,
  ): LocalRecordSummary[] {
    for (const summary of summaries) this.latestSummaries.set(summary.recordId, summary);
    const guardSummaries = [...this.latestSummaries.values()];
    if (!scan.available) {
      return summaries.map((summary) => {
        const binding = this.processBindings.get(summary.recordId);
        if (binding?.state === 'exited') {
          return {
            ...summary,
            processStatus: 'exited',
            processEvidence: binding.endEvidence ?? 'observed_exit',
            processPid: binding.pid,
            processObservedAt: scan.observedAt,
          };
        }
        return {
          ...summary,
          processStatus: 'unknown',
          processEvidence: 'unavailable',
          processObservedAt: scan.observedAt,
        };
      });
    }

    for (const [recordId, binding] of this.processBindings) {
      if (binding.state === 'exited') continue;
      if (scan.liveRoots.get(binding.pid) !== binding.startTimeTicks) {
        this.processBindings.set(recordId, {
          ...binding,
          state: 'exited',
          endEvidence: 'observed_exit',
        });
      }
    }
    for (const [recordId] of scan.exactByRecordId) {
      const match = this.preferredExactProcess(scan, recordId);
      if (!match) continue;
      this.processBindings.set(recordId, {
        ...match,
        state: 'running',
      });
      this.liveAgentBindings.delete(recordId);
    }
    // inotify catches bypass exactByRecordId; give them the same in-memory stickiness so the
    // summary does not flap back to the cwd heuristic when the catch TTL expires.
    for (const recordId of this.transientFdCatches.keys()) {
      const known = this.processBindings.get(recordId);
      if (known?.state === 'running') continue;
      const match = this.preferredExactProcess(scan, recordId);
      if (!match) continue;
      this.processBindings.set(recordId, {
        ...match,
        state: 'running',
      });
      this.liveAgentBindings.delete(recordId);
    }
    this.refreshLiveAgentBindings(guardSummaries, scan);

    return summaries.map((summary) => {
      const exact = this.preferredExactProcess(scan, summary.recordId);
      if (exact) {
        return {
          ...summary,
          processStatus: 'running',
          processEvidence: 'proc_fd',
          processPid: exact.pid,
          processObservedAt: scan.observedAt,
        };
      }
      const binding = this.processBindings.get(summary.recordId);
      // A previously proven binding whose process generation is still alive outranks the
      // same-cwd heuristic: the heuristic is only a hint and can point at the wrong process
      // when several Sessions of one adapter share a workspace.
      if (
        binding
        && binding.state === 'running'
        && scan.liveRoots.get(binding.pid) === binding.startTimeTicks
      ) {
        return {
          ...summary,
          processStatus: 'running',
          processEvidence: 'sticky_binding',
          processPid: binding.pid,
          processObservedAt: scan.observedAt,
        };
      }
      const liveAgent = this.liveAgentBindings.get(summary.recordId);
      if (liveAgent && scan.liveRoots.get(liveAgent.pid) === liveAgent.startTimeTicks) {
        return {
          ...summary,
          processStatus: 'running',
          processEvidence: 'live_agent',
          processPid: liveAgent.pid,
          processObservedAt: scan.observedAt,
        };
      }
      if (!binding) {
        return {
          ...summary,
          processStatus: 'unknown',
          processEvidence: 'not_observed',
          processObservedAt: scan.observedAt,
        };
      }
      return {
        ...summary,
        processStatus: 'exited',
        processEvidence: binding.endEvidence ?? 'observed_exit',
        processPid: binding.pid,
        processObservedAt: scan.observedAt,
      };
    });
  }

  private async scanProcesses(
    entries: LocalRecordEntry[],
    observation: LocalRecordTrackingStatus['processObservation'],
  ): Promise<ProcessScanResult> {
    const observedAt = Date.now();
    const processRoot = this.configuredProcessRoot();
    if (!observation.enabled || !observation.available || !processRoot) {
      return {
        available: false,
        observedAt,
        exactByRecordId: new Map(),
        liveRoots: new Map(),
        liveAgents: [],
        ...(observation.lastError ? { lastError: observation.lastError } : {}),
      };
    }
    const configurationKey = [
      processRoot,
      ...entries.map((entry) => `${entry.adapter}:${entry.root}:${entry.hostRoot ?? ''}`),
      entries.length,
      entries[0]?.recordId ?? '',
    ].join(':');
    if (
      this.processCache
      && this.processCache.configurationKey === configurationKey
    ) {
      if (this.processCache.expiresAt > observedAt) return this.processCache.result;

      // Process discovery is a liveness hint, not the durable Session identity.  Keep serving
      // the last complete scan while one refresh runs in the background; otherwise an active
      // Session append invalidates the cache and every detail request waits for a full /proc/fd
      // walk before it can render the already-available local transcript.  Do not serve an
      // indefinitely stale result if the refresh is stuck or the host has changed materially.
      const maxStaleMs = boundedInteger(
        process.env.ANYSENTRY_LOCAL_PROCESS_MAX_STALE_MS,
        60_000,
        PROCESS_CACHE_MS,
        5 * 60_000,
      );
      const canServeStale = observedAt - this.processCache.refreshedAt <= maxStaleMs;
      const inFlight = this.processInFlight;
      if (canServeStale) {
        if (!inFlight || inFlight.configurationKey !== configurationKey) {
          void this.refreshProcessScan(
            entries,
            observation,
            processRoot,
            configurationKey,
          );
        }
        return this.processCache.result;
      }
    }

    const inFlight = this.processInFlight;
    if (inFlight?.configurationKey === configurationKey) return inFlight.promise;

    return this.refreshProcessScan(
      entries,
      observation,
      processRoot,
      configurationKey,
    );
  }

  private refreshProcessScan(
    entries: LocalRecordEntry[],
    observation: LocalRecordTrackingStatus['processObservation'],
    processRoot: string,
    configurationKey: string,
  ): Promise<ProcessScanResult> {
    const inFlight = this.processInFlight;
    if (inFlight?.configurationKey === configurationKey) return inFlight.promise;
    const promise = this.scanProcessesUncached(
      entries,
      observation,
      Date.now(),
      processRoot,
      configurationKey,
    );
    this.processInFlight = { configurationKey, promise };
    void promise.finally(() => {
      if (this.processInFlight?.promise === promise) this.processInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }

  private async scanProcessesUncached(
    entries: LocalRecordEntry[],
    observation: LocalRecordTrackingStatus['processObservation'],
    observedAt: number,
    processRoot: string,
    configurationKey: string,
  ): Promise<ProcessScanResult> {

    const entriesByPath = new Map<string, LocalRecordEntry>();
    const entriesByRelative = new Map<string, LocalRecordEntry>();
    const entriesByFileIdentity = new Map<string, LocalRecordEntry | null>();
    for (const entry of entries) {
      if (entry.fileIdentity) {
        const key = `${entry.adapter}:${entry.fileIdentity}`;
        entriesByFileIdentity.set(key, entriesByFileIdentity.has(key) ? null : entry);
      }
      entriesByPath.set(`${entry.adapter}:${resolve(entry.path)}`, entry);
      if (entry.hostRoot) {
        entriesByPath.set(
          `${entry.adapter}:${resolve(entry.hostRoot, entry.relativePath)}`,
          entry,
        );
      }
      entriesByRelative.set(
        `${entry.adapter}:${normalizedRelativePath(entry.relativePath)}`,
        entry,
      );
    }
    try {
      const processDirectories = (await readdir(processRoot, {
        withFileTypes: true,
      }))
        .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/u.test(entry.name))
        .map((entry) => Number(entry.name))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      const candidates: ProcessCandidateObservation[] = [];
      for (let index = 0; index < processDirectories.length; index += 32) {
        const batch = processDirectories.slice(index, index + 32);
        const values = await Promise.all(
          batch.map((pid) => this.processCandidate(
            processRoot,
            pid,
            entriesByPath,
            entriesByRelative,
            entriesByFileIdentity,
          )),
        );
        candidates.push(
          ...values.filter(
            (value): value is ProcessCandidateObservation => Boolean(value),
          ),
        );
      }

      const liveRoots = new Map<number, string>();
      const exactByRecordId = new Map<string, ExactProcessMatch[]>();
      for (const candidate of candidates) {
        liveRoots.set(candidate.root.pid, candidate.root.startTimeTicks);
        for (const recordId of candidate.recordIds) {
          const matches = exactByRecordId.get(recordId) ?? [];
          matches.push({
            ...candidate.root,
            matchedPid: candidate.matchedPid,
            matchedStartTimeTicks: candidate.matchedStartTimeTicks,
            recordId,
          });
          exactByRecordId.set(recordId, matches);
        }
      }
      const bootMs = await this.readBootTimeMs();
      const result: ProcessScanResult = {
        available: true,
        observedAt,
        exactByRecordId,
        liveRoots,
        liveAgents: candidates.map((candidate) => ({
          adapter: candidate.adapter,
          pid: candidate.root.pid,
          startTimeTicks: candidate.root.startTimeTicks,
          ...(bootMs === undefined
            ? {}
            : { startMs: processStartMs(bootMs, candidate.root.startTimeTicks) }),
          ...(candidate.cwd ? { cwd: candidate.cwd } : {}),
          ...(candidate.ppid !== undefined ? { ppid: candidate.ppid } : {}),
          openPaths: candidate.openPaths,
        })),
      };
      this.processCache = {
        refreshedAt: observedAt,
        expiresAt: observedAt + boundedInteger(
          process.env.ANYSENTRY_LOCAL_PROCESS_CACHE_MS,
          PROCESS_CACHE_MS,
          1,
          60_000,
        ),
        configurationKey,
        result,
      };
      return result;
    } catch (error) {
      const result: ProcessScanResult = {
        available: false,
        observedAt,
        exactByRecordId: new Map(),
        liveRoots: new Map(),
        liveAgents: [],
        lastError: error instanceof Error ? error.message : String(error),
      };
      this.processCache = {
        refreshedAt: observedAt,
        expiresAt: observedAt + PROCESS_CACHE_MS,
        configurationKey,
        result,
      };
      return result;
    }
  }

  private async readBootTimeMs(): Promise<number | undefined> {
    try {
      const statText = await readFile('/proc/stat', 'utf8');
      const bootSeconds = Number(/^btime\s+(\d+)$/mu.exec(statText)?.[1]);
      if (!Number.isSafeInteger(bootSeconds) || bootSeconds <= 0) return undefined;
      return bootSeconds * 1_000;
    } catch {
      return undefined;
    }
  }

  private async processCandidate(
    processRoot: string,
    pid: number,
    entriesByPath: Map<string, LocalRecordEntry>,
    entriesByRelative: Map<string, LocalRecordEntry>,
    entriesByFileIdentity: Map<string, LocalRecordEntry | null> = new Map(),
  ): Promise<ProcessCandidateObservation | undefined> {
    const processDirectory = join(processRoot, String(pid));
    try {
      const [commValue, commandLineValue, statValue] = await Promise.all([
        readFile(join(processDirectory, 'comm'), 'utf8'),
        readFile(join(processDirectory, 'cmdline'), 'utf8'),
        readFile(join(processDirectory, 'stat'), 'utf8'),
      ]);
      const argv = commandArguments(commandLineValue);
      const parsedStat = processStat(statValue);
      const adapter = this.runtimeAdapterFor(commValue, argv);
      if (!parsedStat || !adapter) {
        return undefined;
      }

      let root: ProcessIdentity = {
        pid,
        startTimeTicks: parsedStat.startTimeTicks,
      };
      if (adapter === 'codex' && parsedStat.ppid > 0) {
        const parentDirectory = join(processRoot, String(parsedStat.ppid));
        try {
          const [parentCommandLine, parentStatValue] = await Promise.all([
            readFile(join(parentDirectory, 'cmdline'), 'utf8'),
            readFile(join(parentDirectory, 'stat'), 'utf8'),
          ]);
          const parentStat = processStat(parentStatValue);
          if (
            parentStat
            && BigInt(parentStat.startTimeTicks) <= BigInt(parsedStat.startTimeTicks)
            && isCodexNodeLauncher(commandArguments(parentCommandLine))
          ) {
            root = {
              pid: parsedStat.ppid,
              startTimeTicks: parentStat.startTimeTicks,
            };
          }
        } catch {
          // The launcher may exit between the child and parent reads. The child identity
          // remains a valid, PID-reuse-safe fallback for this scan.
        }
      }

      const recordIds = new Set<string>();
      const openPaths: string[] = [];
      const cwd = await readlink(join(processDirectory, 'cwd')).catch(() => undefined);
      let descriptors: Dirent[] = [];
      try {
        descriptors = await readdir(join(processDirectory, 'fd'), {
          withFileTypes: true,
        });
      } catch {
        return {
          root,
          matchedPid: pid,
          matchedStartTimeTicks: parsedStat.startTimeTicks,
          recordIds: [],
          adapter,
          ppid: parsedStat.ppid,
          ...(cwd ? { cwd } : {}),
          openPaths,
        };
      }
      const fdLimit = adapter === 'a3s_code'
        ? MAX_A3S_FDS_TO_SCAN
        : MAX_CODEX_FDS_TO_SCAN;
      const orderedDescriptors = descriptors
        .filter((descriptor) => descriptor.isSymbolicLink())
        .sort((left, right) => Number(left.name) - Number(right.name));
      const scanKey = `${pid}:${parsedStat.startTimeTicks}`;
      const scanOffset = orderedDescriptors.length > fdLimit
        ? (this.processFdScanOffsets.get(scanKey) ?? 0) % orderedDescriptors.length
        : 0;
      const descriptorsToScan = orderedDescriptors.length <= fdLimit
        ? orderedDescriptors
        : [
            ...orderedDescriptors.slice(scanOffset, scanOffset + fdLimit),
            ...orderedDescriptors.slice(0, Math.max(0, scanOffset + fdLimit - orderedDescriptors.length)),
          ];
      if (orderedDescriptors.length > fdLimit) {
        this.processFdScanOffsets.delete(scanKey);
        this.processFdScanOffsets.set(
          scanKey,
          (scanOffset + fdLimit) % orderedDescriptors.length,
        );
        while (this.processFdScanOffsets.size > 4_096) {
          const oldest = this.processFdScanOffsets.keys().next().value as string | undefined;
          if (!oldest) break;
          this.processFdScanOffsets.delete(oldest);
        }
      } else {
        this.processFdScanOffsets.delete(scanKey);
      }
      const hostRoots = [...new Set(
        [...entriesByPath.values()]
          .filter((entry) => entry.adapter === adapter && entry.hostRoot)
          .map((entry) => entry.hostRoot as string),
      )];
      for (let index = 0; index < descriptorsToScan.length; index += PROCESS_FD_READ_BATCH) {
        const batch = descriptorsToScan.slice(index, index + PROCESS_FD_READ_BATCH);
        const targets = await Promise.all(batch.map(async (descriptor) => {
          try {
            const fdPath = join(processDirectory, 'fd', descriptor.name);
            const target = await readlink(fdPath);
            openPaths.push(target);
            const normalizedTarget = target.replace(/ \(deleted\)$/u, '');
            // Harbor exposes the same file as /logs/agent/sessions/... and
            // host job/trial/agent/sessions/... . Prove file identity across mount views;
            // matching only a basename or time would mix parallel trials.
            let inodeEntry: LocalRecordEntry | undefined;
            let fdIdentity: string | undefined;
            if (entriesByFileIdentity.size && normalizedTarget.includes('/sessions/')
              && normalizedTarget.endsWith('.jsonl')) {
              const fdStat = await stat(fdPath, { bigint: true });
              fdIdentity = `${fdStat.dev}:${fdStat.ino}`;
              inodeEntry = entriesByFileIdentity.get(`${adapter}:${fdIdentity}`) ?? undefined;
            }
            const possibleEntry = entriesByPath.has(`${adapter}:${normalizedTarget}`)
              || [sessionRelativePathFromFd(normalizedTarget),
                ...hostRoots.map((hostRoot) => sessionRelativePathFromFd(normalizedTarget, hostRoot))]
                .some((relative) => relative && entriesByRelative.has(
                  `${adapter}:${normalizedRelativePath(relative)}`));
            if (!possibleEntry && !inodeEntry) return undefined;
            // Reading someone else's transcript is not Session ownership. Only inspect
            // fdinfo for known Session paths; do not add a read for every process FD.
            const info = await readFile(join(processDirectory, 'fdinfo', descriptor.name), 'utf8');
            const flagsText = /^flags:\s*([0-7]+)\s*$/mu.exec(info)?.[1];
            if (!flagsText) return undefined;
            const flags = BigInt(`0o${flagsText}`);
            const accessMode = flags & 3n;
            if ((accessMode !== 1n && accessMode !== 2n) || (flags & 0o10000000n) !== 0n) {
              return undefined;
            }
            // An FD can close or be reused between the link and fdinfo reads.
            if (await readlink(fdPath) !== target) return undefined;
            const finalInfo = await readFile(join(processDirectory, 'fdinfo', descriptor.name), 'utf8');
            if (/^flags:\s*([0-7]+)\s*$/mu.exec(finalInfo)?.[1] !== flagsText) return undefined;
            if (inodeEntry) {
              const [lastFd, lastFile] = await Promise.all([
                stat(fdPath, { bigint: true }), stat(inodeEntry.path, { bigint: true }),
              ]);
              if (`${lastFd.dev}:${lastFd.ino}` !== fdIdentity
                || `${lastFile.dev}:${lastFile.ino}` !== fdIdentity) return undefined;
            }
            return { target, inodeEntry };
          } catch {
            // File descriptors are inherently racy. A later scan will retry.
            return undefined;
          }
        }));
        for (const match of targets) {
          if (!match) continue;
          const { target, inodeEntry } = match;
          if (inodeEntry) {
            recordIds.add(inodeEntry.recordId);
            continue;
          }
          const normalizedTarget = target.replace(/ \(deleted\)$/u, '');
          const exactEntry = entriesByPath.get(`${adapter}:${normalizedTarget}`);
          if (exactEntry) {
            // A Harbor entry with a known inode must not fall back to path-only ownership
            // after an ambiguous inode lookup or file replacement.
            if (exactEntry.fileIdentity) continue;
            recordIds.add(exactEntry.recordId);
            continue;
          }
          const relativeCandidates = [
            sessionRelativePathFromFd(normalizedTarget),
            ...hostRoots.map((hostRoot) =>
              sessionRelativePathFromFd(normalizedTarget, hostRoot)),
          ];
          for (const relativePath of relativeCandidates) {
            if (!relativePath) continue;
            const entry = entriesByRelative.get(
              `${adapter}:${normalizedRelativePath(relativePath)}`,
            );
            if (entry && !entry.fileIdentity) {
              recordIds.add(entry.recordId);
              break;
            }
          }
        }
      }
      // PID reuse or exec during the FD walk must not join one process generation's
      // descriptors to another's identity. Missing /proc entries are rejected too.
      const [finalStatValue, finalComm, finalCommandLine] = await Promise.all([
        readFile(join(processDirectory, 'stat'), 'utf8'),
        readFile(join(processDirectory, 'comm'), 'utf8'),
        readFile(join(processDirectory, 'cmdline'), 'utf8'),
      ]);
      const finalStat = processStat(finalStatValue);
      if (!finalStat || finalStat.startTimeTicks !== parsedStat.startTimeTicks
        || finalComm !== commValue || finalCommandLine !== commandLineValue) return undefined;
      if (root.pid !== pid) {
        const parentStat = await readFile(join(processRoot, String(root.pid), 'stat'), 'utf8')
          .then(processStat).catch(() => undefined);
        if (!parentStat || parentStat.startTimeTicks !== root.startTimeTicks
          || finalStat.ppid !== root.pid) {
          root = { pid, startTimeTicks: parsedStat.startTimeTicks };
        }
      }
      return {
        root,
        matchedPid: pid,
        matchedStartTimeTicks: parsedStat.startTimeTicks,
        recordIds: [...recordIds],
        adapter,
        ppid: parsedStat.ppid,
        ...(cwd ? { cwd } : {}),
        openPaths,
      };
    } catch {
      return undefined;
    }
  }

  private runtimeAdapterFor(comm: string, argv: string[]): LocalRecordAdapter | undefined {
    return isCodexRuntimeProcess(comm, argv)
      ? 'codex'
      : isA3sCodeRuntimeProcess(comm, argv)
        ? 'a3s_code'
        : isClaudeCodeRuntimeProcess(comm, argv)
          ? 'claude_code'
          : isGeminiCliRuntimeProcess(comm, argv) ? 'gemini_cli'
            : isKimiCliRuntimeProcess(comm, argv) ? 'kimi_cli' : undefined;
  }

  private refreshTransientFdWatchers(
    entries: LocalRecordEntry[],
    scan: ProcessScanResult,
  ): void {
    if (!scan.available) return;
    const now = Date.now();
    const wanted = new Map<string, LocalRecordEntry>();
    for (const entry of entries) {
      if (now - entry.mtimeMs > TRANSIENT_FD_WATCH_WINDOW_MS) continue;
      // A Session already proven by the periodic full scan does not need a watcher.
      if ((scan.exactByRecordId.get(entry.recordId) ?? []).length > 0) continue;
      wanted.set(entry.recordId, entry);
      if (wanted.size >= TRANSIENT_FD_WATCH_MAX) break;
    }
    for (const [recordId, watcher] of this.transientFdWatchers) {
      if (wanted.has(recordId)) continue;
      watcher.close();
      this.transientFdWatchers.delete(recordId);
    }
    for (const [recordId, entry] of wanted) {
      if (this.transientFdWatchers.has(recordId)) continue;
      try {
        const watcher = watch(dirname(entry.path), (_eventType, filename) => {
          if (filename && filename !== basename(entry.path)) return;
          this.queueTransientFdScan(entry);
        });
        watcher.on('error', () => {
          watcher.close();
          this.transientFdWatchers.delete(recordId);
        });
        // Keep the watcher from holding the event loop open (verify scripts never call onModuleDestroy).
        watcher.unref();
        this.transientFdWatchers.set(recordId, watcher);
      } catch {
        // inotify may be unavailable or exhausted; the periodic full scan remains the fallback.
      }
    }
  }

  private queueTransientFdScan(entry: LocalRecordEntry): void {
    // The FD is open only for the duration of one append (milliseconds). A trailing debounce
    // almost always lands after close(2), so scan immediately on the inotify event, then retry
    // twice to cover write bursts; the in-flight guard keeps concurrent scans coalesced.
    void this.catchTransientFd(entry).catch(() => undefined);
    const pending = this.transientFdDebounce.get(entry.recordId) ?? [];
    for (const timer of pending) clearTimeout(timer);
    const retries = [TRANSIENT_FD_SCAN_DEBOUNCE_MS, TRANSIENT_FD_SCAN_DEBOUNCE_MS * 4]
      .map((delay) => setTimeout(() => {
        void this.catchTransientFd(entry).catch(() => undefined);
      }, delay).unref());
    this.transientFdDebounce.set(entry.recordId, retries);
  }

  private async catchTransientFd(entry: LocalRecordEntry): Promise<void> {
    const processRoot = this.configuredProcessRoot();
    if (!processRoot || this.transientFdScanInFlight.has(entry.recordId)) return;
    this.transientFdScanInFlight.add(entry.recordId);
    try {
      const pids = (await readdir(processRoot, { withFileTypes: true }))
        .filter((item) => item.isDirectory() && /^[1-9]\d*$/u.test(item.name))
        .map((item) => Number(item.name))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      // The FD symlink shows the host view of the path; the container view must match too.
      const targets = new Set([
        resolve(entry.path),
        ...(entry.hostRoot ? [resolve(entry.hostRoot, entry.relativePath)] : []),
      ]);
      for (const pid of pids) {
        const match = await this.transientFdProcessMatch(processRoot, pid, entry, targets);
        if (!match) continue;
        const list = this.transientFdCatches.get(entry.recordId) ?? [];
        if (!list.some((item) =>
          item.matchedPid === match.matchedPid
          && item.matchedStartTimeTicks === match.matchedStartTimeTicks)) {
          list.push(match);
          this.transientFdCatches.set(entry.recordId, list.slice(-8));
        }
      }
    } catch {
      // /proc enumeration is inherently racy; the next write event retries.
    } finally {
      this.transientFdScanInFlight.delete(entry.recordId);
    }
  }

  private async transientFdProcessMatch(
    processRoot: string,
    pid: number,
    entry: LocalRecordEntry,
    targets: Set<string>,
  ): Promise<(ExactProcessMatch & { caughtAt: number }) | undefined> {
    const processDirectory = join(processRoot, String(pid));
    try {
      const [commValue, commandLineValue, statValue] = await Promise.all([
        readFile(join(processDirectory, 'comm'), 'utf8'),
        readFile(join(processDirectory, 'cmdline'), 'utf8'),
        readFile(join(processDirectory, 'stat'), 'utf8'),
      ]);
      const parsedStat = processStat(statValue);
      if (!parsedStat || this.runtimeAdapterFor(commValue, commandArguments(commandLineValue)) !== entry.adapter) {
        return undefined;
      }
      const descriptors = (await readdir(join(processDirectory, 'fd'), { withFileTypes: true }))
        .filter((descriptor) => descriptor.isSymbolicLink());
      for (const descriptor of descriptors) {
        const fdPath = join(processDirectory, 'fd', descriptor.name);
        const target = await readlink(fdPath);
        if (!targets.has(target.replace(/ \(deleted\)$/u, ''))) continue;
        // Same evidence bar as the periodic scan: a writable, stable FD only.
        const info = await readFile(join(processDirectory, 'fdinfo', descriptor.name), 'utf8');
        const flagsText = /^flags:\s*([0-7]+)\s*$/mu.exec(info)?.[1];
        if (!flagsText) return undefined;
        const flags = BigInt(`0o${flagsText}`);
        const accessMode = flags & 3n;
        if ((accessMode !== 1n && accessMode !== 2n) || (flags & 0o10000000n) !== 0n) {
          return undefined;
        }
        if (await readlink(fdPath) !== target) return undefined;
        const finalInfo = await readFile(join(processDirectory, 'fdinfo', descriptor.name), 'utf8');
        if (/^flags:\s*([0-7]+)\s*$/mu.exec(finalInfo)?.[1] !== flagsText) return undefined;
        // PID reuse or exec during the walk must not join one generation's FD to another's identity.
        const [finalStatValue, finalComm, finalCommandLine] = await Promise.all([
          readFile(join(processDirectory, 'stat'), 'utf8'),
          readFile(join(processDirectory, 'comm'), 'utf8'),
          readFile(join(processDirectory, 'cmdline'), 'utf8'),
        ]);
        const finalStat = processStat(finalStatValue);
        if (!finalStat || finalStat.startTimeTicks !== parsedStat.startTimeTicks
          || finalComm !== commValue || finalCommandLine !== commandLineValue) return undefined;
        return {
          pid,
          startTimeTicks: parsedStat.startTimeTicks,
          matchedPid: pid,
          matchedStartTimeTicks: parsedStat.startTimeTicks,
          recordId: entry.recordId,
          caughtAt: Date.now(),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async discover(): Promise<DiscoveryResult> {
    const configuredRoots = this.configuredRoots();
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('local record tracking is disabled');
    }
    if (configuredRoots.length === 0) {
      throw new ServiceUnavailableException(
        'local Session roots must be absolute paths',
      );
    }
    const configurationKey = `${configuredRoots.map((item) => `${item.adapter}:${item.path}`).join('|')}:${process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES ?? ''}`;
    if (
      this.discoveryCache
      && this.discoveryCache.configurationKey === configurationKey
      && this.discoveryCache.expiresAt > Date.now()
    ) {
      return this.discoveryCache.result;
    }

    const inFlight = this.discoveryInFlight;
    if (inFlight?.configurationKey === configurationKey) return inFlight.promise;

    const promise = this.discoverUncached(configuredRoots, configurationKey);
    this.discoveryInFlight = { configurationKey, promise };
    void promise.finally(() => {
      if (this.discoveryInFlight?.promise === promise) this.discoveryInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }

  private async discoverUncached(
    configuredRoots: LocalRecordRoot[],
    configurationKey: string,
  ): Promise<DiscoveryResult> {

    const maxFiles = boundedInteger(
      process.env.ANYSENTRY_LOCAL_RECORD_MAX_FILES,
      500,
      1,
      2_000,
    );
    const candidates: LocalRecordEntry[] = [];
    const accessibleRoots: LocalRecordRoot[] = [];
    for (const configuredRoot of configuredRoots) {
      let root: string;
      try {
        root = await realpath(configuredRoot.path);
        if (!(await stat(root)).isDirectory()) continue;
      } catch {
        continue;
      }
      accessibleRoots.push({ ...configuredRoot, path: root });
      if (configuredRoot.adapter === 'opencode') {
        // One shared DB contains many Sessions. Its FD/inode is never a Session identity.
        const database = join(root, 'opencode.db');
        const sessions = await discoverOpenCodeSessions(database, maxFiles);
        const info = await stat(database).catch(() => undefined);
        const wal = await stat(`${database}-wal`).catch(() => undefined);
        for (const session of sessions) {
          candidates.push({ recordId: createHash('sha256').update(`opencode:${database}:${session.sessionId}`).digest('hex').slice(0, 24),
            adapter: 'opencode', root, path: database, relativePath: `opencode.db#${session.sessionId}`,
            nativeSessionId: session.sessionId, size: (info?.size ?? 0) + (wal?.size ?? 0),
            mtimeMs: Math.max(session.updatedAt, info?.mtimeMs ?? 0, wal?.mtimeMs ?? 0), birthtimeMs: session.startedAt });
        }
        continue;
      }
      const stack = [root];
      let visitedDirectories = 0;
      while (stack.length > 0 && visitedDirectories < 10_000) {
        const directory = stack.pop()!;
        visitedDirectories += 1;
        let children: Dirent[];
        try {
          children = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const childPath = join(directory, child.name);
          if (child.isDirectory()) {
            // A Harbor archive is job/trial/agent/sessions/YYYY/MM/DD. Never
            // crawl verifier artifacts, task data or arbitrary task JSONL files.
            if (configuredRoot.harborJobs) {
              const parts = relative(root, childPath).split(sep);
              if ((parts.length === 3 && parts[2] !== 'agent')
                || (parts.length >= 4 && parts[3] !== 'sessions')) continue;
            }
            // Codex stores sessions directly below its root, while A3S Code v1
            // nests them under `v1/sessions`. Recurse for both adapters; only
            // supported JSON/JSONL files become records. A3S companion folders
            // contain auxiliary JSON documents, not sessions, so skip them.
            if (
              configuredRoot.adapter === 'a3s_code'
              && ['runs', 'traces', 'subagent_tasks', 'verification', 'artifacts', 'loop_checkpoints'].includes(child.name)
            ) continue;
            stack.push(childPath);
            continue;
          }
          const relativePath = relative(root, childPath);
          const normalizedPath = normalizedRelativePath(relativePath);
          const supported = configuredRoot.adapter === 'kimi_cli'
            ? child.isFile() && /^[^/]+\/[^/]+\/(?:agents\/main\/)?wire\.jsonl$/u.test(normalizedPath)
            : configuredRoot.adapter === 'a3s_code'
            ? child.isFile() && child.name.endsWith('.json')
            : configuredRoot.adapter === 'gemini_cli'
              ? child.isFile()
                && /^[^/]+\/chats\/(?:session-[^/]+\.jsonl?|[^/]+\/[^/]+\.jsonl)$/iu.test(normalizedPath)
              : child.isFile() && child.name.endsWith('.jsonl');
          if (!supported) continue;
          if (configuredRoot.harborJobs) {
            const parts = relativePath.split(sep);
            if (parts.length < 5 || parts[2] !== 'agent' || parts[3] !== 'sessions'
              || !child.name.startsWith('rollout-')) continue;
          }
          if (
            relativePath.startsWith(`..${sep}`)
            || relativePath === '..'
            || isAbsolute(relativePath)
          ) continue;
          try {
            const details = await stat(childPath);
            const companionStats = configuredRoot.adapter === 'a3s_code'
              ? (await Promise.all([
                  'runs',
                  'traces',
                  'subagent_tasks',
                  'verification',
                ].map(async (folder) => {
                  try {
                    return await stat(join(root, folder, child.name));
                  } catch {
                    return undefined;
                  }
                }))).filter((item): item is NonNullable<typeof item> => item !== undefined)
              : [];
            candidates.push({
              recordId: createHash('sha256')
                .update(`${configuredRoot.adapter}:${root}:${relativePath}`)
                .digest('hex')
                .slice(0, 24),
              adapter: configuredRoot.adapter,
              root,
              ...(configuredRoot.hostPath ? { hostRoot: configuredRoot.hostPath } : {}),
              path: childPath,
              relativePath,
              size: details.size + companionStats.reduce((sum, item) => sum + item.size, 0),
              mtimeMs: Math.max(details.mtimeMs, ...companionStats.map((item) => item.mtimeMs)),
              birthtimeMs: details.birthtimeMs,
              ...(configuredRoot.harborJobs && Number.isSafeInteger(details.dev) && Number.isSafeInteger(details.ino)
                ? { fileIdentity: `${details.dev}:${details.ino}` } : {}),
            });
          } catch {
            // A session may rotate while discovery is running. The next refresh will retry it.
          }
        }
      }
    }
    if (accessibleRoots.length === 0) {
      throw new ServiceUnavailableException('no configured local record root is accessible');
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const result: DiscoveryResult = {
      root: accessibleRoots.map((item) => item.path).join(', '),
      adapters: [...new Set(accessibleRoots.map((item) => item.adapter))],
      entries: candidates.slice(0, maxFiles),
    };
    this.discoveryCache = {
      expiresAt: Date.now() + DISCOVERY_CACHE_MS,
      configurationKey,
      result,
    };
    return result;
  }

  private async summary(entry: LocalRecordEntry): Promise<LocalRecordSummary> {
    const cached = this.summaryCache.get(entry.recordId);
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      return cached.summary;
    }
    const inFlight = this.summaryInFlight.get(entry.recordId);
    if (
      inFlight
      && inFlight.size === entry.size
      && inFlight.mtimeMs === entry.mtimeMs
    ) {
      return inFlight.promise;
    }
    const promise = this.summaryUncached(entry);
    this.summaryInFlight.set(entry.recordId, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      promise,
    });
    void promise.finally(() => {
      const current = this.summaryInFlight.get(entry.recordId);
      if (current?.promise === promise) this.summaryInFlight.delete(entry.recordId);
    }).catch(() => undefined);
    return promise;
  }

  private async summaryUncached(entry: LocalRecordEntry): Promise<LocalRecordSummary> {
    if (
      entry.adapter === 'a3s_code'
      || entry.adapter === 'claude_code'
      || entry.adapter === 'gemini_cli'
      || entry.adapter === 'kimi_cli'
      || entry.adapter === 'opencode'
    ) {
      // The overview needs only the compact summary. Retaining every fully parsed run/traces
      // document made a host with many long A3S Sessions needlessly hold hundreds of MiB.
      const parsed = entry.adapter === 'a3s_code'
        ? await this.a3sRecord(entry, false)
        : entry.adapter === 'claude_code'
          ? await this.claudeRecord(entry, false)
          : entry.adapter === 'opencode' ? await this.openCodeRecord(entry)
            : entry.adapter === 'kimi_cli' ? await this.kimiRecord(entry) : await this.geminiRecord(entry, false);
      const ageMs = Math.max(0, Date.now() - parsed.updatedAt);
      const summary: LocalRecordSummary = {
        recordId: entry.recordId,
        adapter: entry.adapter,
        sessionId: parsed.sessionId,
        title: parsed.title,
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...('modelProvider' in parsed && parsed.modelProvider ? { modelProvider: parsed.modelProvider } : {}),
        originator: parsed.originator,
        ...('cliVersion' in parsed && parsed.cliVersion
          ? { cliVersion: parsed.cliVersion }
          : {}),
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        fileBytes: parsed.fileBytes,
        processStatus: 'unknown',
        processEvidence: 'unavailable',
        activityStatus: ageMs <= ACTIVE_WINDOW_MS
          ? 'active'
          : ageMs <= RECENT_WINDOW_MS ? 'recent' : 'stopped',
        metricScope: parsed.metrics.scope,
        userMessageCount: parsed.metrics.userMessageCount,
        assistantMessageCount: parsed.metrics.assistantMessageCount,
        completeTurnCount: parsed.metrics.completeTurnCount,
        toolCallCount: parsed.metrics.toolCallCount,
        toolFailureCount: parsed.metrics.toolFailureCount,
        tokenUsage: parsed.metrics.tokenUsage,
      };
      this.summaryCache.set(entry.recordId, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        summary,
      });
      return summary;
    }
    const headEnd = Math.min(entry.size, SUMMARY_HEAD_BYTES);
    const tailStart = Math.max(0, entry.size - SUMMARY_TAIL_BYTES);
    const head = await this.readWindow(entry.path, 0, headEnd, entry.size);
    const tail =
      tailStart <= headEnd
        ? await this.readWindow(entry.path, 0, entry.size, entry.size)
        : await this.readWindow(entry.path, tailStart, entry.size, entry.size);
    const lines =
      tailStart <= headEnd
        ? tail.lines
        : [...head.lines, ...tail.lines];
    const records = lines.map((line) => line.value);
    const meta = records.find((record) => record.type === 'session_meta');
    const metaPayload = meta ? payloadOf(meta) : {};
    const sessionId =
      stringValue(metaPayload.session_id)
      ?? stringValue(metaPayload.id)
      ?? basename(entry.path, '.jsonl');
    let firstUser: string | undefined;
    let firstFallbackUser: string | undefined;
    let latestModel: string | undefined;
    // POSIX stat can expose sub-millisecond precision as a floating-point mtimeMs. Every durable
    // attribution boundary is UInt64/bigint milliseconds, so normalize once at the Session edge.
    let latestTimestamp = Math.trunc(entry.mtimeMs);
    let tokenUsage = emptyTokenUsage();
    for (const record of records) {
      latestTimestamp = Math.max(latestTimestamp, recordTimestamp(record) ?? 0);
      const directUser = usefulUserMessage(userMessage(record));
      if (directUser && !firstUser) firstUser = directUser;
      const fallback = usefulUserMessage(responseMessage(record, 'user'));
      if (fallback && !firstFallbackUser) firstFallbackUser = fallback;
      if (record.type === 'turn_context') {
        latestModel = stringValue(payloadOf(record).model) ?? latestModel;
      }
      const candidateUsage = tokenUsageFrom(record);
      if (candidateUsage) tokenUsage = candidateUsage;
    }
    const parsed = this.timeline(entry.recordId, lines);
    if (parsed.metrics.tokenUsage.totalTokens > tokenUsage.totalTokens) {
      tokenUsage = parsed.metrics.tokenUsage;
    }
    const startedAt = Math.trunc(
      recordTimestamp(meta ?? {})
      ?? entry.birthtimeMs
      ?? entry.mtimeMs,
    );
    const ageMs = Math.max(0, Date.now() - entry.mtimeMs);
    const metricScope: LocalRecordMetricScope =
      entry.size <= SUMMARY_HEAD_BYTES + SUMMARY_TAIL_BYTES
        ? 'full_record'
        : 'recent_window';
    const summary: LocalRecordSummary = {
      recordId: entry.recordId,
      adapter: 'codex',
      sessionId,
      title:
        preview(firstUser ?? firstFallbackUser, 180)
        ?? `Codex 记录 ${sessionId.slice(0, 8)}`,
      cwd: stringValue(metaPayload.cwd),
      model: latestModel,
      modelProvider: stringValue(metaPayload.model_provider),
      originator: stringValue(metaPayload.originator),
      cliVersion: stringValue(metaPayload.cli_version),
      startedAt,
      updatedAt: Math.trunc(latestTimestamp || entry.mtimeMs),
      fileBytes: entry.size,
      processStatus: 'unknown',
      processEvidence: 'unavailable',
      activityStatus:
        ageMs <= ACTIVE_WINDOW_MS
          ? 'active'
          : ageMs <= RECENT_WINDOW_MS
            ? 'recent'
            : 'stopped',
      metricScope,
      userMessageCount: parsed.metrics.userMessageCount,
      assistantMessageCount: parsed.metrics.assistantMessageCount,
      completeTurnCount: parsed.metrics.completeTurnCount,
      toolCallCount: parsed.metrics.toolCallCount,
      toolFailureCount: parsed.metrics.toolFailureCount,
      tokenUsage,
    };
    this.summaryCache.set(entry.recordId, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      summary,
    });
    while (this.summaryCache.size > 2_000) {
      const oldest = this.summaryCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.summaryCache.delete(oldest);
    }
    return summary;
  }

  private async a3sRecord(
    entry: LocalRecordEntry,
    cacheResult = true,
  ): Promise<ParsedA3sCodeRecord> {
    const cached = this.a3sRecordCache.get(entry.recordId);
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      return cached.parsed;
    }
    const parsed = await parseA3sCodeRecord(entry.path, entry.recordId);
    if (!parsed) throw new NotFoundException('invalid A3S Code Session record');
    if (cacheResult && parsed.fileBytes <= MAX_A3S_RECORD_CACHE_BYTES) {
      this.a3sRecordCache.set(entry.recordId, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        parsed,
      });
    }
    const cachedBytes = () => [...this.a3sRecordCache.values()]
      .reduce((sum, item) => sum + item.parsed.fileBytes, 0);
    while (
      this.a3sRecordCache.size > MAX_A3S_RECORD_CACHE_ENTRIES
      || cachedBytes() > MAX_A3S_RECORD_CACHE_BYTES
    ) {
      const oldest = this.a3sRecordCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.a3sRecordCache.delete(oldest);
    }
    return parsed;
  }

  private async claudeRecord(
    entry: LocalRecordEntry,
    cacheResult = true,
  ): Promise<ParsedClaudeCodeRecord> {
    const cached = this.claudeRecordCache.get(entry.recordId);
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      return cached.parsed;
    }
    const parsed = await parseClaudeCodeRecord(entry.path, entry.recordId);
    if (!parsed) throw new NotFoundException('invalid Claude Code Session record');
    if (cacheResult && parsed.fileBytes <= MAX_A3S_RECORD_CACHE_BYTES) {
      this.claudeRecordCache.set(entry.recordId, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        parsed,
      });
    }
    while (this.claudeRecordCache.size > MAX_A3S_RECORD_CACHE_ENTRIES) {
      const oldest = this.claudeRecordCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.claudeRecordCache.delete(oldest);
    }
    return parsed;
  }

  private async kimiRecord(entry: LocalRecordEntry): Promise<ParsedKimiCliRecord> {
    const parsed = await parseKimiCliRecord(entry.path, entry.recordId);
    if (!parsed) throw new NotFoundException('invalid Kimi CLI Wire record');
    return parsed;
  }

  private async openCodeRecord(entry: LocalRecordEntry): Promise<ParsedOpenCodeRecord> {
    const parsed = await parseOpenCodeRecord(entry.path, entry.nativeSessionId ?? '', entry.recordId);
    if (!parsed) throw new NotFoundException('OpenCode Session is unavailable or its database schema is unsupported');
    return parsed;
  }

  private async geminiRecord(
    entry: LocalRecordEntry,
    cacheResult = true,
  ): Promise<ParsedGeminiCliRecord> {
    const cached = this.geminiRecordCache.get(entry.recordId);
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      return cached.parsed;
    }
    const parsed = await parseGeminiCliRecord(entry.path, entry.recordId);
    if (!parsed) throw new NotFoundException('invalid Gemini CLI Session record');
    if (cacheResult && parsed.fileBytes <= MAX_A3S_RECORD_CACHE_BYTES) {
      this.geminiRecordCache.set(entry.recordId, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        parsed,
      });
    }
    while (this.geminiRecordCache.size > MAX_A3S_RECORD_CACHE_ENTRIES) {
      const oldest = this.geminiRecordCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.geminiRecordCache.delete(oldest);
    }
    return parsed;
  }

  private async readWindow(
    path: string,
    requestedFrom: number,
    requestedTo: number,
    fileSize: number,
  ): Promise<ReadWindow> {
    const fromOffset = Math.min(fileSize, Math.max(0, requestedFrom));
    const toOffset = Math.min(fileSize, Math.max(fromOffset, requestedTo));
    const length = toOffset - fromOffset;
    if (length === 0) {
      return {
        lines: [],
        fromOffset,
        toOffset,
        firstCompleteOffset: fromOffset,
        scannedBytes: 0,
        truncatedLines: 0,
      };
    }
    const handle = await open(path, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, fromOffset);
      buffer = buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }

    let cursor = 0;
    if (fromOffset > 0) {
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline < 0) {
        return {
          lines: [],
          fromOffset,
          toOffset,
          firstCompleteOffset: fromOffset,
          scannedBytes: buffer.length,
          truncatedLines: 1,
        };
      }
      cursor = firstNewline + 1;
    }
    const firstCompleteOffset = fromOffset + cursor;
    const lines: ParsedLine[] = [];
    let truncatedLines = fromOffset > 0 ? 1 : 0;
    while (cursor < buffer.length) {
      let lineEnd = buffer.indexOf(0x0a, cursor);
      if (lineEnd < 0) {
        if (toOffset < fileSize) break;
        lineEnd = buffer.length;
      }
      const lineLength = lineEnd - cursor;
      const offset = fromOffset + cursor;
      if (lineLength > 0 && lineLength <= MAX_JSON_LINE_BYTES) {
        try {
          const value = JSON.parse(
            buffer.subarray(cursor, lineEnd).toString('utf8'),
          ) as JsonRecord;
          if (value && typeof value === 'object') lines.push({ offset, value });
        } catch {
          truncatedLines += 1;
        }
      } else if (lineLength > MAX_JSON_LINE_BYTES) {
        truncatedLines += 1;
      }
      if (lineEnd >= buffer.length) break;
      cursor = lineEnd + 1;
    }
    return {
      lines,
      fromOffset,
      toOffset,
      firstCompleteOffset,
      scannedBytes: buffer.length,
      truncatedLines,
    };
  }

  private async readDetailWindow(
    entry: LocalRecordEntry,
    toOffset: number,
    eventLimit: number,
  ): Promise<{
    window: ReadWindow;
    parsed: { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics };
  }> {
    const cacheKey = `${entry.recordId}:${toOffset}`;
    const now = Date.now();
    const cached = this.detailWindowCache.get(cacheKey);
    if (
      cached
      && cached.size === entry.size
      && cached.mtimeMs === entry.mtimeMs
      && cached.toOffset === toOffset
      && cached.expiresAt > now
      && (cached.parsedEventCount >= eventLimit || cached.terminal)
    ) {
      // Refresh insertion order so the bounded map behaves as a small LRU cache.
      this.detailWindowCache.delete(cacheKey);
      this.detailWindowCache.set(cacheKey, cached);
      return {
        window: { ...cached.result.window, lines: [] },
        parsed: cached.result.parsed,
      };
    }
    if (cached) this.detailWindowCache.delete(cacheKey);

    const inFlight = this.detailWindowInFlight.get(cacheKey);
    if (
      inFlight
      && inFlight.size === entry.size
      && inFlight.mtimeMs === entry.mtimeMs
      && inFlight.toOffset === toOffset
      // A request for a larger page must not receive a smaller in-flight parse.
      && inFlight.eventLimit >= eventLimit
    ) {
      return inFlight.promise;
    }

    const promise = this.readDetailWindowUncached(entry, toOffset, eventLimit);
    this.detailWindowInFlight.set(cacheKey, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      toOffset,
      eventLimit,
      promise,
    });
    void promise.finally(() => {
      const current = this.detailWindowInFlight.get(cacheKey);
      if (current?.promise === promise) this.detailWindowInFlight.delete(cacheKey);
    }).catch(() => undefined);
    return promise;
  }

  private async readDetailWindowUncached(
    entry: LocalRecordEntry,
    toOffset: number,
    eventLimit: number,
  ): Promise<{
    window: ReadWindow;
    parsed: { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics };
  }> {
    let requestedBytes = Math.min(
      DETAIL_INITIAL_WINDOW_BYTES,
      DETAIL_WINDOW_BYTES,
    );
    while (true) {
      const window = await this.readWindow(
        entry.path,
        Math.max(0, toOffset - requestedBytes),
        toOffset,
        entry.size,
      );
      const parsed = this.timeline(entry.recordId, window.lines);
      const reachedFileStart = window.fromOffset === 0;
      const reachedWindowLimit = requestedBytes >= DETAIL_WINDOW_BYTES;
      const cannotRecoverSemanticLines =
        window.fromOffset > 0
        && window.lines.length === 0
        && window.truncatedLines > 0;
      if (
        parsed.events.length >= eventLimit
        || reachedFileStart
        || reachedWindowLimit
        || cannotRecoverSemanticLines
      ) {
        const cacheKey = `${entry.recordId}:${toOffset}`;
        const cachedResult = {
          window: {
            fromOffset: window.fromOffset,
            toOffset: window.toOffset,
            firstCompleteOffset: window.firstCompleteOffset,
            scannedBytes: window.scannedBytes,
            truncatedLines: window.truncatedLines,
          },
          parsed,
        };
        this.detailWindowCache.delete(cacheKey);
        this.detailWindowCache.set(cacheKey, {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          toOffset,
          expiresAt: Date.now() + DETAIL_WINDOW_CACHE_MS,
          parsedEventCount: parsed.events.length,
          terminal: reachedFileStart || reachedWindowLimit || cannotRecoverSemanticLines,
          result: cachedResult,
        });
        while (this.detailWindowCache.size > MAX_DETAIL_WINDOW_CACHE_ENTRIES) {
          const oldest = this.detailWindowCache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.detailWindowCache.delete(oldest);
        }
        return { window, parsed };
      }
      requestedBytes = Math.min(DETAIL_WINDOW_BYTES, requestedBytes * 2);
    }
  }

  private async readFirstUserEvent(
    entry: LocalRecordEntry,
  ): Promise<LocalRecordTimelineEvent | undefined> {
    let requestedBytes = Math.min(SUMMARY_HEAD_BYTES, entry.size);
    while (requestedBytes > 0) {
      const window = await this.readWindow(
        entry.path,
        0,
        requestedBytes,
        entry.size,
      );
      const event = this.timeline(entry.recordId, window.lines).events.find(
        (candidate) => candidate.kind === 'user_message',
      );
      if (event) return event;
      if (window.toOffset >= entry.size || requestedBytes >= FIRST_USER_HEAD_MAX_BYTES) {
        return undefined;
      }
      requestedBytes = Math.min(FIRST_USER_HEAD_MAX_BYTES, requestedBytes * 2);
    }
    return undefined;
  }

  private timeline(
    recordIdValue: string,
    lines: ParsedLine[],
  ): { events: LocalRecordTimelineEvent[]; metrics: ParsedMetrics } {
    const records = lines.map((line) => line.value);
    const hasDirectUser = records.some((record) => payloadType(record) === 'user_message');
    const hasDirectAssistant = records.some(
      (record) => payloadType(record) === 'agent_message',
    );
    const metrics = createMetrics();
    const events: LocalRecordTimelineEvent[] = [];
    const callNames = new Map<string, string>();
    let currentTurnId: string | undefined;
    const observedTurns = new Set<string>();

    for (const line of lines) {
      const record = line.value;
      const payload = payloadOf(record);
      const type = payloadType(record);
      const timestamp = recordTimestamp(record) ?? 0;
      const explicitTurnId = turnIdFrom(record);
      if (explicitTurnId) currentTurnId = explicitTurnId;
      const turnId = explicitTurnId ?? currentTurnId;

      if (type === 'task_started') {
        if (turnId) observedTurns.add(turnId);
        metrics.turnCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'turn_start'),
          kind: 'turn_start',
          timestamp,
          turnId,
          title: 'Turn 开始',
          status: 'observed',
          sourceOffset: line.offset,
        });
        continue;
      }

      const directUser = userMessage(record);
      const fallbackUser =
        !hasDirectUser
          ? usefulUserMessage(responseMessage(record, 'user'))
          : undefined;
      const renderedUser = directUser ?? fallbackUser;
      if (renderedUser) {
        metrics.userMessageCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'user_message'),
          kind: 'user_message',
          timestamp,
          turnId,
          role: 'user',
          title: '用户指令',
          content: renderedUser,
          status: 'observed',
          sourceOffset: line.offset,
        });
        continue;
      }

      const directAssistant = assistantMessage(record);
      const fallbackAssistant =
        !hasDirectAssistant ? responseMessage(record, 'assistant') : undefined;
      const renderedAssistant = directAssistant ?? fallbackAssistant;
      if (renderedAssistant) {
        metrics.assistantMessageCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'assistant_message'),
          kind: 'assistant_message',
          timestamp,
          turnId,
          role: 'assistant',
          phase: stringValue(payload.phase),
          title: 'Agent 回复',
          content: renderedAssistant,
          status: 'observed',
          sourceOffset: line.offset,
        });
        continue;
      }

      if (
        record.type === 'response_item'
        && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(type ?? '')
      ) {
        const toolName =
          stringValue(payload.name)
          ?? (type === 'local_shell_call' ? 'local_shell' : 'tool');
        const callId =
          stringValue(payload.call_id)
          ?? stringValue(payload.id);
        if (callId) callNames.set(callId, toolName);
        const argumentsValue =
          payload.arguments
          ?? payload.input
          ?? payload.action;
        const toolArguments = parseToolArguments(argumentsValue);
        metrics.toolCallCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'tool_call'),
          kind: 'tool_call',
          timestamp,
          turnId,
          role: 'system',
          title: `调用 ${toolName}`,
          content: toolArguments.content,
          toolName,
          command: toolArguments.command,
          workdir: toolArguments.workdir,
          callId,
          status: 'observed',
          sourceOffset: line.offset,
        });
        continue;
      }

      if (record.type === 'response_item' && type === 'web_search_call') {
        const callId = stringValue(payload.id);
        const toolName = 'web_search';
        if (callId) callNames.set(callId, toolName);
        metrics.toolCallCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'tool_call'),
          kind: 'tool_call',
          timestamp,
          turnId,
          role: 'system',
          title: '调用 web_search',
          content: cleanText(JSON.stringify(payload.action ?? {}, null, 2)),
          toolName,
          callId,
          status:
            payload.status === 'completed'
              ? 'success'
              : payload.status === 'failed'
                ? 'failure'
                : 'observed',
          sourceOffset: line.offset,
        });
        continue;
      }

      if (
        record.type === 'response_item'
        && ['function_call_output', 'custom_tool_call_output'].includes(type ?? '')
      ) {
        const callId = stringValue(payload.call_id);
        const output = toolOutputText(payload.output);
        const status = toolResultStatus(output);
        metrics.toolResultCount += 1;
        if (status === 'failure') metrics.toolFailureCount += 1;
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'tool_result'),
          kind: 'tool_result',
          timestamp,
          turnId,
          role: 'system',
          title: `${callNames.get(callId ?? '') ?? '工具'}结果`,
          content: output,
          toolName: callNames.get(callId ?? ''),
          callId,
          status,
          sourceOffset: line.offset,
        });
        continue;
      }

      const usage = tokenUsageFrom(record);
      if (usage) {
        metrics.tokenUsage = usage;
        continue;
      }

      if (type === 'task_complete') {
        const durationMs = Math.max(0, finiteNumber(payload.duration_ms) ?? 0);
        const timeToFirstTokenMs = finiteNumber(payload.time_to_first_token_ms);
        metrics.completeTurnCount += 1;
        metrics.completedDurationMs += durationMs;
        if (timeToFirstTokenMs !== undefined && timeToFirstTokenMs >= 0) {
          metrics.ttftValues.push(timeToFirstTokenMs);
        }
        events.push({
          eventId: eventId(recordIdValue, line.offset, 'turn_complete'),
          kind: 'turn_complete',
          timestamp,
          turnId,
          title: 'Turn 完成',
          status: 'success',
          durationMs,
          ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
          sourceOffset: line.offset,
        });
        if (turnId) observedTurns.add(turnId);
        currentTurnId = undefined;
      }
    }
    if (metrics.turnCount === 0 && observedTurns.size > 0) {
      metrics.turnCount = observedTurns.size;
    }
    return { events, metrics };
  }
}
