package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TemporalEpisodeBuilderFunctionTest {
    @Test
    void ignoresOneHundredUnrelatedOrdinaryTemporaryWritesWithoutDlqOrCandidates() throws Exception {
        TemporalEpisodeBuilderFunction function = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                     harness(function)) {
            for (int index = 0; index < 100; index += 1) {
                process(harness, fileSignal(
                        "ordinary-" + index,
                        1_000L + index,
                        "file_write",
                        "file-ordinary-" + index,
                        temporaryPath(index),
                        "file_written"
                ));
            }

            assertTrue(harness.extractOutputValues().isEmpty());
            assertSideOutputEmpty(harness);
            assertEquals(0L, function.fileCandidateSuppressionCount());

            for (int index = 0; index < TemporalEpisodeBuilderFunction.MAX_ACTIVE_FILE_CANDIDATES;
                 index += 1) {
                process(harness, fileSignal(
                        "download-" + index,
                        2_000L + index,
                        "download",
                        "file-download-" + index,
                        "/tmp/download-" + index,
                        "download"
                ));
            }
            assertEquals(0L, function.fileCandidateSuppressionCount(),
                    "ordinary writes must not consume active candidate capacity");

            process(harness, fileSignal(
                    "download-over-capacity",
                    3_000L,
                    "download",
                    "file-download-over-capacity",
                    "/tmp/download-over-capacity",
                    "download"
            ));
            assertEquals(1L, function.fileCandidateSuppressionCount());
            assertSideOutputEmpty(harness);
        }
    }

    @Test
    void keepsOrdinaryAggregatedWriteAsEvidenceForAnExistingDownloadCandidate() throws Exception {
        TemporalEpisodeBuilderFunction function = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                     harness(function)) {
            process(harness, fileSignal(
                    "download", 1_000L, "download", "downloaded-file", "/tmp/tool", "download"
            ));
            BehaviorSignal write = fileSignal(
                    "write", 2_000L, "file_write", "downloaded-file", "/tmp/tool", "file_written"
            );
            write.repeatCount = 100L;
            write.firstEventAt = 1_500L;
            write.lastEventAt = 1_999L;
            write.aggregationWindowMs = 500L;
            process(harness, write);
            process(harness, fileSignal(
                    "chmod", 3_000L, "chmod", "downloaded-file", "/tmp/tool", "permission_changed"
            ));
            process(harness, fileSignal(
                    "execute", 4_000L, "execute", "downloaded-file", "/tmp/tool", "file_executed"
            ));

            List<RiskAnalysisBatch> output = harness.extractOutputValues();
            assertEquals(1, output.size());
            RiskAnalysisBatch batch = output.get(0);
            assertEquals("download_execute", batch.candidateType);
            assertEquals(List.of("download", "write", "chmod", "execute"),
                    batch.evidence.stream().map(item -> item.eventId).toList());
            assertEquals(100L, batch.evidence.get(1).repeatCount,
                    "an aggregate remains one temporal fact while retaining its audit count");
            assertSideOutputEmpty(harness);
        }
    }

    @Test
    void preservesPersistenceDetection() throws Exception {
        TemporalEpisodeBuilderFunction function = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                     harness(function)) {
            BehaviorSignal write = fileSignal(
                    "persistence-write",
                    1_000L,
                    "file_write",
                    "persistence-file",
                    "/etc/systemd/system/demo.service",
                    "persistence_write"
            );
            processIdentity(write, 4242);
            process(harness, write);
            BehaviorSignal activate = fileSignal(
                    "persistence-activate",
                    2_000L,
                    "persistence_activate",
                    "persistence-file",
                    "/etc/systemd/system/demo.service",
                    "persistence_activation"
            );
            processIdentity(activate, 4242);
            process(harness, activate);

            List<RiskAnalysisBatch> output = harness.extractOutputValues();
            assertEquals(1, output.size());
            assertEquals("persistence_installation", output.get(0).candidateType);
            assertSideOutputEmpty(harness);
        }
    }

    @Test
    void suppressesFileAndAmbiguousCapacityWithoutSendingFactsToDlq() throws Exception {
        TemporalEpisodeBuilderFunction function = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                     harness(function)) {
            for (int index = 0; index < TemporalEpisodeBuilderFunction.MAX_ACTIVE_FILE_CANDIDATES;
                 index += 1) {
                String fileId = "ambiguous-file-" + index;
                process(harness, fileSignal(
                        "ambiguous-download-" + index,
                        1_000L + index * 10L,
                        "download",
                        fileId,
                        "/tmp/ambiguous-" + index,
                        "download"
                ));
                process(harness, fileSignal(
                        "ambiguous-execute-" + index,
                        1_001L + index * 10L,
                        "execute",
                        fileId,
                        "/tmp/ambiguous-" + index,
                        "file_executed"
                ));
            }

            BehaviorSignal probe = nonFileSignal("probe", 2_000L, "sandbox_probe", false);
            processIdentity(probe, 7000);
            process(harness, probe);
            BehaviorSignal consequence = nonFileSignal("consequence", 2_001L, "destroy", true);
            processIdentity(consequence, 7000);
            process(harness, consequence);

            assertEquals(1L, function.ambiguousCandidateSuppressionCount());
            assertEquals(0L, function.fileCandidateSuppressionCount());
            assertSideOutputEmpty(harness);
        }
    }

    @Test
    void keepsLateFactsOnTheRejectedFactsDlqPath() throws Exception {
        TemporalEpisodeBuilderFunction function = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                     harness(function)) {
            process(harness, fileSignal(
                    "newer", 100_000L, "download", "newer-file", "/tmp/newer", "download"
            ));
            process(harness, fileSignal(
                    "late", 1_000L, "download", "late-file", "/tmp/late", "download"
            ));

            ConcurrentLinkedQueue<StreamRecord<String>> rejected =
                    harness.getSideOutput(TemporalEpisodeBuilderFunction.REJECTED_FACTS);
            assertNotNull(rejected);
            assertEquals(1, rejected.size());
            assertTrue(rejected.peek().getValue().contains("temporal allowed lateness"));
        }
    }

    @Test
    void restoresActiveCandidateStateAcrossCheckpoint() throws Exception {
        TemporalEpisodeBuilderFunction initialFunction = new TemporalEpisodeBuilderFunction();
        OperatorSubtaskState snapshot;
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> initial =
                     harness(initialFunction)) {
            process(initial, fileSignal(
                    "download", 1_000L, "download", "restored-file", "/tmp/restored", "download"
            ));
            snapshot = initial.snapshot(1L, 1L);
        }

        TemporalEpisodeBuilderFunction restoredFunction = new TemporalEpisodeBuilderFunction();
        try (KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> restored =
                     unopenedHarness(restoredFunction)) {
            restored.initializeState(snapshot);
            restored.open();
            process(restored, fileSignal(
                    "write", 2_000L, "file_write", "restored-file", "/tmp/restored", "file_written"
            ));
            process(restored, fileSignal(
                    "chmod", 3_000L, "chmod", "restored-file", "/tmp/restored", "permission_changed"
            ));
            process(restored, fileSignal(
                    "execute", 4_000L, "execute", "restored-file", "/tmp/restored", "file_executed"
            ));

            List<RiskAnalysisBatch> output = restored.extractOutputValues();
            assertEquals(1, output.size());
            assertEquals("download_execute", output.get(0).candidateType);
            assertSideOutputEmpty(restored);
        }
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch>
    harness(TemporalEpisodeBuilderFunction function) throws Exception {
        KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness =
                unopenedHarness(function);
        harness.open();
        return harness;
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch>
    unopenedHarness(TemporalEpisodeBuilderFunction function) throws Exception {
        return new KeyedOneInputStreamOperatorTestHarness<>(
                new KeyedProcessOperator<>(function),
                BehaviorSignal::episodeKey,
                Types.STRING
        );
    }

    private static void process(
            KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness,
            BehaviorSignal signal
    ) throws Exception {
        harness.processElement(new StreamRecord<>(signal, signal.eventTime));
    }

    private static BehaviorSignal fileSignal(
            String eventId,
            long eventTime,
            String operation,
            String fileId,
            String path,
            String behaviorStage
    ) {
        BehaviorSignal signal = nonFileSignal(eventId, eventTime, operation, false);
        signal.resource = path;
        signal.behaviorStage = behaviorStage;
        signal.fileIdentity = new CanonicalEvent.FileIdentity();
        signal.fileIdentity.fileInstanceId = fileId;
        signal.fileIdentity.path = path;
        signal.fileIdentity.identityConfidence = "strong";
        return signal;
    }

    private static BehaviorSignal nonFileSignal(
            String eventId,
            long eventTime,
            String operation,
            boolean dangerous
    ) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "event";
        signal.eventId = eventId;
        signal.eventTime = eventTime;
        signal.tenantId = "tenant-1";
        signal.environmentId = "environment-1";
        signal.agentCorrelationId = "agent-1";
        signal.sessionId = "session-1";
        signal.operation = operation;
        signal.dangerous = dangerous;
        return signal;
    }

    private static void processIdentity(BehaviorSignal signal, int rootPid) {
        signal.processIdentity = new CanonicalEvent.ProcessIdentity();
        signal.processIdentity.hostId = "node-1";
        signal.processIdentity.bootId = "boot-1";
        signal.processIdentity.rootPid = rootPid;
        signal.processIdentity.pid = rootPid + 1;
        signal.processIdentity.processInstanceId = "process-" + rootPid;
        signal.processIdentity.identityConfidence = "strong";
    }

    private static String temporaryPath(int index) {
        return switch (index % 3) {
            case 0 -> "/tmp/ordinary-" + index;
            case 1 -> "/var/tmp/ordinary-" + index;
            default -> "/dev/shm/ordinary-" + index;
        };
    }

    private static void assertSideOutputEmpty(
            KeyedOneInputStreamOperatorTestHarness<String, BehaviorSignal, RiskAnalysisBatch> harness
    ) {
        ConcurrentLinkedQueue<StreamRecord<String>> rejected =
                harness.getSideOutput(TemporalEpisodeBuilderFunction.REJECTED_FACTS);
        assertTrue(rejected == null || rejected.isEmpty());
    }
}
