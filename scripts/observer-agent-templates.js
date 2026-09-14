'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'anysentry.agent_templates.v1';
const DEFAULT_MAX_TEMPLATES = 256;
const DEPLOYMENTS = new Set(['any', 'host', 'docker', 'kubernetes']);
const MATCH_FIELDS = [
  'namespace',
  'pod',
  'container',
  'image',
  'owner',
  'systemdUnit',
  'executable',
  'command',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalized(value) {
  return text(value)
    .toLowerCase()
    .replace(/^[a-z0-9._-]+:\/\//, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function globMatcher(pattern) {
  const source = text(pattern);
  if (!source) return undefined;
  const escaped = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  const expression = new RegExp(`^${escaped}$`, 'i');
  return (candidate) => expression.test(text(candidate));
}

function fieldMatcher(pattern) {
  const exact = globMatcher(pattern);
  const wanted = normalized(pattern);
  return {
    pattern: text(pattern),
    matches(candidate) {
      const value = text(candidate);
      if (!value) return false;
      return exact?.(value) || normalized(value) === wanted;
    },
  };
}

function nameScore(name, candidates) {
  const wanted = normalized(name);
  if (!wanted || wanted.length < 2) return 0;
  const wantedTokens = wanted.split(/\s+/).filter(Boolean);
  let best = 0;
  for (const candidate of candidates) {
    const value = normalized(candidate);
    if (!value) continue;
    if (value === wanted) {
      best = Math.max(best, 1);
      continue;
    }
    const candidateTokens = value.split(/\s+/).filter(Boolean);
    if (
      wantedTokens.length > 0 &&
      wantedTokens.every((token) => candidateTokens.includes(token))
    ) {
      best = Math.max(best, 0.9);
      continue;
    }
    if (
      wanted.length >= 3 &&
      (value.startsWith(`${wanted} `) ||
        value.endsWith(` ${wanted}`) ||
        value.includes(` ${wanted} `))
    ) {
      best = Math.max(best, 0.8);
      continue;
    }
    if (wanted.length >= 4 && value.includes(wanted)) best = Math.max(best, 0.65);
  }
  return best;
}

function array(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const one = text(value);
  return one ? [one] : [];
}

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object'
    ? entries[0][1]
    : {};
}

function eventFacts(observerEvent) {
  const processInfo =
    observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
  const identity =
    observerEvent?.identity && typeof observerEvent.identity === 'object'
      ? observerEvent.identity
      : {};
  const workload =
    observerEvent?.workload && typeof observerEvent.workload === 'object'
      ? observerEvent.workload
      : {};
  const payload = eventPayload(observerEvent);
  const cgroup = text(processInfo.cgroup);
  const lowerCgroup = cgroup.toLowerCase();
  const deployment = /kubepods/.test(lowerCgroup)
    ? 'kubernetes'
    : /(?:docker|libpod|containerd|crio)/.test(lowerCgroup)
      ? 'docker'
      : 'host';
  const systemdUnit =
    cgroup
      .split(/[/:]/)
      .map((item) => item.trim())
      .find((item) => /\.(?:service|scope)$/.test(item)) || '';
  const argv = Array.isArray(payload.argv)
    ? payload.argv.map(String).join(' ')
    : text(payload.argv);
  return {
    deployment,
    namespace: text(workload.namespace),
    pod: text(workload.replica_id) || text(identity.agent),
    container: text(workload.provider_unit_id) || text(identity.session),
    image: text(workload.image),
    owner: text(workload.owner),
    systemdUnit,
    executable: text(processInfo.exe) || text(processInfo.comm),
    command: argv,
    labels: workload.labels && typeof workload.labels === 'object' ? workload.labels : {},
    names: [
      identity.agent,
      identity.session,
      workload.workload_id,
      workload.deployment_id,
      workload.replica_id,
      workload.provider_unit_id,
      processInfo.comm,
      processInfo.exe ? path.posix.basename(text(processInfo.exe)) : '',
      systemdUnit,
      argv.split(/\s+/)[0],
    ].map(text).filter(Boolean),
  };
}

function metadataFacts(entry) {
  const metadata = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const deployment = DEPLOYMENTS.has(entry?.environment)
    ? entry.environment
    : entry?.source === 'docker'
      ? 'docker'
      : entry?.source === 'kubernetes'
        ? 'kubernetes'
        : 'host';
  return {
    deployment,
    namespace: text(entry?.namespace ?? metadata.namespace),
    pod: text(entry?.podName ?? metadata.pod),
    container: text(entry?.containerName ?? metadata.container),
    image: text(entry?.containerImage ?? metadata.image),
    owner: text(entry?.ownerName ?? metadata.owner),
    systemdUnit: text(entry?.systemdUnit ?? metadata.systemdUnit),
    executable: text(metadata.executable),
    command: text(metadata.command),
    labels:
      entry?.labels && typeof entry.labels === 'object'
        ? entry.labels
        : metadata.labels && typeof metadata.labels === 'object'
          ? metadata.labels
          : {},
    names: [
      entry?.agentScopeId,
      entry?.podName,
      entry?.containerName,
      entry?.containerImage,
      entry?.ownerName,
      entry?.systemdUnit,
      metadata.name,
      metadata.pod,
      metadata.container,
      metadata.image,
      metadata.owner,
      metadata.executable,
      metadata.systemdUnit,
    ].map(text).filter(Boolean),
  };
}

function compileTemplate(raw, index) {
  if (!raw || typeof raw !== 'object') return undefined;
  const deployment = text(raw.deployment || 'any').toLowerCase();
  if (!DEPLOYMENTS.has(deployment)) return undefined;
  const classification = text(raw.classification).toLowerCase() === 'non_agent'
    ? 'non_agent'
    : 'confirmed_agent';
  const agentId = text(raw.agentId || raw.agent || raw.name);
  if (classification !== 'non_agent' && !agentId) return undefined;
  const id = text(raw.id) || `${deployment}:${agentId || 'non-agent'}:${index}`;
  const match = raw.match && typeof raw.match === 'object' ? raw.match : {};
  const fields = {};
  for (const field of MATCH_FIELDS) {
    const value = match[field];
    if (value != null && text(value)) fields[field] = fieldMatcher(value);
  }
  const labels = {};
  if (match.labels && typeof match.labels === 'object') {
    for (const [key, value] of Object.entries(match.labels)) {
      if (text(key) && text(value)) labels[text(key)] = fieldMatcher(value);
    }
  }
  const name = text(raw.name);
  if (!name && Object.keys(fields).length === 0 && Object.keys(labels).length === 0) return undefined;
  return {
    id,
    agentId,
    displayName: text(raw.displayName) || agentId,
    deployment,
    classification,
    name,
    fields,
    labels,
  };
}

function loadTemplateDocument(options = {}) {
  const env = options.env || process.env;
  const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const inline = text(env.ANYSENTRY_AGENT_TEMPLATES_JSON);
  const configuredFile = text(env.ANYSENTRY_AGENT_TEMPLATES_FILE);
  let raw = inline;
  let source = inline ? 'env:ANYSENTRY_AGENT_TEMPLATES_JSON' : '';
  if (!raw && configuredFile) {
    raw = readFile(configuredFile);
    source = configuredFile;
  }
  if (!raw) return { schemaVersion: SCHEMA_VERSION, templates: [], source: 'none' };
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { schemaVersion: SCHEMA_VERSION, templates: parsed, source };
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.templates)) {
    throw new Error(`agent template document must use ${SCHEMA_VERSION}`);
  }
  return { ...parsed, source };
}

class AgentTemplateRegistry {
  constructor(document = {}, options = {}) {
    this.maxTemplates = boundedInt(options.maxTemplates, DEFAULT_MAX_TEMPLATES, 1, 10_000);
    this.templates = [];
    this.stats = {
      configured: Array.isArray(document.templates) ? document.templates.length : 0,
      loaded: 0,
      invalid: 0,
      matches: 0,
      probableMatches: 0,
      nonAgentMatches: 0,
      ambiguous: 0,
      misses: 0,
    };
    for (const [index, raw] of (document.templates ?? []).slice(0, this.maxTemplates).entries()) {
      const compiled = compileTemplate(raw, index);
      if (compiled) this.templates.push(compiled);
      else this.stats.invalid++;
    }
    if ((document.templates?.length ?? 0) > this.maxTemplates) {
      this.stats.invalid += document.templates.length - this.maxTemplates;
    }
    this.stats.loaded = this.templates.length;
    this.source = text(document.source) || 'configuration';
  }

  classifyFacts(facts) {
    const matches = [];
    for (const template of this.templates) {
      if (template.deployment !== 'any' && template.deployment !== facts.deployment) continue;
      let failed = false;
      const evidence = [`template:${template.id}`, `deployment:${facts.deployment}`];
      for (const [field, matcher] of Object.entries(template.fields)) {
        if (!matcher.matches(facts[field])) {
          failed = true;
          break;
        }
        evidence.push(`match:${field}=${matcher.pattern}`);
      }
      if (failed) continue;
      for (const [key, matcher] of Object.entries(template.labels)) {
        if (!matcher.matches(facts.labels?.[key])) {
          failed = true;
          break;
        }
        evidence.push(`match:label:${key}=${matcher.pattern}`);
      }
      if (failed) continue;
      const explicitCount =
        Object.keys(template.fields).length + Object.keys(template.labels).length;
      const fuzzyScore = template.name ? nameScore(template.name, facts.names) : 0;
      if (explicitCount === 0 && fuzzyScore === 0) continue;
      const score = explicitCount > 0 ? 1 : fuzzyScore;
      matches.push({ template, score, evidence: [...evidence, ...(template.name ? [`match:name=${template.name}`] : [])] });
    }
    if (matches.length === 0) {
      this.stats.misses++;
      return undefined;
    }
    matches.sort((a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id));
    const best = matches[0];
    const conflicting = matches.find(
      (candidate) =>
        candidate.score === best.score &&
        (candidate.template.classification !== best.template.classification ||
          candidate.template.agentId !== best.template.agentId),
    );
    if (conflicting) {
      this.stats.ambiguous++;
      return {
        state: 'unknown',
        attribution: {
          monitored: false,
          classification: 'unknown',
          confidence: 0,
          reason: 'not_evaluated',
          source: 'self_register',
          evidence: [`template_ambiguous:${best.template.id},${conflicting.template.id}`],
        },
      };
    }
    const classification =
      best.template.classification === 'non_agent'
        ? 'non_agent'
        : best.score >= 0.8
          ? 'confirmed_agent'
          : 'probable_agent';
    this.stats.matches++;
    if (classification === 'probable_agent') this.stats.probableMatches++;
    if (classification === 'non_agent') this.stats.nonAgentMatches++;
    return {
      state:
        classification === 'non_agent'
          ? 'non_agent'
          : classification === 'unknown'
            ? 'unknown'
            : 'agent',
      attribution: {
        monitored: classification === 'confirmed_agent' || classification === 'probable_agent',
        classification,
        ...(best.template.agentId ? { agentScopeId: best.template.agentId } : {}),
        ...(best.template.displayName ? { agentDisplayName: best.template.displayName } : {}),
        confidence:
          classification === 'confirmed_agent'
            ? 1
            : classification === 'probable_agent'
              ? Math.max(0.5, best.score)
              : 1,
        reason:
          classification === 'non_agent'
            ? 'not_agent'
            : classification === 'confirmed_agent'
              ? 'authoritative_anchor'
              : 'hint_only',
        source: 'self_register',
        evidence: best.evidence.slice(0, 16),
      },
      templateId: best.template.id,
    };
  }

  classifyEvent(observerEvent) {
    return this.classifyFacts(eventFacts(observerEvent));
  }

  classifyEntry(entry) {
    return this.classifyFacts(metadataFacts(entry));
  }

  metrics() {
    return { ...this.stats };
  }
}

module.exports = {
  AgentTemplateRegistry,
  SCHEMA_VERSION,
  compileTemplate,
  eventFacts,
  globMatcher,
  loadTemplateDocument,
  metadataFacts,
  nameScore,
};
