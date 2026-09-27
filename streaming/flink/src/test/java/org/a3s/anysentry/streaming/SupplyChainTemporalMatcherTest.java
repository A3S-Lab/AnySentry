package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SupplyChainTemporalMatcherTest {
    @Test
    void matchesOrderedVulnerableExecutionChildShellAndEgress() {
        BehaviorSignal seed = vulnerable("seed", 1_000, 100, 10, "high", "strong");
        BehaviorSignal shell = signal("shell", 2_000, 101, 100, "bash", "shell_execution", "strong");
        BehaviorSignal egress = signal("egress", 3_000, 102, 101, "curl", "external_egress", "strong");
        egress.operation = "egress";
        egress.externalDestination = true;

        List<SupplyChainTemporalMatcher.Match> matches =
                SupplyChainTemporalMatcher.match(List.of(egress, seed, shell));

        assertEquals(1, matches.size());
        assertEquals("known_vulnerability_exploitation", matches.get(0).candidateType());
        assertEquals("strong", matches.get(0).evidenceConfidence());
        assertEquals(
                List.of("seed", "shell", "egress"),
                matches.get(0).evidence().stream().map(signal -> signal.eventId).toList()
        );
    }

    @Test
    void mediumComponentMatchRequiresCompositeJudgment() {
        BehaviorSignal seed = vulnerable("seed", 1_000, 100, 10, "medium", "strong");
        BehaviorSignal shell = signal("shell", 2_000, 101, 100, "node", "shell_execution", "strong");
        BehaviorSignal sensitive = signal("sensitive", 3_000, 102, 101, "cat", "credential_access", "strong");
        sensitive.operation = "file_read";
        sensitive.sensitiveResource = true;

        List<SupplyChainTemporalMatcher.Match> matches =
                SupplyChainTemporalMatcher.match(List.of(seed, shell, sensitive));

        assertEquals(1, matches.size());
        assertEquals("medium", matches.get(0).evidenceConfidence());
    }

    @Test
    void vulnerabilityWithoutChildShellDoesNotCreateEpisode() {
        BehaviorSignal seed = vulnerable("seed", 1_000, 100, 10, "high", "strong");
        BehaviorSignal egress = signal("egress", 2_000, 101, 100, "curl", "external_egress", "strong");
        egress.operation = "egress";
        egress.externalDestination = true;

        assertTrue(SupplyChainTemporalMatcher.match(List.of(seed, egress)).isEmpty());
    }

    @Test
    void unrelatedShellDoesNotCreateEpisode() {
        BehaviorSignal seed = vulnerable("seed", 1_000, 100, 10, "high", "strong");
        BehaviorSignal shell = signal("shell", 2_000, 201, 200, "bash", "shell_execution", "strong");
        BehaviorSignal egress = signal("egress", 3_000, 202, 201, "curl", "external_egress", "strong");
        egress.operation = "egress";
        egress.externalDestination = true;

        assertTrue(SupplyChainTemporalMatcher.match(List.of(seed, shell, egress)).isEmpty());
    }

    @Test
    void rejectsSequenceOutsideFiveMinuteWindow() {
        BehaviorSignal seed = vulnerable("seed", 1_000, 100, 10, "high", "strong");
        BehaviorSignal shell = signal("shell", 2_000, 101, 100, "bash", "shell_execution", "strong");
        BehaviorSignal egress = signal(
                "egress",
                SupplyChainTemporalMatcher.WINDOW_MS + 1_001,
                102,
                101,
                "curl",
                "external_egress",
                "strong"
        );
        egress.operation = "egress";
        egress.externalDestination = true;

        assertTrue(SupplyChainTemporalMatcher.match(List.of(seed, shell, egress)).isEmpty());
    }

    private static BehaviorSignal vulnerable(
            String id,
            long time,
            int pid,
            int ppid,
            String matchConfidence,
            String processConfidence
    ) {
        BehaviorSignal signal = signal(
                id,
                time,
                pid,
                ppid,
                "vulnerable-tool",
                "vulnerable_component_execution",
                processConfidence
        );
        CanonicalEvent.RuntimeVulnerabilityMatch match =
                new CanonicalEvent.RuntimeVulnerabilityMatch();
        match.findingId = "finding-1";
        match.packageName = "vulnerable-tool";
        match.version = "1.0.0";
        match.vulnerabilityId = "GHSA-test";
        match.confidence = matchConfidence;
        signal.runtimeVulnerabilities.add(match);
        return signal;
    }

    private static BehaviorSignal signal(
            String id,
            long time,
            int pid,
            int ppid,
            String executable,
            String stage,
            String processConfidence
    ) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "event";
        signal.eventId = id;
        signal.eventTime = time;
        signal.executable = executable;
        signal.behaviorStage = stage;
        signal.processIdentity = new CanonicalEvent.ProcessIdentity();
        signal.processIdentity.hostId = "node-1";
        signal.processIdentity.bootId = "boot-1";
        signal.processIdentity.pid = pid;
        signal.processIdentity.ppid = ppid;
        signal.processIdentity.processInstanceId = "process-" + pid;
        signal.processIdentity.identityConfidence = processConfidence;
        return signal;
    }
}
