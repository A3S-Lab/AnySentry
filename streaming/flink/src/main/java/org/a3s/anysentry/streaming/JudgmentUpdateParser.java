package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.util.Collector;

public class JudgmentUpdateParser extends ProcessFunction<String, BehaviorSignal> {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public void processElement(String raw, Context context, Collector<BehaviorSignal> output) {
        try {
            JudgmentUpdate update = MAPPER.readValue(raw, JudgmentUpdate.class);
            if (!"anysentry.judgment_update.v1".equals(update.schemaVersion)
                    || blank(update.eventId)
                    || blank(update.agentCorrelationId)
                    || update.eventTime <= 0) {
                throw new IllegalArgumentException("judgment update is missing required fields");
            }
            output.collect(BehaviorSignal.from(update));
        } catch (Exception error) {
            context.output(CanonicalEventParser.DLQ, CanonicalEventParser.dlq(raw, error));
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
