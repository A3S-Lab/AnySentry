'use strict';

const SCHEMA_VERSION = 'anysentry.pipeline_accounting.v1';

// Both dimensions are deliberately closed sets. A caller must extend this contract explicitly
// instead of accidentally turning a path, PID, status text, or server error into a metric label.
const STAGE_REASONS = Object.freeze({
  received: Object.freeze(['input']),
  parse_error: Object.freeze(['invalid_json']),
  classified: Object.freeze([
    'collector_heartbeat',
    'capture_aggregate',
    'confirmed_agent',
    'probable_agent',
    'infrastructure',
    'non_agent',
    'unknown',
  ]),
  filtered: Object.freeze([
    'deduplicated',
    'non_agent',
    'routine_noise',
    'unknown',
    'discovery_budget',
    'e2e_scope',
  ]),
  aggregated: Object.freeze(['file_access_coalesced']),
  queue_admitted: Object.freeze(['event', 'collector_heartbeat']),
  queue_dropped: Object.freeze([
    'serialization_error',
    'event_too_large',
    'outstanding_limit',
    'protected_reserve',
    'wal_pending_capacity',
    'priority_evicted',
    'queue_rejected',
    'retry_exhausted',
    'shutdown',
  ]),
  api_retained: Object.freeze(['ack']),
  api_discarded: Object.freeze(['ack', 'structural_consumed']),
  api_rejected: Object.freeze([
    'ack',
    'invalid_ack',
    'http_rejected',
    'payload_too_large',
    'shutdown',
    'retry_deadline',
  ]),
  api_retryable: Object.freeze(['ack', 'transport_error', 'http_retryable']),
});

const STAGES = Object.freeze(Object.keys(STAGE_REASONS));
const BACKLOG_FIELDS = Object.freeze([
  'queueEvents',
  'queueBytes',
  'inflightEvents',
  'inflightBytes',
  'retryEvents',
  'retryBytes',
  'outstandingEvents',
  'outstandingBytes',
]);

function nonNegativeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function unixMs(nowMs) {
  const value = Number(nowMs);
  if (!Number.isFinite(value) || value < 0) throw new TypeError('clock must return Unix milliseconds');
  return nonNegativeCount(Math.trunc(value), 'Unix milliseconds');
}

function emptyCounters() {
  return new Map(STAGES.map((stage) => [
    stage,
    new Map(STAGE_REASONS[stage].map((reason) => [reason, 0])),
  ]));
}

function serializeStages(counters) {
  return STAGES.map((stage) => {
    const reasons = STAGE_REASONS[stage].map((reason) => Object.freeze({
      reason,
      count: counters.get(stage).get(reason),
    }));
    return Object.freeze({
      stage,
      count: reasons.reduce((sum, item) => sum + item.count, 0),
      reasons: Object.freeze(reasons),
    });
  });
}

function normalizeBacklog(value = {}) {
  const backlog = {};
  for (const field of BACKLOG_FIELDS) {
    backlog[field] = nonNegativeCount(value[field] ?? 0, `backlog.${field}`);
  }
  return Object.freeze(backlog);
}

/**
 * A bounded-cardinality, delivery-transactional delta ledger for the Forwarder.
 *
 * `beginDelivery()` freezes the active delta. `failDelivery()` keeps that exact payload for a
 * byte-for-byte retry while new observations accumulate in the next active window. Only
 * `completeDelivery()` advances the sequence and releases the frozen window.
 */
class ForwarderPipelineAccounting {
  constructor({ producerInstanceId, now = Date.now } = {}) {
    if (typeof producerInstanceId !== 'string' || !producerInstanceId.trim()) {
      throw new TypeError('producerInstanceId is required');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.producerInstanceId = producerInstanceId.trim();
    this.now = now;
    this.sequence = 1;
    this.activeStartedAtUnixMs = unixMs(this.now());
    this.active = emptyCounters();
    this.pending = undefined;
    this.deliveryActive = false;
  }

  record(stage, reason, count = 1) {
    if (!Object.hasOwn(STAGE_REASONS, stage)) {
      throw new TypeError(`unsupported pipeline stage: ${stage}`);
    }
    if (!STAGE_REASONS[stage].includes(reason)) {
      throw new TypeError(`unsupported ${stage} reason: ${reason}`);
    }
    const delta = nonNegativeCount(count, `${stage}.${reason}`);
    const reasons = this.active.get(stage);
    const next = reasons.get(reason) + delta;
    reasons.set(reason, nonNegativeCount(next, `${stage}.${reason}`));
  }

  beginDelivery(backlog = {}) {
    if (this.deliveryActive) return undefined;
    if (!this.pending) {
      const endedAtUnixMs = Math.max(this.activeStartedAtUnixMs, unixMs(this.now()));
      const envelope = Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        producer: 'forwarder',
        producerInstanceId: this.producerInstanceId,
        sequence: this.sequence,
        window: Object.freeze({
          startedAtUnixMs: this.activeStartedAtUnixMs,
          endedAtUnixMs,
        }),
        temporality: 'delta',
        unit: Object.freeze({
          input: 'logical_event',
          queue: 'logical_event',
        }),
        stages: Object.freeze(serializeStages(this.active)),
        backlog: normalizeBacklog(backlog),
      });
      this.pending = envelope;
      this.active = emptyCounters();
      this.activeStartedAtUnixMs = endedAtUnixMs;
    }
    this.deliveryActive = true;
    return this.pending;
  }

  completeDelivery() {
    if (!this.deliveryActive || !this.pending) {
      throw new Error('no pipeline accounting delivery is active');
    }
    this.pending = undefined;
    this.deliveryActive = false;
    this.sequence++;
  }

  failDelivery() {
    if (!this.deliveryActive || !this.pending) {
      throw new Error('no pipeline accounting delivery is active');
    }
    // Keep the frozen payload and sequence unchanged. A retry can therefore be deduplicated even
    // when the server accepted the request but the client only observed a broken response.
    this.deliveryActive = false;
  }

  abandonPendingDelivery() {
    if (this.deliveryActive) {
      throw new Error('cannot abandon pipeline accounting while a delivery is active');
    }
    if (!this.pending) return false;
    // Shutdown has a bounded deadline. After one exact retry has also failed, advance the sequence
    // so a final lifecycle heartbeat can honestly report its newer delta. The skipped sequence is
    // observable as a coverage gap instead of silently rewriting an uncertain payload.
    this.pending = undefined;
    this.sequence++;
    return true;
  }
}

module.exports = {
  BACKLOG_FIELDS,
  ForwarderPipelineAccounting,
  SCHEMA_VERSION,
  STAGE_REASONS,
  STAGES,
};
