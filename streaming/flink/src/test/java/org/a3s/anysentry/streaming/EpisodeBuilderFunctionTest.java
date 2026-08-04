package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EpisodeBuilderFunctionTest {
    @Test
    void repeatedSingleStageDoesNotCreateCompositeCandidate() {
        assertNull(EpisodeBuilderFunction.candidateType(List.of(
                evidence("dangerous_exec"),
                evidence("dangerous_exec"),
                evidence("dangerous_exec")
        )));
    }

    @Test
    void complementaryStagesCreateTypedCandidate() {
        assertEquals("sensitive_data_egress", EpisodeBuilderFunction.candidateType(List.of(
                evidence("credential_access"),
                evidence("external_egress")
        )));
        assertEquals("sensitive_data_staging", EpisodeBuilderFunction.candidateType(List.of(
                evidence("credential_access"),
                evidence("transform")
        )));
    }

    @Test
    void technicalEscalationCannotSeedAnEpisode() {
        JudgmentUpdate judgment = new JudgmentUpdate();
        judgment.status = "succeeded";
        judgment.verdict = "escalate";
        judgment.reason = "L2 unavailable: timed out reading response";
        assertTrue(EpisodeBuilderFunction.technicalJudgment(judgment));
    }

    @Test
    void vulnerableComponentWithAmbiguousFollowUpUsesCompositeJudge() {
        RiskAnalysisBatch.Evidence component = vulnerableEvidence("medium");
        assertEquals("known_vulnerability_exploitation", EpisodeBuilderFunction.candidateType(List.of(
                component,
                evidence("shell_execution")
        )));
        assertEquals("composite_judge", EpisodeBuilderFunction.decisionPath(List.of(
                component,
                evidence("shell_execution")
        ), "known_vulnerability_exploitation"));
    }

    @Test
    void completeHighConfidenceSupplyChainUsesDeterministicRule() {
        RiskAnalysisBatch.Evidence component = vulnerableEvidence("high");
        RiskAnalysisBatch.Evidence dangerous = evidence("dangerous_exec");
        RiskAnalysisBatch.Evidence sensitive = evidence("credential_access");
        RiskAnalysisBatch.Evidence egress = evidence("external_egress");
        assertEquals("deterministic_rule", EpisodeBuilderFunction.decisionPath(List.of(
                component,
                dangerous,
                sensitive,
                egress
        ), "known_vulnerability_exploitation"));
    }

    private static RiskAnalysisBatch.Evidence evidence(String stage) {
        RiskAnalysisBatch.Evidence evidence = new RiskAnalysisBatch.Evidence();
        evidence.eventId = "evt-" + stage;
        evidence.behaviorStage = stage;
        return evidence;
    }

    private static RiskAnalysisBatch.Evidence vulnerableEvidence(String confidence) {
        RiskAnalysisBatch.Evidence evidence = evidence("vulnerable_component_execution");
        CanonicalEvent.RuntimeVulnerabilityMatch match = new CanonicalEvent.RuntimeVulnerabilityMatch();
        match.findingId = "finding-1";
        match.vulnerabilityId = "GHSA-test";
        match.confidence = confidence;
        evidence.runtimeVulnerabilities.add(match);
        return evidence;
    }
}
