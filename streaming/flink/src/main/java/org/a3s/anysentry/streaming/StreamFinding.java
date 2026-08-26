package org.a3s.anysentry.streaming;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class StreamFinding implements Serializable {
    public String schemaVersion = "anysentry.stream_finding.v1";
    public String findingType;
    public String findingId;
    public String profileId;
    public String correlationId;
    public long version;
    public String tenantId;
    public String environmentId;
    public String workspaceId;
    public String workspacePath;
    public String agentCorrelationId;
    public String agentInstanceId;
    public String agentType;
    public String sessionId;
    public String traceId;
    public String ruleId;
    public String ruleVersion;
    public long windowStart;
    public long windowEnd;
    public long calculatedAt;
    public double riskScore;
    public String riskLevel;
    public Map<String, Integer> features = new LinkedHashMap<>();
    public List<String> hitRules = new ArrayList<>();
    public double evidenceScore;
    public String severity;
    public List<String> evidenceEventIds = new ArrayList<>();
    public List<Evidence> evidence = new ArrayList<>();
    public String reason;
    public boolean shadow = true;

    public static class Evidence implements Serializable {
        public String eventId;
        public String sourceRecordId;
        public long eventTime;
        public String eventKind;
        public String operation;
        public String subject;

        public static Evidence from(CanonicalEvent event) {
            Evidence evidence = new Evidence();
            evidence.eventId = event.eventId;
            evidence.sourceRecordId = event.sourceRecordId;
            evidence.eventTime = event.eventTime;
            evidence.eventKind = event.eventKind;
            evidence.operation = event.operation;
            evidence.subject = event.subject;
            return evidence;
        }
    }
}
