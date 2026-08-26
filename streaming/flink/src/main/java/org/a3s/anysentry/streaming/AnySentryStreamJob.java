package org.a3s.anysentry.streaming;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.serialization.SerializationSchema;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.RestartStrategyOptions;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.kafka.clients.consumer.OffsetResetStrategy;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

public final class AnySentryStreamJob {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private AnySentryStreamJob() {}

    public static void main(String[] args) throws Exception {
        String brokers = env("ANYSENTRY_STREAM_BOOTSTRAP_SERVERS", "kafka:9092");
        String canonicalTopic = env("ANYSENTRY_STREAM_CANONICAL_TOPIC", "anysentry.events.canonical.v1");
        String judgmentsTopic = env("ANYSENTRY_STREAM_JUDGMENTS_TOPIC", "anysentry.judgments.v1");
        String episodesTopic = env("ANYSENTRY_STREAM_EPISODES_TOPIC", "anysentry.risk-analysis-batches.v1");
        String findingsTopic = env("ANYSENTRY_STREAM_FINDINGS_TOPIC", "anysentry.stream.findings.v1");
        String dlqTopic = env("ANYSENTRY_STREAM_DLQ_TOPIC", "anysentry.stream.dlq.v1");
        String supplyChainContextTopic = env(
                "ANYSENTRY_SUPPLY_CHAIN_CONTEXT_TOPIC",
                "anysentry.supply-chain.context.v1"
        );
        String canonicalGroup = env("ANYSENTRY_FLINK_CANONICAL_GROUP", "anysentry-flink-shadow-v2");
        String judgmentsGroup = env("ANYSENTRY_FLINK_JUDGMENTS_GROUP", "anysentry-flink-judgments-v2");
        String startupMode = env("ANYSENTRY_FLINK_STARTUP_MODE", "latest");
        int parallelism = Integer.parseInt(env("ANYSENTRY_FLINK_PARALLELISM", "2"));
        boolean legacyCompositeEnabled = enabled(
                "ANYSENTRY_FLINK_LEGACY_COMPOSITE_ENABLED",
                false
        );

        Configuration configuration = new Configuration();
        configuration.set(RestartStrategyOptions.RESTART_STRATEGY, "fixed-delay");
        configuration.set(RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_ATTEMPTS, 10);
        configuration.set(RestartStrategyOptions.RESTART_STRATEGY_FIXED_DELAY_DELAY, Duration.ofSeconds(5));
        StreamExecutionEnvironment execution =
                StreamExecutionEnvironment.getExecutionEnvironment(configuration);
        execution.setParallelism(parallelism);
        execution.enableCheckpointing(30_000, CheckpointingMode.EXACTLY_ONCE);
        execution.getCheckpointConfig().setMinPauseBetweenCheckpoints(10_000);
        execution.getCheckpointConfig().setCheckpointTimeout(120_000);
        execution.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

        KafkaSource<String> source = KafkaSource.<String>builder()
                .setBootstrapServers(brokers)
                .setTopics(canonicalTopic)
                .setGroupId(canonicalGroup)
                .setStartingOffsets(startingOffsets(startupMode))
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();
        KafkaSource<String> judgmentSource = KafkaSource.<String>builder()
                .setBootstrapServers(brokers)
                .setTopics(judgmentsTopic)
                .setGroupId(judgmentsGroup)
                .setStartingOffsets(startingOffsets(startupMode))
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();
        KafkaSource<String> supplyChainContextSource = KafkaSource.<String>builder()
                .setBootstrapServers(brokers)
                .setTopics(supplyChainContextTopic)
                .setGroupId(env(
                        "ANYSENTRY_FLINK_SUPPLY_CHAIN_CONTEXT_GROUP",
                        "anysentry-flink-supply-chain-context-v1"
                ))
                .setStartingOffsets(OffsetsInitializer.earliest())
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();

        DataStream<String> raw = execution.fromSource(
                source,
                WatermarkStrategy.noWatermarks(),
                "canonical-events"
        );
        SingleOutputStreamOperator<CanonicalEvent> validatedCanonical = raw
                .process(new CanonicalEventParser())
                .name("canonical-schema-validation");
        SingleOutputStreamOperator<CanonicalEvent> canonical = validatedCanonical
                .assignTimestampsAndWatermarks(
                        WatermarkStrategy.<CanonicalEvent>forBoundedOutOfOrderness(Duration.ofSeconds(30))
                                .withTimestampAssigner((event, timestamp) -> event.eventTime)
                                .withIdleness(Duration.ofMinutes(1))
                );
        SingleOutputStreamOperator<BehaviorSignal> judgmentSignals = execution.fromSource(
                        judgmentSource,
                        WatermarkStrategy.noWatermarks(),
                        "judgment-updates"
                )
                .process(new JudgmentUpdateParser())
                .name("judgment-schema-validation");
        SingleOutputStreamOperator<SupplyChainRuntimeContext> supplyChainContexts =
                execution.fromSource(
                                supplyChainContextSource,
                                WatermarkStrategy.noWatermarks(),
                                "supply-chain-runtime-context"
                        )
                        .process(new SupplyChainRuntimeContextParser())
                        .name("supply-chain-context-validation");
        BroadcastStream<SupplyChainRuntimeContext> broadcastSupplyChainContexts =
                supplyChainContexts.broadcast(SupplyChainEnrichmentFunction.CONTEXT_STATE);
        SingleOutputStreamOperator<CanonicalEvent> enrichedCanonical = canonical
                .connect(broadcastSupplyChainContexts)
                .process(new SupplyChainEnrichmentFunction())
                .name("supply-chain-runtime-enrichment");

        DataStream<StreamFinding> findings = enrichedCanonical
                .filter(AnySentryStreamJob::profileRelevant)
                .name("profile-relevant-events")
                .keyBy(event -> event.agentCorrelationId)
                .process(new RiskCorrelationFunction())
                .name("risk-profile-and-composite-correlation");

        SingleOutputStreamOperator<RiskAnalysisBatch> episodes = enrichedCanonical
                .filter(AnySentryStreamJob::episodeRelevant)
                .name("episode-relevant-events")
                .map(BehaviorSignal::from)
                .name("canonical-behavior-signals")
                .union(judgmentSignals)
                .keyBy(BehaviorSignal::episodeKey)
                .process(new EpisodeBuilderFunction())
                .name("risk-analysis-episode-builder");
        SingleOutputStreamOperator<RiskAnalysisBatch> temporalEpisodes = enrichedCanonical
                .filter(AnySentryStreamJob::temporalRelevant)
                .name("temporal-relevant-events")
                .map(BehaviorSignal::from)
                .name("temporal-behavior-facts")
                .keyBy(BehaviorSignal::episodeKey)
                .process(new TemporalEpisodeBuilderFunction())
                .name("temporal-episode-v1-builder");
        SingleOutputStreamOperator<RiskAnalysisBatch> supplyChainTemporalEpisodes = enrichedCanonical
                .filter(AnySentryStreamJob::supplyChainTemporalRelevant)
                .name("supply-chain-temporal-relevant-events")
                .map(BehaviorSignal::from)
                .name("supply-chain-temporal-facts")
                .keyBy(BehaviorSignal::episodeKey)
                .process(new SupplyChainTemporalEpisodeBuilderFunction())
                .name("supply-chain-temporal-v2-builder");
        DataStream<RiskAnalysisBatch> allEpisodes = legacyCompositeEnabled
                ? episodes.union(temporalEpisodes, supplyChainTemporalEpisodes)
                : temporalEpisodes.union(supplyChainTemporalEpisodes);

        KafkaSink<StreamFinding> findingSink = KafkaSink.<StreamFinding>builder()
                .setBootstrapServers(brokers)
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                .setRecordSerializer(KafkaRecordSerializationSchema.<StreamFinding>builder()
                        .setTopic(findingsTopic)
                        .setKeySerializationSchema(new FindingKeySerializationSchema())
                        .setValueSerializationSchema(new FindingValueSerializationSchema())
                        .build())
                .build();
        findings.sinkTo(findingSink).name("stream-findings");

        KafkaSink<RiskAnalysisBatch> episodeSink = KafkaSink.<RiskAnalysisBatch>builder()
                .setBootstrapServers(brokers)
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                .setRecordSerializer(KafkaRecordSerializationSchema.<RiskAnalysisBatch>builder()
                        .setTopic(episodesTopic)
                        .setKeySerializationSchema(new EpisodeKeySerializationSchema())
                        .setValueSerializationSchema(new EpisodeValueSerializationSchema())
                        .build())
                .build();
        allEpisodes.sinkTo(episodeSink).name("risk-analysis-batches");

        KafkaSink<String> dlqSink = KafkaSink.<String>builder()
                .setBootstrapServers(brokers)
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic(dlqTopic)
                        .setValueSerializationSchema(new SimpleStringSchema())
                        .build())
                .build();
        validatedCanonical.getSideOutput(CanonicalEventParser.DLQ)
                .union(
                        judgmentSignals.getSideOutput(CanonicalEventParser.DLQ),
                        supplyChainContexts.getSideOutput(CanonicalEventParser.DLQ),
                        episodes.getSideOutput(EpisodeBuilderFunction.LATE_EVENTS),
                        temporalEpisodes.getSideOutput(TemporalEpisodeBuilderFunction.REJECTED_FACTS),
                        supplyChainTemporalEpisodes.getSideOutput(
                                SupplyChainTemporalEpisodeBuilderFunction.REJECTED_FACTS
                        )
                )
                .sinkTo(dlqSink)
                .name("stream-dlq");

        execution.execute("AnySentry Flink Shadow Risk");
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static boolean enabled(String key, boolean fallback) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) return fallback;
        return "1".equals(value)
                || "true".equalsIgnoreCase(value)
                || "on".equalsIgnoreCase(value)
                || "yes".equalsIgnoreCase(value);
    }

    private static OffsetsInitializer startingOffsets(String mode) {
        if ("earliest".equalsIgnoreCase(mode)) {
            return OffsetsInitializer.earliest();
        }
        return OffsetsInitializer.committedOffsets(OffsetResetStrategy.LATEST);
    }

    static boolean episodeRelevant(CanonicalEvent event) {
        if (event.platformRuntime || event.behaviorStage == null) return false;
        return switch (event.behaviorStage) {
            case "credential_access", "staging", "transform", "external_egress",
                    "dangerous_exec", "destructive_action" -> true;
            default -> false;
        };
    }

    static boolean profileRelevant(CanonicalEvent event) {
        return RiskCorrelationFunction.relevant(event);
    }

    private static boolean temporalRelevant(CanonicalEvent event) {
        if (event.platformRuntime || event.failed || event.operation == null) return false;
        return switch (event.operation) {
            case "download", "file_write", "chmod", "execute", "encode", "compress",
                    "persistence_activate", "sandbox_probe", "privilege_change",
                    "target_discovery", "destroy", "remote_connect", "remote_execute",
                    "remote_copy" -> true;
            case "file_read" -> event.sensitiveResource;
            case "egress" -> event.externalDestination;
            default -> false;
        };
    }

    private static boolean supplyChainTemporalRelevant(CanonicalEvent event) {
        if (event.platformRuntime || event.failed) return false;
        return SupplyChainTemporalMatcher.relevant(BehaviorSignal.from(event));
    }

    private static final class FindingKeySerializationSchema
            implements SerializationSchema<StreamFinding> {
        @Override
        public byte[] serialize(StreamFinding finding) {
            return finding.agentCorrelationId.getBytes(StandardCharsets.UTF_8);
        }
    }

    private static final class FindingValueSerializationSchema
            implements SerializationSchema<StreamFinding> {
        @Override
        public byte[] serialize(StreamFinding finding) {
            try {
                return MAPPER.writeValueAsBytes(finding);
            } catch (Exception error) {
                throw new IllegalArgumentException("finding serialization failed", error);
            }
        }
    }

    private static final class EpisodeKeySerializationSchema
            implements SerializationSchema<RiskAnalysisBatch> {
        @Override
        public byte[] serialize(RiskAnalysisBatch batch) {
            return batch.agentCorrelationId.getBytes(StandardCharsets.UTF_8);
        }
    }

    private static final class EpisodeValueSerializationSchema
            implements SerializationSchema<RiskAnalysisBatch> {
        @Override
        public byte[] serialize(RiskAnalysisBatch batch) {
            try {
                return MAPPER.writeValueAsBytes(batch);
            } catch (Exception error) {
                throw new IllegalArgumentException("episode serialization failed", error);
            }
        }
    }
}
