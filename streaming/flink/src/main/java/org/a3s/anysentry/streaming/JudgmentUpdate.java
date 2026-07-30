package org.a3s.anysentry.streaming;

import java.io.Serializable;

public class JudgmentUpdate implements Serializable {
    public String schemaVersion;
    public String judgmentId;
    public String evaluationId;
    public String eventId;
    public long eventTime;
    public long publishedAt;
    public long revision;
    public String policyVersion;
    public String stage;
    public String status;
    public String verdict;
    public String severity;
    public String reason;
    public String riskCategory;
    public String riskName;
    public long latencyMs;
    public int attempt;
    public boolean awaitingL3;
    public String tenantId;
    public String environmentId;
    public String workspaceId;
    public String workspacePath;
    public String agentCorrelationId;
    public String agentType;
    public String sessionId;
    public String traceId;
    public String spanId;
    public String eventKind;
    public String subject;
}
