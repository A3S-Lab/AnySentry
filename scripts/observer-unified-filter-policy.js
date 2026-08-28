'use strict';

const path = require('node:path');
const {
  PROBE_NAMES,
  canonicalJson,
  digest,
  legacyActionForProbeActions,
} = require('./observer-capture-profile-control');
const { resolveClassificationSemantics } = require('./observer-classification-semantics');

const SCHEMA = 'anysentry.filter_rule_projection.v1';
const RULE_SCHEMA = 'anysentry.filter_rule.v1';
const ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop', 'not_enabled']);
const STAGES = new Set(['f0', 'f1', 'f2', 'f3']);
const FIELDS = new Set([
  'process.comm', 'process.exe_basename', 'process.argv0_basename', 'process.argv_prefix',
  'identity.classification', 'identity.source_rule', 'workload.role', 'workload.placement', 'workload.cluster',
  'workload.namespace', 'workload.owner_kind', 'workload.owner_name', 'workload.container',
  'workload.service', 'workload.systemd_unit', 'workload.label', 'asset.id', 'runtime.id',
  'runtime.state', 'binding.quality', 'signal.name',
  'event.kind', 'event.probe', 'decision.conflict', 'control.stale',
  'decision.structural_risk',
]);

function text(value, limit = 500) {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return normalized.slice(0, limit);
}

function normalized(value) {
  return text(value).toLowerCase();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validRuleHash(rule) {
  const { contentHash, ...content } = rule;
  return /^[a-f0-9]{64}$/u.test(text(contentHash)) && contentHash === digest(content);
}

function validateCondition(condition) {
  if (!object(condition) || !FIELDS.has(condition.field)) return false;
  if (!['equals', 'one_of', 'prefix', 'present'].includes(condition.operator)) return false;
  if (condition.field === 'workload.label' && !text(condition.key, 128)) return false;
  if (condition.operator === 'present') return condition.value === undefined;
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values.length > 0 && values.length <= 32 && values.every((value) =>
    typeof value === 'boolean' || (text(value) && !/[?*\[\]{}()|^$\\]/u.test(text(value))));
}

function validateRule(value) {
  const rule = object(value);
  if (
    !rule
    || rule.schemaVersion !== RULE_SCHEMA
    || !text(rule.ruleId, 240)
    || !positiveInteger(rule.revision)
    || !text(rule.name, 240)
    || !object(rule.matcher)
    || !text(rule.matcher.description, 1_000)
    || !object(rule.effect)
    || !Array.isArray(rule.consumerCapabilities)
    || rule.consumerCapabilities.some((stage) => !STAGES.has(stage))
    || !validRuleHash(rule)
  ) return undefined;
  const conditions = [...(Array.isArray(rule.matcher.all) ? rule.matcher.all : []), ...(Array.isArray(rule.matcher.any) ? rule.matcher.any : [])];
  if (conditions.length > 32 || conditions.some((condition) => !validateCondition(condition))) return undefined;
  return structuredClone(rule);
}

function validateProfileActions(value) {
  const input = object(value);
  if (!input || Object.keys(input).length !== PROBE_NAMES.length) return undefined;
  const actions = {};
  for (const probe of PROBE_NAMES) {
    if (!ACTIONS.has(input[probe])) return undefined;
    actions[probe] = input[probe];
  }
  if (actions.exec !== 'full' || actions.exit !== 'full' || actions.security !== 'full') return undefined;
  return actions;
}

function projectionIntentDigest(snapshot) {
  return digest({
    schemaVersion: snapshot.schemaVersion,
    domainVersions: {
      identity: snapshot.domainVersions.identity,
      capture: snapshot.domainVersions.capture,
      forwarder: snapshot.domainVersions.forwarder,
    },
    runtimeSignatures: snapshot.runtimeSignatures,
    agentTemplates: snapshot.agentTemplates,
    identityRules: snapshot.identityRules,
    captureProfiles: snapshot.captureProfiles,
    captureProfileRules: snapshot.captureProfileRules,
    signalEnablementRules: snapshot.signalEnablementRules ?? [],
    semanticRetentionRules: snapshot.semanticRetentionRules,
    safetyGuardrails: snapshot.safetyGuardrails,
    forwarderSettings: snapshot.forwarderSettings,
  });
}

function eventKind(observerEvent) {
  const event = object(observerEvent?.event) ?? {};
  return Object.keys(event)[0] || '';
}

function eventPayload(observerEvent) {
  const event = object(observerEvent?.event) ?? {};
  return object(event[eventKind(observerEvent)]) ?? {};
}

function eventProbe(kind, payload = {}) {
  if (kind === 'ToolExec') return 'exec';
  if (kind === 'ProcessExit') return 'exit';
  if (kind === 'FileAccess') return payload.accessMode === 'read_only' ? 'file_read' : 'file_access';
  if (kind === 'FileDelete') return 'file_delete';
  if (kind === 'Dns') return 'dns';
  if (kind === 'Egress') return 'connect';
  if (kind === 'SslContent') return 'ssl';
  if (kind === 'LlmCall' || kind === 'LlmInteraction' || kind === 'AgentTool' || kind === 'AgentInvocation') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  return '';
}

function evaluationContext(observerEvent, classification, options = {}) {
  const semantics = resolveClassificationSemantics(classification, observerEvent);
  const processInfo = object(observerEvent?.process) ?? {};
  const payload = eventPayload(observerEvent);
  const attribution = object(classification?.attribution) ?? {};
  const facts = object(classification?.infrastructureFacts) ?? {};
  const workloadRef = object(attribution.workloadRef) ?? {};
  const labels = object(facts.labels) ?? {};
  const sourceRule = (Array.isArray(attribution.evidence) ? attribution.evidence : [])
    .map((item) => /^filter_rule:([^:]+)(?::r\d+)?$/u.exec(text(item))?.[1] || '')
    .find(Boolean) || '';
  const argv = Array.isArray(payload.argv) ? payload.argv.map(text).filter(Boolean) : [];
  return {
    process: {
      comm: text(processInfo.comm),
      exe: text(processInfo.exe),
      argv,
    },
    identityClassification: semantics.identityClassification,
    identitySourceRule: sourceRule,
    workloadRole: semantics.workloadRole,
    workload: {
      placement: text(facts.placement || workloadRef.environment),
      cluster: text(facts.clusterId),
      namespace: text(facts.namespace || workloadRef.namespace),
      ownerKind: text(facts.ownerKind || workloadRef.ownerKind),
      ownerName: text(facts.ownerName || workloadRef.ownerName),
      container: text(facts.containerName || workloadRef.containerName),
      service: text(facts.serviceName || workloadRef.name),
      systemdUnit: text(facts.systemdUnit || workloadRef.systemdUnit),
      labels,
    },
    assetId: text(options.assetId || classification?.subjectAssetId),
    runtimeId: text(attribution.agentInstanceId),
    runtimeState: text(options.runtimeState),
    bindingQuality: text(options.bindingQuality),
    signalName: eventProbe(eventKind(observerEvent), payload) === 'file_read' ? 'file_open_read' : '',
    eventKind: eventKind(observerEvent),
    probe: eventProbe(eventKind(observerEvent), payload),
    conflict: classification?.workspaceConflict === true || attribution.conflict === true,
    structuralRisk: options.structuralRisk === true,
    stale: options.stale === true,
  };
}

function contextValue(condition, context) {
  switch (condition.field) {
    case 'process.comm': return context.process.comm;
    case 'process.exe_basename': return context.process.exe ? path.posix.basename(context.process.exe) : '';
    case 'process.argv0_basename': return context.process.argv[0] ? path.posix.basename(context.process.argv[0]) : '';
    case 'process.argv_prefix': return context.process.argv.join(' ');
    case 'identity.classification': return context.identityClassification;
    case 'identity.source_rule': return context.identitySourceRule;
    case 'workload.role': return context.workloadRole;
    case 'workload.placement': return context.workload.placement;
    case 'workload.cluster': return context.workload.cluster;
    case 'workload.namespace': return context.workload.namespace;
    case 'workload.owner_kind': return context.workload.ownerKind;
    case 'workload.owner_name': return context.workload.ownerName;
    case 'workload.container': return context.workload.container;
    case 'workload.service': return context.workload.service;
    case 'workload.systemd_unit': return context.workload.systemdUnit;
    case 'workload.label': return condition.key ? context.workload.labels[condition.key] : '';
    case 'asset.id': return context.assetId;
    case 'runtime.id': return context.runtimeId;
    case 'runtime.state': return context.runtimeState;
    case 'binding.quality': return context.bindingQuality;
    case 'signal.name': return context.signalName;
    case 'event.kind': return context.eventKind;
    case 'event.probe': return context.probe;
    case 'decision.conflict': return context.conflict;
    case 'decision.structural_risk': return context.structuralRisk;
    case 'control.stale': return context.stale;
    default: return '';
  }
}

function conditionMatches(condition, context) {
  const actual = contextValue(condition, context);
  if (condition.operator === 'present') return actual !== undefined && text(actual) !== '';
  if (typeof condition.value === 'boolean') return actual === condition.value;
  const expected = (Array.isArray(condition.value) ? condition.value : [condition.value]).map(normalized);
  const value = normalized(actual);
  if (condition.operator === 'equals' || condition.operator === 'one_of') return expected.includes(value);
  if (condition.operator === 'prefix') return expected.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
  return false;
}

function ruleMatches(rule, context) {
  const all = Array.isArray(rule.matcher.all) ? rule.matcher.all : [];
  const any = Array.isArray(rule.matcher.any) ? rule.matcher.any : [];
  return all.every((condition) => conditionMatches(condition, context))
    && (!any.length || any.some((condition) => conditionMatches(condition, context)));
}

function indexKey(field, value, labelKey = '') {
  return `${field}\u0000${labelKey}\u0000${normalized(value)}`;
}

function conditionIndexKeys(condition) {
  if (condition.operator !== 'equals' && condition.operator !== 'one_of') return [];
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values
    .filter((value) => value !== undefined && text(value))
    .map((value) => indexKey(condition.field, value, condition.key));
}

function ruleIndexKeys(rule) {
  const allAnchors = (Array.isArray(rule.matcher.all) ? rule.matcher.all : [])
    .map(conditionIndexKeys)
    .filter((keys) => keys.length)
    .sort((left, right) => left.length - right.length);
  if (allAnchors.length) return allAnchors[0];
  const any = Array.isArray(rule.matcher.any) ? rule.matcher.any : [];
  if (!any.length) return [];
  const anyAnchors = any.map(conditionIndexKeys);
  return anyAnchors.every((keys) => keys.length) ? [...new Set(anyAnchors.flat())] : [];
}

function buildRuleIndex(rules) {
  const buckets = new Map();
  const fallbackRuleIds = new Set();
  let maxBucketSize = 0;
  for (const rule of rules) {
    const keys = ruleIndexKeys(rule);
    if (!keys.length) {
      fallbackRuleIds.add(rule.ruleId);
      continue;
    }
    for (const key of keys) {
      const bucket = buckets.get(key) || new Set();
      bucket.add(rule.ruleId);
      buckets.set(key, bucket);
      maxBucketSize = Math.max(maxBucketSize, bucket.size);
    }
  }
  return { rules, buckets, fallbackRuleIds, bucketCount: buckets.size, maxBucketSize };
}

function contextIndexKeys(context) {
  const pairs = [
    ['process.comm', context.process.comm],
    ['process.exe_basename', context.process.exe ? path.posix.basename(context.process.exe) : ''],
    ['process.argv0_basename', context.process.argv[0] ? path.posix.basename(context.process.argv[0]) : ''],
    ['process.argv_prefix', context.process.argv.join(' ')],
    ['identity.classification', context.identityClassification],
    ['identity.source_rule', context.identitySourceRule],
    ['workload.role', context.workloadRole],
    ['workload.placement', context.workload.placement],
    ['workload.cluster', context.workload.cluster],
    ['workload.namespace', context.workload.namespace],
    ['workload.owner_kind', context.workload.ownerKind],
    ['workload.owner_name', context.workload.ownerName],
    ['workload.container', context.workload.container],
    ['workload.service', context.workload.service],
    ['workload.systemd_unit', context.workload.systemdUnit],
    ['asset.id', context.assetId],
    ['runtime.id', context.runtimeId],
    ['event.kind', context.eventKind],
    ['event.probe', context.probe],
    ['decision.conflict', context.conflict === true],
    ['decision.structural_risk', context.structuralRisk === true],
    ['control.stale', context.stale === true],
  ];
  const keys = pairs.filter(([, value]) => value !== undefined && text(value)).map(([field, value]) => indexKey(field, value));
  for (const [key, value] of Object.entries(context.workload.labels || {})) {
    if (text(value)) keys.push(indexKey('workload.label', value, key));
  }
  return [...new Set(keys)];
}

function indexedCandidates(index, context) {
  const candidateIds = new Set(index.fallbackRuleIds);
  for (const key of contextIndexKeys(context)) {
    for (const ruleId of index.buckets.get(key) || []) candidateIds.add(ruleId);
  }
  return index.rules.filter((rule) => candidateIds.has(rule.ruleId));
}

function ruleIsActive(rule, now) {
  if (rule.lifecycleStage !== 'enforced') return false;
  if (rule.effect.type !== 'investigation') return true;
  const expiresAt = Date.parse(text(rule.effect.expiresAt, 80));
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function selectRule(index, context, now) {
  const rules = indexedCandidates(index, context);
  return rules
    .filter((rule) => ruleIsActive(rule, now) && ruleMatches(rule, context))
    .sort((left, right) => Number(right.priority) - Number(left.priority) || left.ruleId.localeCompare(right.ruleId))[0];
}

function decisionReceipt(stage, rule, catalogVersion, domainVersion, now) {
  const winner = {
    ruleId: rule.ruleId,
    revision: rule.revision,
    name: rule.name,
    category: rule.category,
    ruleKind: rule.ruleKind,
    matched: true,
    failedConditions: [],
    priority: Number(rule.priority),
    effect: structuredClone(rule.effect),
    selected: true,
  };
  return {
    schemaVersion: 'anysentry.filter_rule_decision_receipt.v1',
    stage,
    catalogVersion,
    domainVersion,
    evaluatedAt: new Date(now).toISOString(),
    candidates: [winner],
    winner,
    outcome: structuredClone(rule.effect),
    reason: `filter_rule:${rule.ruleId}:r${rule.revision}`,
    failOpen: false,
  };
}

function identityClassificationState(classification) {
  if (classification === 'confirmed_agent' || classification === 'probable_agent') return 'agent';
  if (classification === 'non_agent') return 'non_agent';
  return 'unknown';
}

class UnifiedFilterPolicyRegistry {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.ready = false;
    this.catalogVersion = 0;
    this.domainVersions = { identity: 0, capture: 0, forwarder: 0, retention: 0 };
    this.generatedAt = 0;
    this.expiresAt = 0;
    this.contentHash = '';
    this.intentHash = '';
    this.runtimeSignatures = { schemaVersion: 'anysentry.agent_runtime_signatures.v1', version: 1, runtimes: [] };
    this.agentTemplates = { schemaVersion: 'anysentry.agent_templates.v1', version: 1, templates: [] };
    this.identityRules = [];
    this.captureProfiles = {};
    this.captureProfileRules = [];
    this.signalEnablementRules = [];
    this.semanticRetentionRules = [];
    this.safetyGuardrails = [];
    this.identityRuleIndex = buildRuleIndex([]);
    this.captureRuleIndex = buildRuleIndex([]);
    this.semanticRuleIndex = buildRuleIndex([]);
    this.forwarderSettings = {
      filterMode: 'enforce', retainUnknown: true, retainNonAgent: false,
      noisePolicy: 'balanced', fileAggregationEnabled: true, fileAggregationWindowMs: 100,
    };
    this.sampleState = new Map();
    this.maxSampleKeys = 4_096;
    this.stats = {
      loads: 0, loadErrors: 0, unchanged: 0, identityMatches: 0, captureMatches: 0,
      semanticMatches: 0, sampleSuppressed: 0, degraded: 0,
    };
    this.lastError = '';
  }

  replace(value) {
    try {
      const snapshot = object(value);
      if (!snapshot || snapshot.schemaVersion !== SCHEMA) throw new Error(`projection must use ${SCHEMA}`);
      const catalogVersion = positiveInteger(snapshot.catalogVersion);
      if (!catalogVersion) throw new Error('projection catalogVersion must be positive');
      const generatedAt = Date.parse(text(snapshot.generatedAt, 80));
      const expiresAt = Date.parse(text(snapshot.expiresAt, 80));
      if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        throw new Error('projection timestamps are missing or expired');
      }
      const { contentHash, ...content } = snapshot;
      if (!/^[a-f0-9]{64}$/u.test(text(contentHash)) || contentHash !== digest(content)) {
        throw new Error('projection contentHash mismatch');
      }
      const versions = object(snapshot.domainVersions);
      if (!versions || ['identity', 'capture', 'forwarder', 'retention'].some((key) => !positiveInteger(versions[key]))) {
        throw new Error('projection domain versions are invalid');
      }
      const arrays = ['identityRules', 'captureProfileRules', 'semanticRetentionRules', 'persistenceRetentionRules', 'safetyGuardrails'];
      const parsed = {};
      for (const field of arrays) {
        if (!Array.isArray(snapshot[field]) || snapshot[field].length > 2_000) throw new Error(`projection ${field} is invalid`);
        parsed[field] = snapshot[field].map(validateRule);
        if (parsed[field].some((rule) => !rule)) throw new Error(`projection ${field} contains an invalid rule`);
      }
      const signalEnablementInput = snapshot.signalEnablementRules ?? [];
      if (!Array.isArray(signalEnablementInput) || signalEnablementInput.length > 2_000) {
        throw new Error('projection signalEnablementRules is invalid');
      }
      parsed.signalEnablementRules = signalEnablementInput.map(validateRule);
      if (parsed.signalEnablementRules.some((rule) => !rule)) {
        throw new Error('projection signalEnablementRules contains an invalid rule');
      }
      const profiles = object(snapshot.captureProfiles);
      if (!profiles) throw new Error('projection captureProfiles is invalid');
      const captureProfiles = {};
      for (const [profile, actions] of Object.entries(profiles)) {
        const normalizedActions = validateProfileActions(actions);
        if (!normalizedActions) throw new Error(`projection profile ${profile} is invalid`);
        captureProfiles[profile] = normalizedActions;
      }
      const signatures = object(snapshot.runtimeSignatures);
      if (!signatures || signatures.schemaVersion !== 'anysentry.agent_runtime_signatures.v1' || !Array.isArray(signatures.runtimes)) {
        throw new Error('projection runtime signatures are invalid');
      }
      const templates = object(snapshot.agentTemplates);
      if (!templates || templates.schemaVersion !== 'anysentry.agent_templates.v1' || !Array.isArray(templates.templates)) {
        throw new Error('projection Agent templates are invalid');
      }
      const settings = object(snapshot.forwarderSettings);
      if (
        !settings
        || settings.filterMode !== 'enforce'
        || settings.retainUnknown !== true
        || settings.retainNonAgent !== false
        || settings.noisePolicy !== 'balanced'
        || typeof settings.fileAggregationEnabled !== 'boolean'
      ) throw new Error('projection Forwarder settings are invalid');
      const intentHash = projectionIntentDigest(snapshot);
      if (snapshot.intentHash !== undefined && (
        !/^[a-f0-9]{64}$/u.test(text(snapshot.intentHash))
        || text(snapshot.intentHash) !== intentHash
      )) throw new Error('projection intentHash mismatch');
      if (catalogVersion < this.catalogVersion) throw new Error('projection catalogVersion regressed');
      if (intentHash === this.intentHash) {
        this.catalogVersion = catalogVersion;
        this.domainVersions = {
          identity: Number(versions.identity), capture: Number(versions.capture),
          forwarder: Number(versions.forwarder), retention: Number(versions.retention),
        };
        this.generatedAt = generatedAt;
        this.expiresAt = expiresAt;
        this.contentHash = contentHash;
        this.stats.unchanged++;
        this.ready = true;
        return { ok: true, changed: false, catalogVersion, contentHash, intentHash };
      }
      this.catalogVersion = catalogVersion;
      this.domainVersions = {
        identity: Number(versions.identity), capture: Number(versions.capture),
        forwarder: Number(versions.forwarder), retention: Number(versions.retention),
      };
      this.generatedAt = generatedAt;
      this.expiresAt = expiresAt;
      this.contentHash = contentHash;
      this.intentHash = intentHash;
      this.runtimeSignatures = {
        schemaVersion: signatures.schemaVersion,
        version: Number(signatures.version),
        runtimes: signatures.runtimes.map((runtime) => ({
          id: text(runtime.id, 128),
          ...(text(runtime.agentScopeId, 128) ? { agentScopeId: text(runtime.agentScopeId, 128) } : {}),
          displayName: text(runtime.displayName, 240),
          enabled: runtime.enabled !== false,
          variants: structuredClone(runtime.variants),
        })),
      };
      this.agentTemplates = {
        schemaVersion: templates.schemaVersion,
        version: Number(templates.version),
        templates: templates.templates.map((template) => ({
          id: text(template.id, 128),
          ...(text(template.agentId, 128) ? { agentId: text(template.agentId, 128) } : {}),
          ...(text(template.displayName, 240) ? { displayName: text(template.displayName, 240) } : {}),
          deployment: template.deployment,
          classification: template.classification,
          match: structuredClone(template.match),
        })),
      };
      this.identityRules = parsed.identityRules;
      this.captureProfiles = captureProfiles;
      this.captureProfileRules = parsed.captureProfileRules;
      this.signalEnablementRules = parsed.signalEnablementRules;
      this.semanticRetentionRules = parsed.semanticRetentionRules;
      this.safetyGuardrails = parsed.safetyGuardrails;
      this.identityRuleIndex = buildRuleIndex(this.identityRules);
      this.captureRuleIndex = buildRuleIndex(this.captureProfileRules);
      this.semanticRuleIndex = buildRuleIndex([
        ...this.safetyGuardrails.filter((rule) => rule.consumerCapabilities.includes('f2')),
        ...this.semanticRetentionRules,
      ]);
      this.forwarderSettings = {
        filterMode: settings.filterMode,
        retainUnknown: settings.retainUnknown,
        retainNonAgent: settings.retainNonAgent,
        noisePolicy: settings.noisePolicy,
        fileAggregationEnabled: settings.fileAggregationEnabled,
        fileAggregationWindowMs: Math.max(10, Math.min(5_000, Number(settings.fileAggregationWindowMs) || 100)),
      };
      this.ready = true;
      this.lastError = '';
      this.stats.loads++;
      return { ok: true, changed: true, catalogVersion, contentHash, intentHash };
    } catch (error) {
      this.stats.loadErrors++;
      this.lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, changed: false, error: this.lastError };
    }
  }

  degrade(reason) {
    this.stats.degraded++;
    this.lastError = text(reason, 500) || 'control plane unavailable';
  }

  active() {
    return this.ready && this.expiresAt > this.now();
  }

  runtimeSignatureDocument() {
    return structuredClone(this.runtimeSignatures);
  }

  agentTemplateDocument() {
    return structuredClone(this.agentTemplates);
  }

  settings() {
    return { ...this.forwarderSettings };
  }

  profileActions(profile) {
    return structuredClone(this.captureProfiles[profile]);
  }

  identityCandidates(observerEvent, classification) {
    if (!this.active()) return [];
    const context = evaluationContext(observerEvent, classification);
    const matched = indexedCandidates(this.identityRuleIndex, context)
      .filter((rule) => rule.consumerCapabilities.includes('f0') && ruleIsActive(rule, this.now()) && ruleMatches(rule, context))
      .sort((left, right) => Number(right.priority) - Number(left.priority));
    const candidates = [];
    const identity = matched.find((rule) => rule.effect.type === 'emit_identity');
    if (identity) {
      const effect = identity.effect;
      candidates.push({
        ruleId: identity.ruleId,
        state: identityClassificationState(effect.classification),
        ...(effect.captureProfile ? { captureProfile: effect.captureProfile } : {}),
        attribution: {
          monitored: effect.classification === 'confirmed_agent' || effect.classification === 'probable_agent',
          classification: effect.classification,
          confidence: Number(effect.confidence),
          reason: effect.classification === 'confirmed_agent' ? 'authoritative_anchor' : effect.classification === 'non_agent' ? 'not_agent' : 'hint_only',
          source: effect.classification === 'non_agent' ? 'filter_rule' : 'self_register',
          evidence: [`filter_rule:${identity.ruleId}:r${identity.revision}`],
        },
        decisionReceipt: decisionReceipt('f0', identity, this.catalogVersion, this.domainVersions.identity, this.now()),
      });
      this.stats.identityMatches++;
    }
    const role = matched.find((rule) => rule.effect.type === 'assign_role');
    if (role) {
      candidates.push({
        state: classification?.state || 'unknown',
        workloadRole: role.effect.role,
        ...(role.effect.captureProfile ? { captureProfile: role.effect.captureProfile } : {}),
        attribution: {
          ...(object(classification?.attribution) ?? { monitored: false, confidence: 0, reason: 'not_evaluated', source: 'none' }),
          workloadRole: role.effect.role,
          evidence: [
            ...(Array.isArray(classification?.attribution?.evidence) ? classification.attribution.evidence : []),
            `filter_rule:${role.ruleId}:r${role.revision}`,
          ].slice(0, 16),
        },
        decisionReceipt: decisionReceipt('f0', role, this.catalogVersion, this.domainVersions.identity, this.now()),
      });
      this.stats.identityMatches++;
    }
    return candidates;
  }

  captureDecision(observerEvent, classification) {
    if (!this.active()) return undefined;
    const context = evaluationContext(observerEvent, classification);
    const rule = selectRule(this.captureRuleIndex, context, this.now());
    if (!rule) return undefined;
    const effect = rule.effect;
    const profile = effect.type === 'assign_capture_profile'
      ? effect.captureProfile
      : effect.type === 'investigation' ? effect.captureProfile : '';
    const probeActions = effect.type === 'assign_capture_profile'
      ? effect.probeActions
      : this.captureProfiles[profile];
    if (!profile || !probeActions) return undefined;
    this.stats.captureMatches++;
    return {
      classification: context.identityClassification,
      authority: rule.authority === 'immutable' || rule.authority === 'authoritative' ? 'authoritative' : 'candidate',
      action: legacyActionForProbeActions(probeActions),
      reasonCode: `filter_rule:${rule.ruleId}:r${rule.revision}`,
      source: 'unified_filter_rule',
      captureProfile: profile,
      desiredProbeActions: structuredClone(probeActions),
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      policyVersion: this.catalogVersion,
      expiresAt: new Date(this.expiresAt).toISOString(),
      decisionReceipt: decisionReceipt('f1', rule, this.catalogVersion, this.domainVersions.capture, this.now()),
    };
  }

  semanticDecision(observerEvent, classification) {
    if (!this.active()) return undefined;
    const context = evaluationContext(observerEvent, classification);
    const rule = selectRule(this.semanticRuleIndex, context, this.now());
    if (!rule) return undefined;
    let action;
    let reasonCode;
    if (rule.effect.type === 'protect') {
      action = rule.effect.forwarderAction;
      reasonCode = rule.effect.reasonCode;
    } else if (rule.effect.type === 'semantic_retention') {
      action = rule.effect.action;
      reasonCode = rule.effect.reasonCode;
    } else return undefined;
    this.stats.semanticMatches++;
    return {
      action,
      reasonCode,
      ruleId: rule.ruleId,
      ruleRevision: rule.revision,
      catalogVersion: this.catalogVersion,
      domainVersion: this.domainVersions.forwarder,
      decisionReceipt: decisionReceipt('f2', rule, this.catalogVersion, this.domainVersions.forwarder, this.now()),
    };
  }

  shouldKeepSample(key, limit = 20, windowMs = 1_000) {
    const now = this.now();
    const normalizedKey = text(key, 500);
    if (!normalizedKey) return true;
    let state = this.sampleState.get(normalizedKey);
    if (!state || now - state.startedAt >= windowMs) {
      state = { startedAt: now, count: 0 };
      this.sampleState.set(normalizedKey, state);
    }
    state.count++;
    while (this.sampleState.size > this.maxSampleKeys) this.sampleState.delete(this.sampleState.keys().next().value);
    const keep = state.count <= limit;
    if (!keep) this.stats.sampleSuppressed++;
    return keep;
  }

  metrics() {
    return {
      ...this.stats,
      ready: this.ready,
      active: this.active(),
      catalogVersion: this.catalogVersion,
      domainVersions: { ...this.domainVersions },
      contentHash: this.contentHash,
      intentHash: this.intentHash,
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : undefined,
      state: this.active() ? 'ready' : this.ready ? 'degraded' : 'bootstrap',
      lastError: this.lastError,
      runtimeSignatures: this.runtimeSignatures.runtimes.length,
      agentTemplates: this.agentTemplates.templates.length,
      identityRules: this.identityRules.length,
      captureProfileRules: this.captureProfileRules.length,
      semanticRetentionRules: this.semanticRetentionRules.length,
      identityIndexBuckets: this.identityRuleIndex.bucketCount,
      captureIndexBuckets: this.captureRuleIndex.bucketCount,
      semanticIndexBuckets: this.semanticRuleIndex.bucketCount,
      maxIndexBucketSize: Math.max(
        this.identityRuleIndex.maxBucketSize,
        this.captureRuleIndex.maxBucketSize,
        this.semanticRuleIndex.maxBucketSize,
      ),
      sampleKeys: this.sampleState.size,
    };
  }
}

module.exports = {
  SCHEMA,
  UnifiedFilterPolicyRegistry,
  evaluationContext,
  buildRuleIndex,
  indexedCandidates,
  projectionIntentDigest,
  ruleMatches,
};
