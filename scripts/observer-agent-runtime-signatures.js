'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'anysentry.agent_runtime_signatures.v1';
const DEFAULT_MAX_RUNTIMES = 512;
const DEFAULT_MAX_VARIANTS = 32;
const DEFAULT_MAX_VALUES = 32;
const DEFAULT_MAX_TOTAL_VARIANTS = 4_096;
const DEFAULT_MAX_INDEX_BUCKET_CANDIDATES = 128;
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const GENERIC_LAUNCHERS = new Set([
  'bash',
  'busybox',
  'bun',
  'cmd',
  'corepack',
  'dash',
  'deno',
  'dotnet',
  'env',
  'fish',
  'java',
  'node',
  'npm',
  'npx',
  'perl',
  'php',
  'pip',
  'pip3',
  'pipx',
  'pnpm',
  'powershell',
  'python',
  'python3',
  'pwsh',
  'ruby',
  'sh',
  'ts-node',
  'tsx',
  'uv',
  'uvx',
  'yarn',
  'zsh',
]);
const MATCH_FIELDS = ['commExact', 'exeBasename', 'argv0Basename', 'argvPrefix'];
const EXACT_MATCH_FIELDS = MATCH_FIELDS.filter((field) => field !== 'argvPrefix');
const DOCUMENT_FIELDS = new Set(['schemaVersion', 'version', 'runtimes']);
const RUNTIME_FIELDS = new Set(['id', 'agentScopeId', 'displayName', 'enabled', 'variants']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

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
      { argv0Basename: ['a3s', 'a3s-code'] },
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
    id: 'langchain-service',
    agentScopeId: 'langchain',
    displayName: 'LangChain',
    variants: [
      { argvPrefix: ['python /opt/anysentry-langchain-service/service.py'] },
      { argvPrefix: ['python3 /opt/anysentry-langchain-service/service.py'] },
      { argvPrefix: ['/opt/anysentry-langchain-service/.venv/bin/python /opt/anysentry-langchain-service/service.py'] },
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

function strictString(value, field, maxLength) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${field} contains an invalid string`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new Error(`${field} contains an invalid string`);
  }
  return result;
}

function canonicalMatchValue(value, field) {
  if (field === 'exeBasename' || field === 'argv0Basename') return basename(value);
  if (field === 'argvPrefix') return normalized(value).replace(/ +/g, ' ');
  return normalized(value);
}

function values(value, field, matchField, options) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  if (value.length > options.maxValues) {
    throw new Error(`${field} exceeds ${options.maxValues} values`);
  }
  const result = [];
  for (const raw of value) {
    const item = strictString(raw, field, 256);
    const normalizedItem = canonicalMatchValue(item, matchField);
    if (!result.includes(normalizedItem)) result.push(normalizedItem);
  }
  return result;
}

function isGenericExact(value) {
  return GENERIC_LAUNCHERS.has(basename(value));
}

function compactIdentity(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, '');
}

function identityParts(value) {
  return normalized(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function containsPartSequence(haystack, needle) {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((part, index) => haystack[offset + index] === part)) return true;
  }
  return false;
}

function argvPrefixIsAgentSpecific(prefix, runtime) {
  const tokens = prefix.split(/ +/).filter(Boolean);
  const launcher = basename(tokens[0]);
  if (!GENERIC_LAUNCHERS.has(launcher)) return true;
  if (tokens.length < 2) return false;

  // A generic launcher is only safe when the registered prefix binds it to this runtime's
  // identity (for example `node /opt/new-agent/cli.js`). Merely adding `server.js`, `-c`, or
  // another generic token would still classify unrelated interpreter processes.
  const identities = [runtime.id, runtime.agentScopeId, runtime.displayName]
    .map(identityParts)
    .filter((parts) => compactIdentity(parts.join('')).length >= 2);
  const suffixParts = identityParts(tokens.slice(1).join(' '));
  return identities.some((parts) => containsPartSequence(suffixParts, parts));
}

function compileVariant(raw, runtime, index, options) {
  const runtimeId = runtime.id;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`runtime ${runtimeId} variant ${index} must be an object`);
  }
  const unknown = Object.keys(raw).filter((field) => !MATCH_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new Error(`runtime ${runtimeId} variant ${index} has unknown fields: ${unknown.join(', ')}`);
  }
  const compiled = {};
  for (const field of MATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      compiled[field] = values(raw[field], `${runtimeId}.${field}`, field, options);
    }
  }
  const fields = Object.keys(compiled);
  if (fields.length === 0) throw new Error(`runtime ${runtimeId} variant ${index} has no match fields`);

  if (compiled.argvPrefix) {
    for (const prefix of compiled.argvPrefix) {
      if (!argvPrefixIsAgentSpecific(prefix, runtime)) {
        throw new Error(
          `runtime ${runtimeId} variant ${index} argvPrefix=${prefix} is not Agent-specific`,
        );
      }
    }
  }

  // Arrays are OR alternatives while fields are AND predicates. Therefore a variant is safe only
  // when at least one entire field has no generic alternative: otherwise its Cartesian product
  // still contains an all-generic match such as comm=node + exe=node.
  const hasAlwaysSpecificField = fields.some((field) => {
    if (field === 'argvPrefix') return true; // Every prefix alternative was checked above.
    return compiled[field].every((candidate) => !isGenericExact(candidate));
  });
  if (!hasAlwaysSpecificField) {
    throw new Error(`runtime ${runtimeId} variant ${index} cannot match only generic launchers`);
  }
  return compiled;
}

function canonicalDocument(document, options = {}) {
  const maxRuntimes = boundedInt(options.maxRuntimes, DEFAULT_MAX_RUNTIMES, 1, 10_000);
  const maxVariants = boundedInt(options.maxVariants, DEFAULT_MAX_VARIANTS, 1, 256);
  const maxValues = boundedInt(options.maxValues, DEFAULT_MAX_VALUES, 1, 256);
  const maxTotalVariants = boundedInt(
    options.maxTotalVariants,
    DEFAULT_MAX_TOTAL_VARIANTS,
    1,
    65_536,
  );
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('runtime signature document must be an object');
  }
  const unknownDocumentFields = Object.keys(document).filter((field) => !DOCUMENT_FIELDS.has(field));
  if (unknownDocumentFields.length > 0) {
    throw new Error(`runtime signature document has unknown fields: ${unknownDocumentFields.join(', ')}`);
  }
  if (document.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`runtime signature document must use ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.runtimes)) throw new Error('runtime signature document runtimes must be an array');
  if (document.runtimes.length > maxRuntimes) throw new Error(`runtime signature document exceeds ${maxRuntimes} runtimes`);
  if (document.version !== undefined && (!Number.isSafeInteger(document.version) || document.version < 1)) {
    throw new Error('runtime signature document version must be a positive safe integer');
  }
  const seen = new Set();
  let totalVariants = 0;
  const runtimes = document.runtimes.map((raw, runtimeIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`runtime ${runtimeIndex} must be an object`);
    }
    const unknownRuntimeFields = Object.keys(raw).filter((field) => !RUNTIME_FIELDS.has(field));
    if (unknownRuntimeFields.length > 0) {
      throw new Error(`runtime ${runtimeIndex} has unknown fields: ${unknownRuntimeFields.join(', ')}`);
    }
    const id = normalized(strictString(raw.id, `runtime ${runtimeIndex} id`, 64));
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`runtime ${runtimeIndex} has an invalid id`);
    if (seen.has(id)) throw new Error(`runtime id ${id} is duplicated`);
    seen.add(id);
    const displayName = raw.displayName === undefined
      ? id
      : strictString(raw.displayName, `runtime ${id} displayName`, 128);
    const agentScopeId = raw.agentScopeId === undefined
      ? id
      : strictString(raw.agentScopeId, `runtime ${id} agentScopeId`, 128);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new Error(`runtime ${id} enabled must be a boolean`);
    }
    if (!Array.isArray(raw.variants) || raw.variants.length === 0 || raw.variants.length > maxVariants) {
      throw new Error(`runtime ${id} must have 1-${maxVariants} variants`);
    }
    totalVariants += raw.variants.length;
    if (totalVariants > maxTotalVariants) {
      throw new Error(`runtime signature document exceeds ${maxTotalVariants} total variants`);
    }
    const runtime = {
      id,
      agentScopeId,
      displayName,
      enabled: raw.enabled !== false,
    };
    return {
      ...runtime,
      variants: raw.variants.map((variant, index) => compileVariant(variant, runtime, index, { maxValues })),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    version: document.version ?? 1,
    runtimes,
  };
}

function signatureKey(field, value) {
  return `${field}\0${value}`;
}

function canonicalVariantKey(variant) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(variant)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, fieldValues]) => [field, [...fieldValues].sort()]),
  ));
}

function prefixBucket(prefix) {
  return basename(prefix.split(/ +/)[0]);
}

function addIndexCandidate(index, key, candidate, maxBucketCandidates) {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = [];
    index.set(key, bucket);
  }
  if (bucket.some((existing) => existing.id === candidate.id)) return;
  if (bucket.length >= maxBucketCandidates) {
    throw new Error(
      `runtime signature index bucket ${JSON.stringify(key.replace('\0', '='))} ` +
      `exceeds ${maxBucketCandidates} candidates`,
    );
  }
  bucket.push(candidate);
}

function compileIndex(runtimes, options = {}) {
  const maxBucketCandidates = boundedInt(
    options.maxIndexBucketCandidates,
    DEFAULT_MAX_INDEX_BUCKET_CANDIDATES,
    1,
    4_096,
  );
  const exactAnchors = new Map();
  const prefixAnchors = new Map();
  const candidates = [];
  const exactSingleOwners = new Map();
  const semanticOwners = new Map();
  let maxBucketSize = 0;

  for (const runtime of runtimes) {
    if (!runtime.enabled) continue;
    for (let variantIndex = 0; variantIndex < runtime.variants.length; variantIndex += 1) {
      const variant = runtime.variants[variantIndex];
      const fields = Object.keys(variant);
      const candidate = {
        id: `${runtime.id}:${variantIndex}`,
        runtime,
        variant,
        variantIndex,
      };

      const semanticKey = canonicalVariantKey(variant);
      const semanticOwner = semanticOwners.get(semanticKey);
      if (semanticOwner && semanticOwner.runtime.id !== runtime.id) {
        throw new Error(
          `runtime signature variant conflicts between ${semanticOwner.runtime.id} and ${runtime.id}`,
        );
      }
      semanticOwners.set(semanticKey, candidate);

      if (fields.length === 1 && fields[0] !== 'argvPrefix') {
        for (const value of variant[fields[0]]) {
          const key = signatureKey(fields[0], value);
          const conflict = exactSingleOwners.get(key);
          if (conflict && conflict.runtime.id !== runtime.id) {
            throw new Error(
              `runtime signature ${fields[0]}=${value} conflicts between ` +
              `${conflict.runtime.id} and ${runtime.id}`,
            );
          }
          exactSingleOwners.set(key, candidate);
        }
      }

      candidates.push(candidate);
      if (variant.argvPrefix) {
        for (const prefix of variant.argvPrefix) {
          addIndexCandidate(prefixAnchors, prefixBucket(prefix), candidate, maxBucketCandidates);
        }
      } else {
        // Every variant has at least one all-specific exact field. Index the smallest such field so
        // generic interpreter alternatives never create a hot bucket, while the predicate remains
        // mandatory and therefore cannot cause a false negative.
        const anchorField = EXACT_MATCH_FIELDS
          .filter((field) => variant[field]?.every((value) => !isGenericExact(value)))
          .sort((left, right) => (
            variant[left].length - variant[right].length ||
            EXACT_MATCH_FIELDS.indexOf(left) - EXACT_MATCH_FIELDS.indexOf(right)
          ))[0];
        for (const value of variant[anchorField]) {
          addIndexCandidate(
            exactAnchors,
            signatureKey(anchorField, value),
            candidate,
            maxBucketCandidates,
          );
        }
      }
    }
  }
  for (const bucket of [...exactAnchors.values(), ...prefixAnchors.values()]) {
    maxBucketSize = Math.max(maxBucketSize, bucket.length);
  }
  return {
    candidates,
    exactAnchors,
    prefixAnchors,
    candidateCount: candidates.length,
    bucketCount: exactAnchors.size + prefixAnchors.size,
    maxBucketSize,
  };
}

function documentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

function matcherDocument(document) {
  return document.runtimes
    .filter((runtime) => runtime.enabled)
    .map((runtime) => ({
      id: runtime.id,
      agentScopeId: runtime.agentScopeId,
      displayName: runtime.displayName,
      variants: runtime.variants,
    }));
}

function matcherHash(document) {
  return documentHash(matcherDocument(document));
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ').trim();
  return text(value);
}

function variantMatch(variant, info) {
  const argv = normalized(argvText(info?.argv)).replace(/ +/g, ' ');
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
  const customReadFile = typeof options.readFile === 'function';
  const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const statFile = options.stat || (!customReadFile ? ((file) => fs.statSync(file)) : undefined);
  const inline = text(env.ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON);
  const configuredFile = text(options.filePath || env.ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE);
  const maxFileBytes = boundedInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 16 * 1024 * 1024);
  const parse = (raw, source) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
      throw new Error('runtime signature reader must return a string or Buffer');
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    if (bytes.length > maxFileBytes) {
      throw new Error(`runtime signature document exceeds ${maxFileBytes} bytes`);
    }
    // Validate here, not only in RuntimeSignatureRegistry's constructor. observer-forward wraps
    // this loader in its startup fallback, so schema-valid JSON with unsafe rules must reach that
    // fallback instead of crashing immediately after the try/catch.
    return { document: canonicalDocument(JSON.parse(bytes.toString('utf8')), options), source };
  };
  if (inline) {
    return parse(inline, 'env:ANYSENTRY_AGENT_RUNTIME_SIGNATURES_JSON');
  }
  if (configuredFile) {
    const stat = statFile?.(configuredFile);
    if (stat && Number(stat.size) > maxFileBytes) {
      throw new Error(`runtime signature document exceeds ${maxFileBytes} bytes`);
    }
    return parse(readFile(configuredFile), configuredFile);
  }
  return { document: canonicalDocument(defaultSignatureDocument(), options), source: 'builtin' };
}

class RuntimeSignatureRegistry {
  constructor(document = defaultSignatureDocument(), options = {}) {
    this.options = options;
    this.stats = {
      configured: 0,
      loaded: 0,
      matches: 0,
      misses: 0,
      ambiguous: 0,
      ambiguousCandidates: 0,
      duplicateMatches: 0,
      candidatesEvaluated: 0,
      maxCandidatesEvaluated: 0,
      reloads: 0,
      documentChanges: 0,
      matcherChanges: 0,
      unchanged: 0,
      invalid: 0,
    };
    this.replace(document, options.source || 'builtin', true);
  }

  replace(document, source = 'memory', initial = false) {
    const next = canonicalDocument(document, this.options);
    const index = compileIndex(next.runtimes, this.options);
    const nextDocumentHash = documentHash(next);
    const nextMatcherHash = matcherHash(next);
    if (!initial && nextDocumentHash === this.documentHash) {
      this.stats.unchanged++;
      return {
        changed: false,
        matcherChanged: false,
        version: this.version,
        hash: this.hash,
        documentHash: this.documentHash,
        matcherHash: this.matcherHash,
        source: this.source,
      };
    }
    const previousMatcherHash = this.matcherHash;
    this.document = next;
    this.runtimes = next.runtimes.filter((runtime) => runtime.enabled);
    this.index = index;
    this.version = next.version;
    this.documentHash = nextDocumentHash;
    this.matcherHash = nextMatcherHash;
    this.hash = nextDocumentHash; // Backward-compatible alias used by existing heartbeat payloads.
    this.source = source;
    this.loadedAt = Date.now();
    this.stats.configured = next.runtimes.length;
    this.stats.loaded = this.runtimes.length;
    if (!initial) {
      this.stats.reloads++;
      this.stats.documentChanges++;
      if (previousMatcherHash !== this.matcherHash) this.stats.matcherChanges++;
    }
    return {
      changed: true,
      matcherChanged: initial || previousMatcherHash !== this.matcherHash,
      version: this.version,
      hash: this.hash,
      documentHash: this.documentHash,
      matcherHash: this.matcherHash,
      source: this.source,
    };
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
        documentHash: this.documentHash,
        matcherHash: this.matcherHash,
        source: this.source,
      };
    }
  }

  match(info) {
    const argv = normalized(argvText(info?.argv)).replace(/ +/g, ' ');
    const exactFacts = [
      ['commExact', normalized(info?.comm)],
      ['exeBasename', basename(info?.exe)],
      ['argv0Basename', basename(argv.split(/\s+/)[0])],
    ];
    const candidates = new Map();
    for (const [field, value] of exactFacts) {
      if (!value) continue;
      for (const candidate of this.index.exactAnchors.get(signatureKey(field, value)) || []) {
        candidates.set(candidate.id, candidate);
      }
    }
    const argv0 = basename(argv.split(/\s+/)[0]);
    for (const candidate of this.index.prefixAnchors.get(argv0) || []) {
      candidates.set(candidate.id, candidate);
    }

    this.stats.candidatesEvaluated += candidates.size;
    this.stats.maxCandidatesEvaluated = Math.max(this.stats.maxCandidatesEvaluated, candidates.size);
    const matches = [];
    for (const candidate of candidates.values()) {
      const evidence = variantMatch(candidate.variant, info);
      if (evidence) matches.push({ candidate, evidence });
    }
    if (matches.length === 0) {
      this.stats.misses++;
      return undefined;
    }

    // A scope is a display/grouping identity, not a matcher identity. Two independently
    // registered runtimes may intentionally share one scope, but an event matching both is still
    // ambiguous and must never depend on document order.
    const identities = new Set(matches.map(({ candidate }) => candidate.runtime.id));
    if (identities.size > 1) {
      this.stats.ambiguous++;
      this.stats.ambiguousCandidates += matches.length;
      return undefined;
    }
    if (matches.length > 1) this.stats.duplicateMatches++;
    matches.sort(({ candidate: left }, { candidate: right }) => (
      Object.keys(right.variant).length - Object.keys(left.variant).length ||
      left.runtime.id.localeCompare(right.runtime.id) ||
      left.variantIndex - right.variantIndex
    ));
    return this.result(matches[0].candidate, matches[0].evidence);
  }

  result(candidate, evidence) {
    this.stats.matches++;
    return {
      agentId: candidate.runtime.agentScopeId,
      displayName: candidate.runtime.displayName,
      ruleId: `${candidate.runtime.id}:${candidate.variantIndex}`,
      registryVersion: this.version,
      registryHash: this.hash,
      registryDocumentHash: this.documentHash,
      registryMatcherHash: this.matcherHash,
      evidence,
    };
  }

  metrics() {
    return {
      ...this.stats,
      version: this.version,
      hash: this.hash,
      documentHash: this.documentHash,
      matcherHash: this.matcherHash,
      source: this.source,
      loadedAt: this.loadedAt,
      indexCandidates: this.index?.candidateCount || 0,
      indexBuckets: this.index?.bucketCount || 0,
      maxIndexBucketSize: this.index?.maxBucketSize || 0,
    };
  }
}

class RuntimeSignatureReloader {
  constructor(options = {}) {
    if (!(options.registry instanceof RuntimeSignatureRegistry)) {
      throw new Error('runtime signature reloader requires a RuntimeSignatureRegistry');
    }
    this.registry = options.registry;
    if (typeof options.filePath !== 'string' || CONTROL_CHARACTERS.test(options.filePath)) {
      throw new Error('runtime signature reloader requires a valid filePath');
    }
    const configuredPath = options.filePath.trim();
    if (!configuredPath) throw new Error('runtime signature reloader requires a valid filePath');
    this.filePath = path.resolve(configuredPath);
    this.readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
    this.statFile = options.stat || ((file) => fs.statSync(file));
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
    this.lastStatFingerprint = undefined;
    this.lastObservedRawHash = undefined;
    this.lastGoodRawHash = undefined;
    this.lastFileResult = undefined;
    this.stats = {
      reloadAttempts: 0,
      reloadErrors: 0,
      reloadSuccesses: 0,
      statChecks: 0,
      statSkips: 0,
      statErrors: 0,
      readAttempts: 0,
      readErrors: 0,
      bytesRead: 0,
      rawHashSkips: 0,
      parseErrors: 0,
      registryInvalid: 0,
      callbackErrors: 0,
      errorHandlerErrors: 0,
      fileTooLarge: 0,
      watchErrors: 0,
      internalErrors: 0,
    };
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
        this.stats.watchErrors++;
        this.notifyError(error, 'watch');
      });
    } catch (error) {
      this.stats.watchErrors++;
      this.notifyError(error, 'watch');
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

  notifyError(error, kind = 'reload') {
    try {
      this.onError(error instanceof Error ? error : new Error(String(error)), kind);
    } catch {
      this.stats.errorHandlerErrors++;
    }
  }

  statFingerprint(stat) {
    if (!stat || !Number.isFinite(Number(stat.size))) return undefined;
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
      .map((value) => value == null ? '' : String(value))
      .join(':');
  }

  cachedResult(skipped) {
    const previous = this.lastFileResult || {
      ok: true,
      changed: false,
      version: this.registry.version,
      hash: this.registry.hash,
      documentHash: this.registry.documentHash,
      matcherHash: this.registry.matcherHash,
      source: this.registry.source,
    };
    return { ...previous, changed: false, skipped };
  }

  failure(metric, error, extra = {}) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.stats[metric]++;
    this.stats.reloadErrors++;
    const result = {
      ok: false,
      changed: false,
      error: normalizedError.message,
      errorKind: metric,
      version: this.registry.version,
      hash: this.registry.hash,
      documentHash: this.registry.documentHash,
      matcherHash: this.registry.matcherHash,
      source: this.registry.source,
      ...extra,
    };
    this.lastFileResult = result;
    this.notifyError(normalizedError, 'reload');
    return result;
  }

  reloadOnce(reason) {
    let stat;
    let fingerprint;
    this.stats.statChecks++;
    try {
      stat = this.statFile(this.filePath);
      fingerprint = this.statFingerprint(stat);
    } catch {
      // A stat/read race is possible with Kubernetes' atomic ConfigMap symlink rotation. Continue
      // to read and only surface an error if the read itself also fails.
      this.stats.statErrors++;
    }

    if (reason === 'poll' && fingerprint && fingerprint === this.lastStatFingerprint) {
      this.stats.statSkips++;
      return this.cachedResult('stat');
    }
    if (stat && Number(stat.size) > this.maxFileBytes) {
      this.lastStatFingerprint = fingerprint;
      return this.failure(
        'fileTooLarge',
        new Error(`runtime signature document exceeds ${this.maxFileBytes} bytes`),
        { rawBytes: Number(stat.size) },
      );
    }

    let raw;
    this.stats.readAttempts++;
    try {
      const value = this.readFile(this.filePath);
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
        throw new Error('runtime signature reader must return a string or Buffer');
      }
      raw = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    } catch (error) {
      return this.failure('readErrors', error);
    }
    this.stats.bytesRead += raw.length;
    this.lastStatFingerprint = fingerprint;
    if (raw.length > this.maxFileBytes) {
      return this.failure(
        'fileTooLarge',
        new Error(`runtime signature document exceeds ${this.maxFileBytes} bytes`),
        { rawBytes: raw.length },
      );
    }

    const rawHash = crypto.createHash('sha256').update(raw).digest('hex');
    if (rawHash === this.lastObservedRawHash) {
      this.stats.rawHashSkips++;
      return this.cachedResult('raw_hash');
    }
    this.lastObservedRawHash = rawHash;

    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return this.failure('parseErrors', error, { rawHash, rawBytes: raw.length });
    }

    const result = this.registry.replaceSafely(parsed, this.filePath);
    if (!result.ok) {
      return this.failure('registryInvalid', new Error(result.error), {
        rawHash,
        rawBytes: raw.length,
      });
    }

    this.stats.reloadSuccesses++;
    this.lastGoodRawHash = rawHash;
    let completed = { ...result, reason, rawHash, rawBytes: raw.length, callbackOk: true };
    if (result.changed) {
      try {
        const callbackResult = this.onReload(completed);
        if (callbackResult && typeof callbackResult.then === 'function') {
          completed = { ...completed, callbackPending: true };
          callbackResult.catch((error) => {
            this.stats.callbackErrors++;
            this.stats.reloadErrors++;
            this.notifyError(error, 'callback');
          });
        }
      } catch (error) {
        this.stats.callbackErrors++;
        this.stats.reloadErrors++;
        this.notifyError(error, 'callback');
        completed = {
          ...completed,
          callbackOk: false,
          callbackError: error instanceof Error ? error.message : String(error),
        };
      }
    }
    this.lastFileResult = completed;
    return completed;
  }

  reload(reason = 'manual') {
    if (this.closed) return { ok: false, changed: false, error: 'reloader is closed' };
    if (this.reloading) {
      this.queued = true;
      return { ok: true, changed: false, queued: true };
    }
    this.reloading = true;
    this.stats.reloadAttempts++;
    let result;
    try {
      result = this.reloadOnce(reason);
    } catch (error) {
      result = this.failure('internalErrors', error);
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
      ...this.stats,
      watching: Boolean(this.watcher || this.pollTimer) && !this.closed,
      filePath: this.filePath,
      lastObservedRawHash: this.lastObservedRawHash,
      lastGoodRawHash: this.lastGoodRawHash,
      documentHash: this.registry.documentHash,
      matcherHash: this.registry.matcherHash,
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
  matcherHash,
  legacyRootNameDocument,
  loadSignatureDocument,
  variantMatch,
};
