package org.a3s.anysentry.streaming;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

public class CanonicalEvent implements Serializable {
    public String schemaVersion;
    public String eventId;
    public String sourceEventId;
    public String sourceRecordId;
    public long eventTime;
    public long receivedAt;
    public String tenantId;
    public String environmentId;
    public String workspaceId;
    public String workspacePath;
    public String workspacePathFingerprint;
    public String trustedSourceId;
    public String claimedAgentId;
    public String agentType;
    public String agentInstanceId;
    public String agentCorrelationId;
    public String sessionId;
    public String traceId;
    public String spanId;
    public String eventKind;
    public String operation;
    public String resourceType;
    public String resource;
    public String destination;
    public boolean sensitiveResource;
    public boolean externalDestination;
    public boolean dangerous;
    public boolean failed;
    public String subject;
    public String command;
    public String executable;
    public boolean argvTruncated;
    public String argvSource;
    public String behaviorStage;
    public boolean platformRuntime;
    public boolean synthetic;
    public ProcessIdentity processIdentity;
    public FileIdentity fileIdentity;
    public String supplyChainWorkspaceId;
    public String dependencySnapshotId;
    public String vulnerabilityAssessmentId;
    public List<RuntimeVulnerabilityMatch> runtimeVulnerabilities = new ArrayList<>();

    public static class ProcessIdentity implements Serializable {
        public String hostId;
        public String bootId;
        public String containerId;
        public String cgroupId;
        public Integer pid;
        public Integer ppid;
        public Integer rootPid;
        public String rootStartTime;
        public String startTimeTicks;
        public String startTimeNs;
        public Long mountNamespace;
        public String processInstanceId;
        public String identityConfidence;
    }

    public static class FileIdentity implements Serializable {
        public String fileInstanceId;
        public String path;
        public String device;
        public String inode;
        public Long mountNamespace;
        public String identityBasis;
        public String identityConfidence;
    }

    public static class RuntimeVulnerabilityMatch implements Serializable {
        public String findingId;
        public String dependencySnapshotId;
        public String vulnerabilityAssessmentId;
        public String ecosystem;
        public String packageName;
        public String version;
        public String vulnerabilityId;
        public List<String> aliases = new ArrayList<>();
        public String confidence;
        public String matchBasis;
    }
}
