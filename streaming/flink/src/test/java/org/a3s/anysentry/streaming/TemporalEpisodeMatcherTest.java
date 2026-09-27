package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TemporalEpisodeMatcherTest {
    @Test
    void matchesOrderedDownloadExecuteOnOneFile() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("exec", 4_000, "execute", "file-1", "medium", false),
                signal("download", 1_000, "download", "file-1", "medium", false),
                signal("chmod", 3_000, "chmod", "file-1", "medium", false),
                signal("write", 2_000, "file_write", "file-1", "medium", false)
        ));

        assertEquals(1, matches.size());
        assertEquals("download_execute", matches.get(0).candidateType());
        assertEquals("medium", matches.get(0).evidenceConfidence());
        assertEquals(
                List.of("download", "file_write", "chmod", "execute"),
                matches.get(0).evidence().stream().map(signal -> signal.operation).toList()
        );
    }

    @Test
    void rejectsDownloadExecuteAcrossDifferentFiles() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("download", 1_000, "download", "file-1", "strong", false),
                signal("write", 2_000, "file_write", "file-1", "strong", false),
                signal("chmod", 3_000, "chmod", "file-2", "strong", false),
                signal("exec", 4_000, "execute", "file-2", "strong", false)
        ));

        assertTrue(matches.isEmpty());
    }

    @Test
    void matchesSensitiveTransformAndEgress() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("egress", 3_000, "egress", null, null, true),
                signal("read", 1_000, "file_read", "credential-1", "strong", false),
                signal("encode", 2_000, "encode", "credential-1", "strong", false)
        ));

        assertEquals(1, matches.size());
        assertEquals("sensitive_data_exfiltration", matches.get(0).candidateType());
        assertEquals("strong", matches.get(0).evidenceConfidence());
    }

    @Test
    void oneEgressClosesTheMostRecentCompleteCandidateForOneFile() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("read-old", 1_000, "file_read", "credential-1", "medium", false),
                signal("encode-old", 2_000, "encode", "credential-1", "medium", false),
                signal("read-new", 3_000, "file_read", "credential-1", "medium", false),
                signal("encode-new", 4_000, "encode", "credential-1", "medium", false),
                signal("egress", 5_000, "egress", null, null, true)
        ));

        assertEquals(1, matches.size());
        assertEquals(
                List.of("read-new", "encode-new", "egress"),
                matches.get(0).evidence().stream().map(signal -> signal.eventId).toList()
        );
        assertEquals(
                "sensitive_data_exfiltration\0credential-1\0egress",
                matches.get(0).terminalCompletionKey()
        );
    }

    @Test
    void repeatedExecuteUsesTheMostRecentCompleteDownloadCandidate() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("download-old", 1_000, "download", "file-1", "medium", false),
                signal("write-old", 2_000, "file_write", "file-1", "medium", false),
                signal("chmod-old", 3_000, "chmod", "file-1", "medium", false),
                signal("download-new", 4_000, "download", "file-1", "medium", false),
                signal("write-new", 5_000, "file_write", "file-1", "medium", false),
                signal("chmod-new", 6_000, "chmod", "file-1", "medium", false),
                signal("execute", 7_000, "execute", "file-1", "medium", false)
        ));

        assertEquals(1, matches.size());
        assertEquals(
                List.of("download-new", "write-new", "chmod-new", "execute"),
                matches.get(0).evidence().stream().map(signal -> signal.eventId).toList()
        );
    }

    @Test
    void rejectsSequenceOutsideFiveMinuteWindow() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                signal("download", 1_000, "download", "file-1", "strong", false),
                signal("write", 2_000, "file_write", "file-1", "strong", false),
                signal("chmod", 3_000, "chmod", "file-1", "strong", false),
                signal("exec", TemporalEpisodeMatcher.WINDOW_MS + 1_001, "execute", "file-1", "strong", false)
        ));

        assertTrue(matches.isEmpty());
    }

    @Test
    void matchesPersistenceWriteAndActivationForOneTarget() {
        BehaviorSignal activation = advancedSignal(
                "activate", 2_000, "persistence_activate",
                "/etc/systemd/system/agent-demo.service", "persistence_activation", 1200
        );
        BehaviorSignal write = advancedSignal(
                "write", 1_000, "file_write",
                "/etc/systemd/system/agent-demo.service", "persistence_write", 1200
        );

        List<TemporalEpisodeMatcher.Match> matches =
                TemporalEpisodeMatcher.match(List.of(activation, write));

        assertEquals(1, matches.size());
        assertEquals("persistence_installation", matches.get(0).candidateType());
        assertEquals(List.of("write", "activate"), ids(matches.get(0)));
    }

    @Test
    void rejectsPersistenceActivationForAnotherTarget() {
        assertTrue(TemporalEpisodeMatcher.match(List.of(
                advancedSignal(
                        "write", 1_000, "file_write",
                        "/etc/systemd/system/agent-a.service", "persistence_write", 1200
                ),
                advancedSignal(
                        "activate", 2_000, "persistence_activate",
                        "/etc/systemd/system/agent-b.service", "persistence_activation", 1200
                )
        )).isEmpty());
    }

    @Test
    void matchesSandboxProbePrivilegeChangeAndSensitiveConsequence() {
        BehaviorSignal probe = advancedSignal(
                "probe", 1_000, "sandbox_probe", "unshare --user --mount", "sandbox_probe", 1200
        );
        BehaviorSignal privilege = advancedSignal(
                "privilege", 2_000, "privilege_change", "sudo -n bash", "privilege_change", 1200
        );
        BehaviorSignal consequence = advancedSignal(
                "shadow", 3_000, "file_read", "/etc/shadow", "credential_access", 1200
        );
        consequence.sensitiveResource = true;

        List<TemporalEpisodeMatcher.Match> matches =
                TemporalEpisodeMatcher.match(List.of(consequence, probe, privilege));

        assertEquals(1, matches.size());
        assertEquals("sandbox_privilege_breakout", matches.get(0).candidateType());
        assertEquals(List.of("probe", "privilege", "shadow"), ids(matches.get(0)));
    }

    @Test
    void rejectsSandboxSequenceAcrossDifferentProcessRoots() {
        BehaviorSignal consequence = advancedSignal(
                "shadow", 3_000, "file_read", "/etc/shadow", "credential_access", 2200
        );
        consequence.sensitiveResource = true;
        assertTrue(TemporalEpisodeMatcher.match(List.of(
                advancedSignal(
                        "probe", 1_000, "sandbox_probe", "unshare --user", "sandbox_probe", 1200
                ),
                advancedSignal(
                        "privilege", 2_000, "privilege_change", "sudo -n bash", "privilege_change", 1200
                ),
                consequence
        )).isEmpty());
    }

    @Test
    void matchesDiscoveryFollowedByTwoDestructiveFactsInOneScope() {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.match(List.of(
                advancedSignal("delete-2", 3_000, "destroy", "/srv/app/b", "destructive_action", 1200),
                advancedSignal("discover", 1_000, "target_discovery", "/srv/app", "target_discovery", 1200),
                advancedSignal("delete-1", 2_000, "destroy", "/srv/app/a", "destructive_action", 1200)
        ));

        assertEquals(1, matches.size());
        assertEquals("destructive_behavior", matches.get(0).candidateType());
        assertEquals(List.of("discover", "delete-1", "delete-2"), ids(matches.get(0)));
    }

    @Test
    void rejectsDestructionOutsideDiscoveredPathScope() {
        assertTrue(TemporalEpisodeMatcher.match(List.of(
                advancedSignal("discover", 1_000, "target_discovery", "/srv/app", "target_discovery", 1200),
                advancedSignal("delete-1", 2_000, "destroy", "/srv/app/a", "destructive_action", 1200),
                advancedSignal("delete-2", 3_000, "destroy", "/var/log/b", "destructive_action", 1200)
        )).isEmpty());
    }

    @Test
    void matchesCredentialBackedRemoteConnectAndAction() {
        BehaviorSignal credential = advancedSignal(
                "credential", 1_000, "file_read", "/home/test/.ssh/id_demo", "credential_access", 1200
        );
        credential.sensitiveResource = true;
        file(credential, "ssh-key", "strong");
        BehaviorSignal connect = advancedSignal(
                "connect", 2_000, "remote_connect", "/home/test/.ssh/id_demo", "lateral_connect", 1200
        );
        connect.destination = "10.0.0.8";
        file(connect, "ssh-key", "strong");
        BehaviorSignal execute = advancedSignal(
                "remote-exec", 3_000, "remote_execute", "/home/test/.ssh/id_demo", "lateral_action", 1200
        );
        execute.destination = "10.0.0.8";
        file(execute, "ssh-key", "strong");

        List<TemporalEpisodeMatcher.Match> matches =
                TemporalEpisodeMatcher.match(List.of(execute, credential, connect));

        assertEquals(1, matches.size());
        assertEquals("lateral_movement", matches.get(0).candidateType());
        assertEquals(List.of("credential", "connect", "remote-exec"), ids(matches.get(0)));
    }

    @Test
    void rejectsLateralMovementAcrossDifferentDestinations() {
        BehaviorSignal credential = advancedSignal(
                "credential", 1_000, "file_read", "/home/test/.ssh/id_demo", "credential_access", 1200
        );
        credential.sensitiveResource = true;
        file(credential, "ssh-key", "strong");
        BehaviorSignal connect = advancedSignal(
                "connect", 2_000, "remote_connect", "/home/test/.ssh/id_demo", "lateral_connect", 1200
        );
        connect.destination = "10.0.0.8";
        file(connect, "ssh-key", "strong");
        BehaviorSignal execute = advancedSignal(
                "remote-exec", 3_000, "remote_execute", "/home/test/.ssh/id_demo", "lateral_action", 1200
        );
        execute.destination = "10.0.0.9";
        file(execute, "ssh-key", "strong");
        assertTrue(TemporalEpisodeMatcher.match(List.of(
                credential, connect, execute
        )).isEmpty());
    }

    @Test
    void routesOnlyIncompleteDownloadAndExfiltrationEvidenceToCompositeJudge() {
        List<TemporalEpisodeMatcher.Match> download = TemporalEpisodeMatcher.ambiguous(List.of(
                signal("download", 1_000, "download", "file-1", "medium", false),
                signal("execute", 2_000, "execute", "file-1", "medium", false)
        ));
        assertEquals(1, download.size());
        assertEquals("download_execute", download.get(0).candidateType());
        assertEquals("composite_judge", download.get(0).decisionPath());

        List<TemporalEpisodeMatcher.Match> exfiltration = TemporalEpisodeMatcher.ambiguous(List.of(
                signal("read", 1_000, "file_read", "credential-1", "medium", false),
                signal("egress", 2_000, "egress", null, null, true)
        ));
        assertEquals(1, exfiltration.size());
        assertEquals("sensitive_data_exfiltration", exfiltration.get(0).candidateType());
        assertEquals("composite_judge", exfiltration.get(0).decisionPath());

        assertTrue(TemporalEpisodeMatcher.ambiguous(List.of(
                signal("download", 1_000, "download", "file-1", "medium", false),
                signal("write", 2_000, "file_write", "file-1", "medium", false),
                signal("chmod", 3_000, "chmod", "file-1", "medium", false),
                signal("execute", 4_000, "execute", "file-1", "medium", false)
        )).isEmpty(), "complete evidence must never be routed to the model");
    }

    @Test
    void routesFourIncompleteV2PatternsToCompositeJudge() {
        BehaviorSignal persistenceWrite = advancedSignal(
                "write", 1_000, "file_write",
                "/etc/systemd/system/a.service", "persistence_write", 1200
        );
        BehaviorSignal persistenceActivation = advancedSignal(
                "activate", 2_000, "persistence_activate",
                "/etc/systemd/system/b.service", "persistence_activation", 1200
        );
        assertAmbiguous(
                "persistence_installation",
                List.of(persistenceWrite, persistenceActivation)
        );

        BehaviorSignal sensitive = advancedSignal(
                "sensitive", 2_000, "file_read", "/etc/shadow", "credential_access", 1200
        );
        sensitive.sensitiveResource = true;
        assertAmbiguous("sandbox_privilege_breakout", List.of(
                advancedSignal("probe", 1_000, "sandbox_probe", "unshare --user", "sandbox_probe", 1200),
                sensitive
        ));

        assertAmbiguous("destructive_behavior", List.of(
                advancedSignal("discover", 1_000, "target_discovery", "/srv/app", "target_discovery", 1200),
                advancedSignal("delete", 2_000, "destroy", "/srv/app/a", "destructive_action", 1200)
        ));

        BehaviorSignal credential = advancedSignal(
                "credential", 1_000, "file_read", "/home/test/.ssh/id_demo", "credential_access", 1200
        );
        credential.sensitiveResource = true;
        file(credential, "ssh-key", "strong");
        BehaviorSignal action = advancedSignal(
                "remote-exec", 2_000, "remote_execute", "/home/test/.ssh/id_demo", "lateral_action", 1200
        );
        action.destination = "10.0.0.8";
        file(action, "ssh-key", "strong");
        assertAmbiguous("lateral_movement", List.of(credential, action));
    }

    @Test
    void doesNotCreateAmbiguousCandidateFromOneFactOrUnrelatedEntities() {
        assertTrue(TemporalEpisodeMatcher.ambiguous(List.of(
                signal("execute", 2_000, "execute", "file-1", "medium", false)
        )).isEmpty());
        assertTrue(TemporalEpisodeMatcher.ambiguous(List.of(
                signal("download", 1_000, "download", "file-1", "medium", false),
                signal("execute", 2_000, "execute", "file-2", "medium", false)
        )).isEmpty());
    }

    private static BehaviorSignal signal(
            String id,
            long eventTime,
            String operation,
            String fileId,
            String confidence,
            boolean external
    ) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "event";
        signal.eventId = id;
        signal.eventTime = eventTime;
        signal.operation = operation;
        signal.externalDestination = external;
        signal.sensitiveResource = "file_read".equals(operation);
        if (fileId != null) {
            signal.fileIdentity = new CanonicalEvent.FileIdentity();
            signal.fileIdentity.fileInstanceId = fileId;
            signal.fileIdentity.identityConfidence = confidence;
        }
        return signal;
    }

    private static BehaviorSignal advancedSignal(
            String id,
            long eventTime,
            String operation,
            String resource,
            String behaviorStage,
            int rootPid
    ) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "event";
        signal.eventId = id;
        signal.eventTime = eventTime;
        signal.operation = operation;
        signal.resource = resource;
        signal.behaviorStage = behaviorStage;
        signal.processIdentity = new CanonicalEvent.ProcessIdentity();
        signal.processIdentity.hostId = "node-1";
        signal.processIdentity.bootId = "boot-1";
        signal.processIdentity.rootPid = rootPid;
        signal.processIdentity.pid = rootPid + (int) (eventTime / 1_000);
        signal.processIdentity.startTimeNs = String.valueOf(eventTime * 1_000_000);
        signal.processIdentity.processInstanceId = "process-" + id;
        signal.processIdentity.identityConfidence = "strong";
        if (resource != null && resource.startsWith("/")) {
            file(signal, "file:" + resource, "strong");
        }
        return signal;
    }

    private static void file(BehaviorSignal signal, String fileId, String confidence) {
        signal.fileIdentity = new CanonicalEvent.FileIdentity();
        signal.fileIdentity.fileInstanceId = fileId;
        signal.fileIdentity.path = signal.resource;
        signal.fileIdentity.identityConfidence = confidence;
    }

    private static List<String> ids(TemporalEpisodeMatcher.Match match) {
        return match.evidence().stream().map(signal -> signal.eventId).toList();
    }

    private static void assertAmbiguous(
            String candidateType,
            List<BehaviorSignal> evidence
    ) {
        List<TemporalEpisodeMatcher.Match> matches = TemporalEpisodeMatcher.ambiguous(evidence);
        assertEquals(1, matches.size());
        assertEquals(candidateType, matches.get(0).candidateType());
        assertEquals("composite_judge", matches.get(0).decisionPath());
        assertEquals("weak", matches.get(0).evidenceConfidence());
    }
}
