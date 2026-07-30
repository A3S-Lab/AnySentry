package org.a3s.anysentry.streaming;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

public class BehaviorSignal implements Serializable {
    public String signalType;
    public String eventId;
    public long eventTime;
    public String tenantId;
    public String environmentId;
    public String workspaceId;
    public String workspacePath;
    public String supplyChainWorkspaceId;
    public String dependencySnapshotId;
    public String vulnerabilityAssessmentId;
    public List<CanonicalEvent.RuntimeVulnerabilityMatch> runtimeVulnerabilities = new ArrayList<>();
    public String agentCorrelationId;
    public String agentType;
    public String sessionId;
    public String traceId;
    public String eventKind;
    public String operation;
    public String resource;
    public String destination;
    public String subject;
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
    public JudgmentUpdate judgment;

    public static BehaviorSignal from(CanonicalEvent event) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "event";
        signal.eventId = event.eventId;
        signal.eventTime = event.eventTime;
        signal.tenantId = event.tenantId;
        signal.environmentId = event.environmentId;
        signal.workspaceId = event.workspaceId;
        signal.workspacePath = event.workspacePath;
        signal.supplyChainWorkspaceId = event.supplyChainWorkspaceId;
        signal.dependencySnapshotId = event.dependencySnapshotId;
        signal.vulnerabilityAssessmentId = event.vulnerabilityAssessmentId;
        signal.runtimeVulnerabilities = event.runtimeVulnerabilities == null
                ? new ArrayList<>()
                : new ArrayList<>(event.runtimeVulnerabilities);
        signal.agentCorrelationId = event.agentCorrelationId;
        signal.agentType = event.agentType;
        signal.sessionId = event.sessionId;
        signal.traceId = event.traceId;
        signal.eventKind = event.eventKind;
        signal.operation = event.operation;
        signal.resource = event.resource;
        signal.destination = event.destination;
        signal.subject = event.subject;
        signal.dangerous = event.dangerous;
        signal.sensitiveResource = event.sensitiveResource;
        signal.externalDestination = event.externalDestination;
        signal.failed = event.failed;
        signal.command = event.command;
        signal.executable = event.executable;
        signal.argvTruncated = event.argvTruncated;
        signal.argvSource = event.argvSource;
        signal.behaviorStage = event.behaviorStage;
        signal.platformRuntime = event.platformRuntime;
        signal.synthetic = event.synthetic;
        signal.processIdentity = event.processIdentity;
        return signal;
    }

    public static BehaviorSignal from(JudgmentUpdate judgment) {
        BehaviorSignal signal = new BehaviorSignal();
        signal.signalType = "judgment";
        signal.eventId = judgment.eventId;
        signal.eventTime = judgment.eventTime;
        signal.tenantId = judgment.tenantId;
        signal.environmentId = judgment.environmentId;
        signal.workspaceId = judgment.workspaceId;
        signal.workspacePath = judgment.workspacePath;
        signal.agentCorrelationId = judgment.agentCorrelationId;
        signal.agentType = judgment.agentType;
        signal.sessionId = judgment.sessionId;
        signal.traceId = judgment.traceId;
        signal.eventKind = judgment.eventKind;
        signal.subject = judgment.subject;
        signal.judgment = judgment;
        return signal;
    }

    public String episodeKey() {
        return value(tenantId) + ":" + value(environmentId) + ":" + value(agentCorrelationId)
                + ":" + (blank(sessionId) ? "no-session" : sessionId);
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }
}
