package org.a3s.anysentry.streaming;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

public class SupplyChainRuntimeContext implements Serializable {
    public String schemaVersion;
    public String workspaceId;
    public String workspacePathFingerprint;
    public String dependencySnapshotId;
    public String vulnerabilityAssessmentId;
    public long assessedAt;
    public String assessmentStatus;
    public String intelligenceRevision;
    public List<Finding> findings = new ArrayList<>();
    public boolean shadow;

    public static class Finding implements Serializable {
        public String findingId;
        public String ecosystem;
        public String packageName;
        public String version;
        public String dependencyScope;
        public Boolean direct;
        public String purl;
        public String vulnerabilityId;
        public List<String> aliases = new ArrayList<>();
        public String summary;
    }
}
