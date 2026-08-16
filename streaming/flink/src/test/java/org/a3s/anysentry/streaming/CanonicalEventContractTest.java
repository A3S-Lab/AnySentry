package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class CanonicalEventContractTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void parsesApiProcessIdentityRootStartTime() throws Exception {
        String payload = """
                {
                  "schemaVersion": "anysentry.canonical_event.v1",
                  "eventId": "evt-root-start-time",
                  "eventTime": 1786818000000,
                  "agentCorrelationId": "agc-root-start-time",
                  "processIdentity": {
                    "hostId": "host-1",
                    "bootId": "boot-1",
                    "pid": 4242,
                    "rootPid": 4200,
                    "rootStartTime": "1786817999000",
                    "startTimeTicks": "123456",
                    "processInstanceId": "pri-root-start-time",
                    "identityConfidence": "strong"
                  }
                }
                """;

        CanonicalEvent event = MAPPER.readValue(payload, CanonicalEvent.class);

        assertNotNull(event.processIdentity);
        assertEquals("1786817999000", event.processIdentity.rootStartTime);
        assertEquals("123456", event.processIdentity.startTimeTicks);
    }
}
