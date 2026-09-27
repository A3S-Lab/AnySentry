package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void legacyWindowBuilderDoesNotCreateSupplyChainCandidate() {
        RiskAnalysisBatch.Evidence component = vulnerableEvidence("medium");
        assertNull(EpisodeBuilderFunction.candidateType(List.of(
                component,
                evidence("shell_execution")
        )));
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

    @Test
    void eventAtAllowedLatenessBoundaryIsAccepted() {
        assertFalse(EpisodeBuilderFunction.tooLate(70_000L, 100_000L));
        assertTrue(EpisodeBuilderFunction.tooLate(69_999L, 100_000L));
    }

    @Test
    void episodeEvidenceIsSortedAndBoundedToFiveMinutes() {
        RiskAnalysisBatch.Evidence stale = evidence("credential_access", 99_999L);
        RiskAnalysisBatch.Evidence recent = evidence("transform", 100_000L);
        RiskAnalysisBatch.Evidence latest = evidence("external_egress", 400_000L);

        List<RiskAnalysisBatch.Evidence> bounded = EpisodeBuilderFunction.boundedEvidence(List.of(
                latest,
                stale,
                recent
        ));

        assertEquals(List.of(recent, latest), bounded);
    }

    private static RiskAnalysisBatch.Evidence evidence(String stage) {
        return evidence(stage, 0L);
    }

    private static RiskAnalysisBatch.Evidence evidence(String stage, long eventTime) {
        RiskAnalysisBatch.Evidence evidence = new RiskAnalysisBatch.Evidence();
        evidence.eventId = "evt-" + stage;
        evidence.behaviorStage = stage;
        evidence.eventTime = eventTime;
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
