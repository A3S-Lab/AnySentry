package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SupplyChainEnrichmentFunctionTest {
    @Test
    void matchesExplicitNodeModulesExecutionWithHighConfidence() {
        CanonicalEvent event = new CanonicalEvent();
        event.executable = "/workspace/node_modules/.bin/webpack";
        event.command = "/workspace/node_modules/.bin/webpack --version";
        SupplyChainRuntimeContext runtime = runtime("webpack", "5.98.0");
        assertTrue(SupplyChainEnrichmentFunction.explicitNodeModuleMatch(
                event,
                "webpack",
                "webpack"
        ), () -> "executable=[" + event.executable + "], direct="
                + event.executable.endsWith("/node_modules/.bin/webpack"));

        List<CanonicalEvent.RuntimeVulnerabilityMatch> matches =
                SupplyChainEnrichmentFunction.matches(event, runtime);

        assertEquals(1, matches.size(), "explicit executable=" + event.executable
                + ", findings=" + runtime.findings.size()
                + ", package=" + runtime.findings.get(0).packageName);
        assertEquals("high", matches.get(0).confidence);
        assertEquals("GHSA-test", matches.get(0).vulnerabilityId);
    }

    @Test
    void doesNotMatchPackageNameMentionInUnrelatedText() {
        CanonicalEvent event = new CanonicalEvent();
        event.executable = "printf";
        event.command = "printf 'webpack documentation'";

        assertTrue(SupplyChainEnrichmentFunction.matches(
                event,
                runtime("webpack", "5.98.0")
        ).isEmpty());
    }

    private static SupplyChainRuntimeContext runtime(String packageName, String version) {
        SupplyChainRuntimeContext runtime = new SupplyChainRuntimeContext();
        runtime.dependencySnapshotId = "deps-1";
        runtime.vulnerabilityAssessmentId = "va-1";
        SupplyChainRuntimeContext.Finding finding = new SupplyChainRuntimeContext.Finding();
        finding.findingId = "finding-1";
        finding.ecosystem = "npm";
        finding.packageName = packageName;
        finding.version = version;
        finding.vulnerabilityId = "GHSA-test";
        runtime.findings.add(finding);
        return runtime;
    }
}
