package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;

public class CanonicalEventParser extends ProcessFunction<String, CanonicalEvent> {
    public static final OutputTag<String> DLQ = new OutputTag<>("stream-dlq", TypeInformation.of(String.class));
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    @Override
    public void processElement(String raw, Context context, Collector<CanonicalEvent> output) {
        try {
            output.collect(parse(raw));
        } catch (Exception error) {
            context.output(DLQ, dlq(raw, error));
        }
    }

    static CanonicalEvent parse(String raw) throws Exception {
        JsonNode document = MAPPER.readTree(raw);
        if (document == null || !document.isObject()) {
            throw new IllegalArgumentException("canonical event must be a JSON object");
        }

        // The reader deliberately ignores additive fields so producers can roll out
        // correlation metadata before Flink consumes it. The legacy POJO remains the
        // state payload, and its existing contract is still validated after binding.
        CanonicalEvent event = MAPPER.treeToValue(document, CanonicalEvent.class);
        if (!"anysentry.canonical_event.v1".equals(event.schemaVersion)
                || blank(event.eventId)
                || blank(event.agentCorrelationId)
                || event.eventTime <= 0) {
            throw new IllegalArgumentException("canonical event is missing required fields");
        }
        return event;
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    public static String dlq(String raw, Exception error) {
        String digest;
        try {
            digest = HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8))
            ).substring(0, 24);
        } catch (Exception ignored) {
            digest = "unavailable";
        }
        return "{\"schemaVersion\":\"anysentry.stream_dlq.v1\","
                + "\"failedAt\":\"" + Instant.now() + "\","
                + "\"payloadDigest\":\"" + digest + "\","
                + "\"error\":\"" + json(error.getMessage()) + "\"}";
    }

    private static String json(String value) {
        return (value == null ? "unknown" : value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", " ")
                .substring(0, Math.min(value == null ? 7 : value.length(), 300));
    }
}
