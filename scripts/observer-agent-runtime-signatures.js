'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'anysentry.agent_runtime_signatures.v1';
const DEFAULT_MAX_RUNTIMES = 512;
const DEFAULT_MAX_VARIANTS = 32;
const DEFAULT_MAX_VALUES = 32;
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const GENERIC_LAUNCHERS = new Set([
  'bash',
  'bun',
  'deno',
  'env',
  'java',
  'node',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'sh',
  'zsh',
]);
const MATCH_FIELDS = ['commExact', 'exeBasename', 'argv0Basename', 'argvPrefix'];

const BUILTIN_RUNTIMES = [
  {
    id: 'codex',
    displayName: 'Codex',
    variants: [
      { commExact: ['codex'] },
      { exeBasename: ['codex'] },
      { argv0Basename: ['codex'] },
    ],
  },
  {
    id: 'a3s-code',
    agentScopeId: 'a3s code',
    displayName: 'A3S Code',
    variants: [
      { commExact: ['a3s', 'a3s-code', 'a3s code'] },
      { exeBasename: ['a3s', 'a3s-code'] },
      { argvPrefix: ['a3s code', 'a3s-code'] },
    ],
  },
  {
    id: 'claude-code',
    agentScopeId: 'Claude Code',
    displayName: 'Claude Code',
    variants: [
      { commExact: ['claude', 'claude-code', 'claude code'] },
      { exeBasename: ['claude', 'claude-code'] },
      { argv0Basename: ['claude', 'claude-code'] },
    ],
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    variants: [
      { commExact: ['gemini', 'gemini-cli', 'gemini cli'] },
      { exeBasename: ['gemini', 'gemini-cli'] },
      { argv0Basename: ['gemini', 'gemini-cli'] },
    ],
  },
  {
    id: 'pi',
    displayName: 'Pi',
    variants: [
      { commExact: ['pi'] },
      { argv0Basename: ['pi'] },
    ],
  },
  {
    id: 'kimi-cli',
    displayName: 'Kimi Code CLI',
    variants: [
      { commExact: ['Kimi Code', 'kimi', 'kimi-cli'] },
      { argv0Basename: ['kimi', 'kimi-cli'] },
    ],
  },
];

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalized(value) {
  return text(value).toLowerCase();
}

function basename(value) {
  const candidate = normalized(value);
  return candidate ? path.posix.basename(candidate) : '';
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function values(value, field, options) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  if (value.length > options.maxValues) {
    throw new Error(`${field} exceeds ${options.maxValues} values`);
  }
  const result = [];
  for (const raw of value) {
    const item = text(raw);
    if (!item || item.length > 256 || item.includes('\0')) {
      throw new Error(`${field} contains an invalid value`);
    }
    const normalizedItem = normalized(item);
    if (!result.includes(normalizedItem)) result.push(normalizedItem);
  }
  return result;
}

function compileVariant(raw, runtimeId, index, options) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`runtime ${runtimeId} variant ${index} must be an object`);
  }
  const unknown = Object.keys(raw).filter((field) => !MATCH_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new Error(`runtime ${runtimeId} variant ${index} has unknown fields: ${unknown.join(', ')}`);
  }
  const compiled = {};
  for (const field of MATCH_FIELDS) {
    if (raw[field] != null) compiled[field] = values(raw[field], `${runtimeId}.${field}`, options);
  }
  const fields = Object.keys(compiled);
  if (fields.length === 0) throw new Error(`runtime ${runtimeId} variant ${index} has no match fields`);

  // A generic interpreter by itself is not an Agent identity. It may only be used when another
  // field narrows the same variant to an Agent-specific entry point.
  if (fields.length === 1 && fields[0] !== 'argvPrefix') {
    const candidates = compiled[fields[0]];
    if (candidates.some((candidate) => GENERIC_LAUNCHERS.has(basename(candidate)))) {
      throw new Error(`runtime ${runtimeId} variant ${index} cannot match a generic launcher alone`);
    }
  }
  return compiled;
}

function canonicalDocument(document, options = {}) {
  const maxRuntimes = boundedInt(options.maxRuntimes, DEFAULT_MAX_RUNTIMES, 1, 10_000);
  const maxVariants = boundedInt(options.maxVariants, DEFAULT_MAX_VARIANTS, 1, 256);
  const maxValues = boundedInt(options.maxValues, DEFAULT_MAX_VALUES, 1, 256);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('runtime signature document must be an object');
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`runtime signature document must use ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.runtimes)) throw new Error('runtime signature document runtimes must be an array');
  if (document.runtimes.length > maxRuntimes) throw new Error(`runtime signature document exceeds ${maxRuntimes} runtimes`);
  const seen = new Set();
  const runtimes = document.runtimes.map((raw, runtimeIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`runtime ${runtimeIndex} must be an object`);
    }
    const id = normalized(raw.id);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`runtime ${runtimeIndex} has an invalid id`);
    if (seen.has(id)) throw new Error(`runtime id ${id} is duplicated`);
    seen.add(id);
    const displayName = text(raw.displayName || id);
    const agentScopeId = text(raw.agentScopeId || id);
    if (!displayName || displayName.length > 128 || displayName.includes('\0')) {
      throw new Error(`runtime ${id} has an invalid displayName`);
    }
    if (!agentScopeId || agentScopeId.length > 128 || agentScopeId.includes('\0')) {
      throw new Error(`runtime ${id} has an invalid agentScopeId`);
    }
    if (!Array.isArray(raw.variants) || raw.variants.length === 0 || raw.variants.length > maxVariants) {
      throw new Error(`runtime ${id} must have 1-${maxVariants} variants`);
    }
    return {
      id,
      agentScopeId,
      displayName,
      enabled: raw.enabled !== false,
      variants: raw.variants.map((variant, index) => compileVariant(variant, id, index, { maxValues })),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    version: Math.max(1, Number.isSafeInteger(Number(document.version)) ? Number(document.version) : 1),
    runtimes,
  };
}

function signatureKey(field, value) {
  return `${field}\0${value}`;
}

function compileIndex(runtimes) {
  const exact = new Map();
  const prefixes = [];
  for (const runtime of runtimes) {
    if (!runtime.enabled) continue;
    for (let variantIndex = 0; variantIndex < runtime.variants.length; variantIndex += 1) {
      const variant = runtime.variants[variantIndex];
      const fields = Object.keys(variant);
      const candidate = { runtime, variant, variantIndex };
      if (fields.length === 1 && fields[0] !== 'argvPrefix') {
        for (const value of variant[fields[0]]) {
          const key = signatureKey(fields[0], value);
          const conflict = exact.get(key);
          if (conflict && conflict.runtime.agentScopeId !== runtime.agentScopeId) {
            throw new Error(
              `runtime signature ${fields[0]}=${value} conflicts between ` +
              `${conflict.runtime.id} and ${runtime.id}`,
            );
          }
          exact.set(key, candidate);
        }
      } else {
        prefixes.push(candidate);
      }
    }
  }
  return { exact, prefixes };
}

function documentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ').trim();
  return text(value);
}

function variantMatch(variant, info) {
  const argv = argvText(info?.argv);
  const facts = {
    commExact: normalized(info?.comm),
    exeBasename: basename(info?.exe),
    argv0Basename: basename(argv.split(/\s+/)[0]),
    argvPrefix: normalized(argv),
  };
  const evidence = [];
  for (const [field, wanted] of Object.entries(variant)) {
    const actual = facts[field];
    const matched = field === 'argvPrefix'
      ? wanted.find((candidate) => actual === candidate || actual.startsWith(`${candidate} `))
      : wanted.find((candidate) => actual === candidate);
    if (!matched) return undefined;
    evidence.push(`runtime_signature:${field}=${matched}`);
  }
  return evidence;
}

function defaultSignatureDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    runtimes: BUILTIN_RUNTIMES.map((runtime) => ({
      ...runtime,
      variants: runtime.variants.map((variant) => ({ ...variant })),
    })),
  };
}

function legacyRootNameDocument(rootNames) {
  const names = text(rootNames).split(',').map(normalized).filter(Boolean);
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    runtimes: [...new Set(names)].map((name) => ({
      id: name.replace(/\s+/g, '-'),
      agentScopeId:
        name === 'a3s' || name === 'a3s-code' || name === 'a3s code'
          ? 'a3s code'
          : name === 'claude' || name === 'claude-code' || name === 'claude code'
            ? 'Claude Code'
            : name,
      displayName: name,
      variants: [{ commExact: [name] }, { exeBasename: [name] }],
    })),
  };
}

function loadSignatureDocument(options = {}) {
  const env = options.env || process.env;
  const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const inline = text(env.ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON);
  const configuredFile = text(options.filePath || env.ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE);
  const maxFileBytes = boundedInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 16 * 1024 * 1024);
  if (inline) {
    if (Buffer.byteLength(inline) > maxFileBytes) throw new Error(`runtime signature document exceeds ${maxFileBytes} bytes`);
    return { document: JSON.parse(inline), source: 'env:ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON' };
  }
  if (configuredFile) {
    const raw = readFile(configuredFile);
    if (Buffer.byteLength(raw) > maxFileBytes) throw new Error(`runtime signature document exceeds ${maxFileBytes} bytes`);
    return { document: JSON.parse(raw), source: configuredFile };
  }
  return { document: defaultSignatureDocument(), source: 'builtin' };
}

class RuntimeSignatureRegistry {
  constructor(document = defaultSignatureDocument(), options = {}) {
    this.options = options;
    this.stats = {
      configured: 0,
      loaded: 0,
      matches: 0,
      misses: 0,
      reloads: 0,
      unchanged: 0,
      invalid: 0,
    };
    this.replace(document, options.source || 'builtin', true);
  }

  replace(document, source = 'memory', initial = false) {
    const next = canonicalDocument(document, this.options);
    const index = compileIndex(next.runtimes);
    const hash = documentHash(next);
    if (!initial && hash === this.hash) {
      this.stats.unchanged++;
      return { changed: false, version: this.version, hash: this.hash, source: this.source };
    }
    this.document = next;
    this.runtimes = next.runtimes.filter((runtime) => runtime.enabled);
    this.index = index;
    this.version = next.version;
    this.hash = hash;
    this.source = source;
    this.loadedAt = Date.now();
    this.stats.configured = next.runtimes.length;
    this.stats.loaded = this.runtimes.length;
    if (!initial) this.stats.reloads++;
    return { changed: true, version: this.version, hash: this.hash, source: this.source };
  }

  replaceSafely(document, source = 'memory') {
    try {
      return { ok: true, ...this.replace(document, source) };
    } catch (error) {
      this.stats.invalid++;
      return {
        ok: false,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
        version: this.version,
        hash: this.hash,
        source: this.source,
      };
    }
  }

  match(info) {
    const argv = argvText(info?.argv);
    const exactFacts = [
      ['commExact', normalized(info?.comm)],
      ['exeBasename', basename(info?.exe)],
      ['argv0Basename', basename(argv.split(/\s+/)[0])],
    ];
    for (const [field, value] of exactFacts) {
      if (!value) continue;
      const candidate = this.index.exact.get(signatureKey(field, value));
      if (candidate) return this.result(candidate, [`runtime_signature:${field}=${value}`]);
    }
    for (const candidate of this.index.prefixes) {
      const evidence = variantMatch(candidate.variant, info);
      if (evidence) return this.result(candidate, evidence);
    }
    this.stats.misses++;
    return undefined;
  }

  result(candidate, evidence) {
    this.stats.matches++;
    return {
      agentId: candidate.runtime.agentScopeId,
      displayName: candidate.runtime.displayName,
      ruleId: `${candidate.runtime.id}:${candidate.variantIndex}`,
      registryVersion: this.version,
      registryHash: this.hash,
      evidence,
    };
  }

  metrics() {
    return {
      ...this.stats,
      version: this.version,
      hash: this.hash,
      source: this.source,
      loadedAt: this.loadedAt,
    };
  }
}

class RuntimeSignatureReloader {
  constructor(options = {}) {
    if (!(options.registry instanceof RuntimeSignatureRegistry)) {
      throw new Error('runtime signature reloader requires a RuntimeSignatureRegistry');
    }
    this.registry = options.registry;
    this.filePath = path.resolve(text(options.filePath));
    if (!this.filePath) throw new Error('runtime signature reloader requires a filePath');
    this.readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
    this.watch = options.watch || fs.watch;
    this.onReload = typeof options.onReload === 'function' ? options.onReload : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.debounceMs = boundedInt(options.debounceMs, DEFAULT_DEBOUNCE_MS, 10, 60_000);
    this.pollMs = boundedInt(options.pollMs, DEFAULT_POLL_MS, 250, 300_000);
    this.maxFileBytes = boundedInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 16 * 1024 * 1024);
    this.timerApi = options.timerApi || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.debounceTimer = undefined;
    this.pollTimer = undefined;
    this.watcher = undefined;
    this.closed = false;
    this.reloading = false;
    this.queued = false;
    this.reloadAttempts = 0;
    this.reloadErrors = 0;
  }

  start() {
    if (this.closed || this.watcher || this.pollTimer) return false;
    const directory = path.dirname(this.filePath);
    try {
      this.watcher = this.watch(directory, { persistent: false }, () => {
        // Kubernetes ConfigMaps rotate the `..data` symlink and atomic writers rename a temporary
        // file. Accept every directory event; debounce plus canonical hash makes irrelevant events
        // cheap and prevents reload/rescan loops.
        this.schedule('watch');
      });
      this.watcher.on?.('error', (error) => {
        this.reloadErrors++;
        this.onError(error);
      });
    } catch (error) {
      this.reloadErrors++;
      this.onError(error);
    }
    this.pollTimer = this.timerApi.setInterval(() => this.schedule('poll'), this.pollMs);
    this.pollTimer?.unref?.();
    return true;
  }

  schedule(reason = 'manual') {
    if (this.closed || this.debounceTimer) return;
    this.debounceTimer = this.timerApi.setTimeout(() => {
      this.debounceTimer = undefined;
      this.reload(reason);
    }, this.debounceMs);
    this.debounceTimer?.unref?.();
  }

  reload(reason = 'manual') {
    if (this.closed) return { ok: false, changed: false, error: 'reloader is closed' };
    if (this.reloading) {
      this.queued = true;
      return { ok: true, changed: false, queued: true };
    }
    this.reloading = true;
    this.reloadAttempts++;
    let result;
    try {
      const raw = this.readFile(this.filePath);
      if (Buffer.byteLength(raw) > this.maxFileBytes) {
        throw new Error(`runtime signature document exceeds ${this.maxFileBytes} bytes`);
      }
      const parsed = JSON.parse(raw);
      result = this.registry.replaceSafely(parsed, this.filePath);
      if (!result.ok) {
        this.reloadErrors++;
        this.onError(new Error(result.error));
      } else if (result.changed) {
        this.onReload({ ...result, reason });
      }
    } catch (error) {
      this.registry.stats.invalid++;
      this.reloadErrors++;
      result = { ok: false, changed: false, error: error instanceof Error ? error.message : String(error) };
      this.onError(error);
    } finally {
      this.reloading = false;
      if (this.queued && !this.closed) {
        this.queued = false;
        this.schedule('queued');
      }
    }
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) this.timerApi.clearTimeout(this.debounceTimer);
    if (this.pollTimer) this.timerApi.clearInterval(this.pollTimer);
    this.debounceTimer = undefined;
    this.pollTimer = undefined;
    this.watcher?.close?.();
    this.watcher = undefined;
  }

  metrics() {
    return {
      watching: Boolean(this.watcher || this.pollTimer) && !this.closed,
      reloadAttempts: this.reloadAttempts,
      reloadErrors: this.reloadErrors,
      filePath: this.filePath,
    };
  }
}

module.exports = {
  BUILTIN_RUNTIMES,
  RuntimeSignatureRegistry,
  RuntimeSignatureReloader,
  SCHEMA_VERSION,
  canonicalDocument,
  defaultSignatureDocument,
  documentHash,
  legacyRootNameDocument,
  loadSignatureDocument,
  variantMatch,
};
