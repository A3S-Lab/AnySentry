#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const types = require(path.join(
  root,
  "apps/api/dist/security-monitoring/interaction.types.js",
));
const interactionService = require(path.join(
  root,
  "apps/api/dist/security-monitoring/interaction.service.js",
));
const forwarder = require(path.join(root, "scripts/observer-interaction-forwarder.js"));

const valid = {
  schemaVersion: "anysentry.interaction-metadata.v1",
  eventType: "LlmTransportObserved",
  sourceEventId: "source-event-1",
  collectorId: "collector-1",
  observedAt: 1787800000000,
  agentInstanceId: "agent-instance-1",
  process: {
    hostId: "host-1",
    bootId: "boot-1",
    pid: 4242,
    startTimeTicks: "9001",
    comm: "node",
  },
  transport: {
    sni: "api.openai.com",
    provider: "OpenAi",
    peer: "203.0.113.10",
    protocol: "unknown",
    requestBytes: 1024,
    responseBytes: 4096,
    timingScope: "connection",
    latencyAvailability: "available",
    latencyMs: 240,
    ttftAvailability: "unavailable",
  },
  capture: {
    captureMethod: "ebpf_transport",
    captureMode: "metadata",
    captureCompleteness: "unavailable",
    parseStatus: "not_attempted",
    rawRetentionState: "not_retained",
    presentationState: "metadata_only",
  },
};

assert.deepEqual(
  JSON.parse(JSON.stringify(types.validateInteractionMetadataIngest(valid))),
  valid,
);
for (const forbidden of [
  { prompt: "secret" },
  { query: "secret" },
  { contentHmac: "secret" },
  { messages: [] },
  { requestBody: "{}" },
]) {
  assert.throws(
    () => types.validateInteractionMetadataIngest({ ...valid, ...forbidden }),
    /forbidden|not part/u,
  );
}
assert.throws(
  () =>
    types.validateInteractionMetadataIngest({
      ...valid,
      transport: {
        ...valid.transport,
        timingScope: "unavailable",
        latencyAvailability: "unavailable",
        latencyMs: 10,
      },
    }),
  /unavailable/u,
);

const first = types.interactionRecord(valid, { sourceId: "source-1" }, 100);
const replay = types.interactionRecord(valid, { sourceId: "source-1" }, 200);
assert.equal(first.interactionId, replay.interactionId);
assert.equal(first.conversationId, replay.conversationId);
assert.equal(first.processInstanceId, replay.processInstanceId);
assert.equal(
  types.interactionPayloadFingerprint(first),
  types.interactionPayloadFingerprint(replay),
);
assert.notEqual(
  types.interactionPayloadFingerprint(first),
  types.interactionPayloadFingerprint({
    ...first,
    transport: { ...first.transport, requestBytes: 1025 },
  }),
);
assert.equal(types.summarizeInteractionRecords([first, replay])[0].transportObservations, 1);
assert.throws(
  () => types.deduplicateInteractionRecords([
    first,
    {
      ...replay,
      transport: { ...replay.transport, requestBytes: 1025 },
    },
  ]),
  /conflicting immutable Interaction projection/u,
);

const sanitizedKafkaRecord = interactionService.parseInteractionKafkaRecord(
  Buffer.from(JSON.stringify({ ...first, prompt: "must-not-survive" })),
);
assert.equal("prompt" in sanitizedKafkaRecord, false);
assert.equal(sanitizedKafkaRecord.interactionId, first.interactionId);
assert.throws(
  () => interactionService.parseInteractionKafkaRecord(
    Buffer.from(JSON.stringify({ ...first, interactionId: "int_tampered" })),
  ),
  /stable identity/u,
);
assert.throws(
  () => interactionService.parseInteractionKafkaRecord(
    Buffer.from(JSON.stringify({ ...first, environmentId: "x".repeat(241) })),
  ),
  /source\.environmentId/u,
);
assert.throws(
  () => interactionService.parseInteractionKafkaRecord(
    Buffer.from(JSON.stringify({ ...first, tenantId: "tenant\nsmuggled" })),
  ),
  /source\.tenantId/u,
);

const observerLine = JSON.stringify({
  identity: { agent: "node" },
  observation: { observed_at_unix_nanos: "1787800000000000000" },
  process: {
    host_id: "host-1",
    boot_id: "boot-1",
    pid: 4242,
    start_time_ticks: 9001,
    comm: "node",
  },
  provider: "OpenAi",
  event: {
    LlmCall: {
      pid: 4242,
      sni: "api.openai.com",
      peer: "203.0.113.10",
      req_bytes: 1024,
      resp_bytes: 4096,
      latency: { secs: 0, nanos: 240000000 },
      ttft: null,
      timing_scope: "connection",
    },
  },
});
const mapped = forwarder.metadataEvent(JSON.parse(observerLine), {
  writerId: "writer-1",
  collectorId: "collector-1",
  line: observerLine,
});
assert(mapped);
assert.equal(mapped.observedAt, 1787800000000);
assert.equal(mapped.transport.timingScope, "connection");
assert.equal(mapped.capture.parseStatus, "not_attempted");
assert.equal(mapped.capture.rawRetentionState, "not_retained");
assert.equal(forwarder.stableSourceEventId("writer-1", observerLine), mapped.sourceEventId);
assert(!JSON.stringify(mapped).match(/secret|prompt|message|query|contentHmac/iu));

const collector = readFileSync(
  path.join(root, "../Observer/a3s-observer-collector/src/main.rs"),
  "utf8",
);
const ebpf = readFileSync(
  path.join(root, "../Observer/a3s-observer-ebpf/src/main.rs"),
  "utf8",
);
const modules = readFileSync(path.join(root, "deploy/docker-compose.modules.yml"), "utf8");
const apiMain = readFileSync(path.join(root, "apps/api/src/main.ts"), "utf8");
assert.match(collector, /unwrap_or\("metadata"\)/u);
assert.match(collector, /A3S_OBSERVER_ENVIRONMENT=isolated_test/u);
assert.match(collector, /PAYLOAD_FIXTURE_CONFIRMATION/u);
assert.match(ebpf, /CONTENT_CAPTURE_ENABLED/u);
assert.match(ebpf, /CONTENT_CAPTURE_TARGETS/u);
assert.match(ebpf, /content_capture_allowed\(pid\)/u);
assert.match(modules, /A3S_OBSERVER_INTERACTION_CAPTURE_MODE:[^\n]*metadata/u);
assert.match(modules, /A3S_OBSERVER_SSL: "0"/u);
assert.doesNotMatch(modules, /A3S_OBSERVER_SSL:[^\n]*:-1/u);
assert.match(apiMain, /\/security-center\/interactions\/ingest-content/u);
assert.match(apiMain, /ANYSENTRY_INTERACTION_BODY_LIMIT/u);
assert.match(apiMain, /ANYSENTRY_OBSERVER_BODY_LIMIT/u);

const contract = JSON.parse(
  readFileSync(
    path.join(root, "config/agent-interaction-phase-minus-one.contract.json"),
    "utf8",
  ),
);
assert.equal(contract.productionCaptureMode, "metadata");
assert.equal(contract.security.metadataOnlyPayloadReads, 0);
assert.equal(contract.supportedFixtureThresholds.byteExactness, 1);
assert.equal(contract.supportedFixtureThresholds.maximumKillSwitchLatencyMs, 1000);

console.log("agent interaction metadata contract: ok");
