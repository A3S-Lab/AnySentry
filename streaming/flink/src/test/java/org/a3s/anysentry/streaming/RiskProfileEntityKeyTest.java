package org.a3s.anysentry.streaming;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class RiskProfileEntityKeyTest {
    @Test
    void keepsDifferentRuntimeWindowsIndependent() {
        CanonicalEvent firstWindow = event("agc_shared", "agi_window_one");
        CanonicalEvent secondWindow = event("agc_shared", "agi_window_two");

        assertNotEquals(
                AnySentryStreamJob.riskProfileEntityKey(firstWindow),
                AnySentryStreamJob.riskProfileEntityKey(secondWindow)
        );
    }

    @Test
    void keepsEventsFromOneRuntimeWindowTogether() {
        CanonicalEvent firstEvent = event("agc_shared", "agi_window_one");
        CanonicalEvent laterEvent = event("agc_shared", "agi_window_one");

        assertEquals(
                AnySentryStreamJob.riskProfileEntityKey(firstEvent),
                AnySentryStreamJob.riskProfileEntityKey(laterEvent)
        );
    }

    @Test
    void fallsBackToLogicalAgentForLegacyEvents() {
        CanonicalEvent legacy = event("agc_legacy", "");

        assertEquals("agc_legacy", AnySentryStreamJob.riskProfileEntityKey(legacy));
    }

    private static CanonicalEvent event(String correlationId, String instanceId) {
        CanonicalEvent event = new CanonicalEvent();
        event.agentCorrelationId = correlationId;
        event.agentInstanceId = instanceId;
        return event;
    }
}
