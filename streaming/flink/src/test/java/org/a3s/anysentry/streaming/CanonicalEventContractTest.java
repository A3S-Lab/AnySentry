package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.streaming.api.operators.ProcessOperator;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.OneInputStreamOperatorTestHarness;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CanonicalEventContractTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void parsesApiProcessIdentityRootStartTime() throws Exception {
        String payload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-root-start-time",
                  "eventTime": 1786818000000,
                  "agentCorrelationId": "agc-root-start-time",
                  "processIdentity": {
                    "hostId": "host-1",
                    "bootId": "boot-1",
                    "pid": 4242,
                    "rootPid": 4200,
                    "rootStartTime": "1786817999000",
                    "startTimeTicks": "123456",
                    "processInstanceId": "pri-root-start-time",
                    "identityConfidence": "strong"
                  }
                }
                """;

        CanonicalEvent event = CanonicalEventParser.parse(payload);

        assertNotNull(event.processIdentity);
        assertEquals("1786817999000", event.processIdentity.rootStartTime);
        assertEquals("123456", event.processIdentity.startTimeTicks);
    }

    @Test
    void acceptsAggregatedFileAccessAuditFieldsAndDefaultsLegacyRepeatCount() throws Exception {
        String aggregatedPayload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-aggregated-file-write",
                  "eventTime": 1786818001000,
                  "agentCorrelationId": "agc-aggregated-file-write",
                  "operation": "file_write",
                  "behaviorStage": "file_written",
                  "repeatCount": 100,
                  "firstEventAt": 1786818000000,
                  "lastEventAt": 1786818000999,
                  "aggregationWindowMs": 1000,
                  "fileIdentity": {
                    "fileInstanceId": "file-aggregated",
                    "path": "/tmp/aggregated.log"
                  }
                }
                """;

        CanonicalEvent event = CanonicalEventParser.parse(aggregatedPayload);
        BehaviorSignal signal = BehaviorSignal.from(event);
        RiskAnalysisBatch.Evidence evidence = RiskAnalysisBatch.Evidence.from(signal);

        assertEquals(100L, signal.repeatCount);
        assertEquals(1786818000000L, signal.firstEventAt);
        assertEquals(1786818000999L, signal.lastEventAt);
        assertEquals(1000L, signal.aggregationWindowMs);
        assertEquals(100L, evidence.repeatCount);

        CanonicalEvent legacy = CanonicalEventParser.parse("""
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-legacy-file-write",
                  "eventTime": 1786818002000,
                  "agentCorrelationId": "agc-legacy-file-write"
                }
                """);
        assertEquals(1L, legacy.repeatCount);
        assertEquals(1L, BehaviorSignal.from(legacy).repeatCount);
    }

    @Test
    void futureCorrelationFieldsDoNotEnterDlqOrChangeLegacyStateKeys() throws Exception {
        String legacyPayload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-reader-first",
                  "eventTime": 1786818003000,
                  "tenantId": "tenant-reader-first",
                  "environmentId": "environment-reader-first",
                  "agentCorrelationId": "agc-reader-first",
                  "agentInstanceId": "runtime-reader-first",
                  "sessionId": "session-reader-first",
                  "traceId": "trace-reader-first",
                  "spanId": "span-reader-first",
                  "eventKind": "ToolExec",
                  "operation": "execute"
                }
                """;
        String futurePayload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-reader-first",
                  "eventTime": 1786818003000,
                  "tenantId": "tenant-reader-first",
                  "environmentId": "environment-reader-first",
                  "agentCorrelationId": "agc-reader-first",
                  "agentInstanceId": "runtime-reader-first",
                  "sessionId": "session-reader-first",
                  "traceId": "trace-reader-first",
                  "spanId": "span-reader-first",
                  "eventKind": "ToolExec",
                  "operation": "execute",
                  "invocationId": "invocation-future",
                  "toolCallId": "tool-call-future",
                  "correlation": {
                    "schemaVersion": "anysentry.correlation.v1",
                    "method": "agent_adapter",
                    "scope": "invocation",
                    "confidence": 0.99
                  },
                  "attribution": {
                    "correlation": {
                      "schemaVersion": "anysentry.correlation.v1",
                      "invocationId": "invocation-future",
                      "toolCallId": "tool-call-future",
                      "method": "agent_adapter",
                      "scope": "invocation"
                    }
                  }
                }
                """;

        CanonicalEvent legacy = CanonicalEventParser.parse(legacyPayload);
        BehaviorSignal legacySignal = BehaviorSignal.from(legacy);

        try (OneInputStreamOperatorTestHarness<String, CanonicalEvent> harness =
                     new OneInputStreamOperatorTestHarness<>(
                             new ProcessOperator<>(new CanonicalEventParser())
                     )) {
            harness.open();
            harness.processElement(new StreamRecord<>(futurePayload));

            List<CanonicalEvent> output = harness.extractOutputValues();
            assertEquals(1, output.size());
            assertSideOutputEmpty(harness);

            CanonicalEvent future = output.get(0);
            BehaviorSignal futureSignal = BehaviorSignal.from(future);
            assertEquals(legacy.eventId, future.eventId);
            assertEquals(legacy.eventTime, future.eventTime);
            assertEquals(legacy.agentCorrelationId, future.agentCorrelationId);
            assertEquals(legacy.agentInstanceId, future.agentInstanceId);
            assertEquals(legacy.sessionId, future.sessionId);
            assertEquals(legacy.traceId, future.traceId);
            assertEquals(legacy.spanId, future.spanId);
            assertEquals(legacySignal.episodeKey(), futureSignal.episodeKey());
            assertFalse(MAPPER.valueToTree(future).has("invocationId"));
            assertFalse(MAPPER.valueToTree(future).has("toolCallId"));
            assertFalse(MAPPER.valueToTree(future).has("correlation"));
        }
    }

    @Test
    void additiveFieldsCannotBypassLegacyRequiredFieldValidation() throws Exception {
        String payload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-invalid-correlation",
                  "eventTime": 1786818004000,
                  "agentCorrelationId": "",
                  "invocationId": "invocation-future",
                  "toolCallId": "tool-call-future",
                  "correlation": {
                    "method": "agent_adapter",
                    "scope": "invocation"
                  }
                }
                """;

        try (OneInputStreamOperatorTestHarness<String, CanonicalEvent> harness =
                     new OneInputStreamOperatorTestHarness<>(
                             new ProcessOperator<>(new CanonicalEventParser())
                     )) {
            harness.open();
            harness.processElement(new StreamRecord<>(payload));

            assertTrue(harness.extractOutputValues().isEmpty());
            ConcurrentLinkedQueue<StreamRecord<String>> dlq =
                    harness.getSideOutput(CanonicalEventParser.DLQ);
            assertNotNull(dlq);
            assertEquals(1, dlq.size());
            assertTrue(dlq.peek().getValue().contains("canonical event is missing required fields"));
        }
    }

    @Test
    void riskProfileInputExcludesOrdinaryHighRateFileAndLifecycleFacts() {
        CanonicalEvent ordinaryWrite = new CanonicalEvent();
        ordinaryWrite.eventKind = "FileAccess";
        ordinaryWrite.operation = "file_write";
        ordinaryWrite.behaviorStage = "file_written";
        assertFalse(AnySentryStreamJob.profileRelevant(ordinaryWrite));
        assertFalse(AnySentryStreamJob.episodeRelevant(ordinaryWrite));

        CanonicalEvent processExit = new CanonicalEvent();
        processExit.eventKind = "ProcessExit";
        assertFalse(AnySentryStreamJob.profileRelevant(processExit));

        CanonicalEvent sensitiveRead = new CanonicalEvent();
        sensitiveRead.eventKind = "FileAccess";
        sensitiveRead.operation = "file_read";
        sensitiveRead.sensitiveResource = true;
        sensitiveRead.behaviorStage = "credential_access";
        assertTrue(AnySentryStreamJob.profileRelevant(sensitiveRead));
        assertTrue(AnySentryStreamJob.episodeRelevant(sensitiveRead));

        CanonicalEvent tool = new CanonicalEvent();
        tool.eventKind = "ToolExec";
        assertTrue(AnySentryStreamJob.profileRelevant(tool));

        CanonicalEvent externalEgress = new CanonicalEvent();
        externalEgress.operation = "egress";
        externalEgress.externalDestination = true;
        assertTrue(AnySentryStreamJob.profileRelevant(externalEgress));
    }

    private static void assertSideOutputEmpty(
            OneInputStreamOperatorTestHarness<String, CanonicalEvent> harness
    ) {
        ConcurrentLinkedQueue<StreamRecord<String>> dlq =
                harness.getSideOutput(CanonicalEventParser.DLQ);
        assertTrue(dlq == null || dlq.isEmpty());
    }
}
