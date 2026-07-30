package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.util.Collector;

public class SupplyChainRuntimeContextParser
        extends ProcessFunction<String, SupplyChainRuntimeContext> {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public void processElement(
            String raw,
            Context context,
            Collector<SupplyChainRuntimeContext> output
    ) {
        try {
            SupplyChainRuntimeContext value =
                    MAPPER.readValue(raw, SupplyChainRuntimeContext.class);
            if (!"anysentry.supply_chain_runtime_context.v1".equals(value.schemaVersion)
                    || blank(value.workspaceId)
                    || blank(value.workspacePathFingerprint)
                    || blank(value.dependencySnapshotId)
                    || blank(value.vulnerabilityAssessmentId)
                    || !"complete".equals(value.assessmentStatus)) {
                throw new IllegalArgumentException(
                        "supply-chain runtime context is missing required fields"
                );
            }
            output.collect(value);
        } catch (Exception error) {
            context.output(CanonicalEventParser.DLQ, CanonicalEventParser.dlq(raw, error));
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
