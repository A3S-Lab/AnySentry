package org.a3s.anysentry.streaming;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

public class RiskAnalysisBatch implements Serializable {
    public String schemaVersion = "anysentry.risk_analysis_batch.v1";
    public String episodeId;
    public long revision;
    public Long supersedesRevision;
    public String evidenceFingerprint;
    public String triggerReason;
    public String tenantId;
    public String environmentId;
    public String workspaceId;
    public String workspacePath;
    public String agentCorrelationId;
    public String agentType;
    public String sessionId;
    public List<String> traceIds = new ArrayList<>();
    public long windowStart;
    public long windowEnd;
    public long generatedAt;
    public List<Evidence> evidence = new ArrayList<>();
    public String candidateType;
    public String decisionPath = "composite_judge";
    public String ruleVersion = "composite-risk-v2";
    public boolean synthetic;
    public boolean shadow = true;

    public static class Evidence implements Serializable {
        public String eventId;
        public long eventTime;
        public String eventKind;
        public String operation;
        public String subject;
        public String traceId;
        public String sessionId;
        public String resource;
        public String destination;
        public boolean dangerous;
        public boolean sensitiveResource;
        public boolean externalDestination;
        public boolean failed;
        public String command;
        public String executable;
        public boolean argvTruncated;
        public String argvSource;
        public String behaviorStage;
        public boolean platformRuntime;
        public boolean synthetic;
        public CanonicalEvent.ProcessIdentity processIdentity;
        public String supplyChainWorkspaceId;
        public String dependencySnapshotId;
        public String vulnerabilityAssessmentId;
        public List<CanonicalEvent.RuntimeVulnerabilityMatch> runtimeVulnerabilities = new ArrayList<>();
        public Judgment judgment;

        public static Evidence from(BehaviorSignal signal) {
            Evidence evidence = new Evidence();
            evidence.eventId = signal.eventId;
            evidence.eventTime = signal.eventTime;
            evidence.eventKind = signal.eventKind;
            evidence.operation = signal.operation;
            evidence.subject = signal.subject;
            evidence.traceId = signal.traceId;
            evidence.sessionId = signal.sessionId;
            evidence.resource = signal.resource;
            evidence.destination = signal.destination;
            evidence.dangerous = signal.dangerous;
            evidence.sensitiveResource = signal.sensitiveResource;
            evidence.externalDestination = signal.externalDestination;
            evidence.failed = signal.failed;
            evidence.command = signal.command;
            evidence.executable = signal.executable;
            evidence.argvTruncated = signal.argvTruncated;
            evidence.argvSource = signal.argvSource;
            evidence.behaviorStage = signal.behaviorStage;
            evidence.platformRuntime = signal.platformRuntime;
            evidence.synthetic = signal.synthetic;
            evidence.processIdentity = signal.processIdentity;
            evidence.supplyChainWorkspaceId = signal.supplyChainWorkspaceId;
            evidence.dependencySnapshotId = signal.dependencySnapshotId;
            evidence.vulnerabilityAssessmentId = signal.vulnerabilityAssessmentId;
            evidence.runtimeVulnerabilities = signal.runtimeVulnerabilities == null
                    ? new ArrayList<>()
                    : new ArrayList<>(signal.runtimeVulnerabilities);
            return evidence;
        }
    }

    public static class Judgment implements Serializable {
        public String stage;
        public String status;
        public String verdict;
        public String severity;
        public String reason;
        public long latencyMs;
        public long revision;

        public static Judgment from(JudgmentUpdate update) {
            Judgment judgment = new Judgment();
            judgment.stage = update.stage;
            judgment.status = update.status;
            judgment.verdict = update.verdict;
            judgment.severity = update.severity;
            judgment.reason = update.reason;
            judgment.latencyMs = update.latencyMs;
            judgment.revision = update.revision;
            return judgment;
        }
    }
}
