package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;

public class SupplyChainTemporalEpisodeBuilderFunction
        extends KeyedProcessFunction<String, BehaviorSignal, RiskAnalysisBatch> {
    static final int MAX_ACTIVE_SEEDS = 8;
    static final int MAX_FACTS = 64;
    static final long ALLOWED_LATENESS_MS = 30_000L;
    public static final OutputTag<String> REJECTED_FACTS =
            new OutputTag<>("supply-chain-temporal-rejected-facts", TypeInformation.of(String.class));

    private transient MapState<String, BehaviorSignal> facts;
    private transient MapState<String, Boolean> activeSeeds;
    private transient MapState<String, Boolean> emittedEpisodes;
    private transient MapState<String, Boolean> matchedCandidates;
    private transient MapState<String, Boolean> matchedTerminals;
    private transient ValueState<Long> maximumEventTime;

    @Override
    public void open(OpenContext openContext) throws Exception {
        StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofMinutes(30))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .build();
        facts = mapState("supply-chain-temporal-facts", BehaviorSignal.class, ttl);
        activeSeeds = mapState("supply-chain-temporal-active-seeds", Boolean.class, ttl);
        emittedEpisodes = mapState("supply-chain-temporal-emitted-episodes", Boolean.class, ttl);
        matchedCandidates = mapState("supply-chain-temporal-matched-candidates", Boolean.class, ttl);
        matchedTerminals = mapState("supply-chain-temporal-matched-terminals", Boolean.class, ttl);
        ValueStateDescriptor<Long> maximumDescriptor =
                new ValueStateDescriptor<>("supply-chain-temporal-maximum-event-time", Long.class);
        maximumDescriptor.enableTimeToLive(ttl);
        maximumEventTime = getRuntimeContext().getState(maximumDescriptor);
    }

    private <T> MapState<String, T> mapState(
            String name,
            Class<T> type,
            StateTtlConfig ttl
    ) {
        MapStateDescriptor<String, T> descriptor =
                new MapStateDescriptor<>(name, String.class, type);
        descriptor.enableTimeToLive(ttl);
        return getRuntimeContext().getMapState(descriptor);
    }

    @Override
    public void processElement(
            BehaviorSignal signal,
            Context context,
            Collector<RiskAnalysisBatch> output
    ) throws Exception {
        if (!valid(signal) || facts.contains(signal.eventId)) return;
        long maximum = value(maximumEventTime.value());
        if (maximum > 0 && signal.eventTime < maximum - ALLOWED_LATENESS_MS) {
            reject(context, signal, "event exceeded supply-chain temporal allowed lateness");
            return;
        }

        if (SupplyChainTemporalMatcher.vulnerableExecution(signal)) {
            String seedKey = seedKey(signal);
            if (!activeSeeds.contains(seedKey) && stateSize(activeSeeds) >= MAX_ACTIVE_SEEDS) {
                reject(context, signal, "active vulnerable component candidate limit exceeded");
                return;
            }
            activeSeeds.put(seedKey, true);
        }

        facts.put(signal.eventId, signal);
        maximum = Math.max(maximum, signal.eventTime);
        maximumEventTime.update(maximum);
        prune(maximum - SupplyChainTemporalMatcher.WINDOW_MS - ALLOWED_LATENESS_MS);
        boundFacts();
        context.timerService().registerEventTimeTimer(
                signal.eventTime + SupplyChainTemporalMatcher.WINDOW_MS + ALLOWED_LATENESS_MS
        );

        for (SupplyChainTemporalMatcher.Match match : SupplyChainTemporalMatcher.match(factList())) {
            if (matchedCandidates.contains(match.candidateCompletionKey())
                    || matchedTerminals.contains(match.terminalCompletionKey())) continue;
            RiskAnalysisBatch batch = batch(context.getCurrentKey(), match);
            matchedCandidates.put(match.candidateCompletionKey(), true);
            matchedTerminals.put(match.terminalCompletionKey(), true);
            if (emittedEpisodes.contains(batch.episodeId)) continue;
            emittedEpisodes.put(batch.episodeId, true);
            output.collect(batch);
        }
    }

    @Override
    public void onTimer(
            long timestamp,
            OnTimerContext context,
            Collector<RiskAnalysisBatch> output
    ) throws Exception {
        prune(timestamp - SupplyChainTemporalMatcher.WINDOW_MS - ALLOWED_LATENESS_MS);
    }

    private RiskAnalysisBatch batch(
            String currentKey,
            SupplyChainTemporalMatcher.Match match
    ) {
        List<BehaviorSignal> signals = match.evidence();
        BehaviorSignal source = signals.get(0);
        List<String> eventIds = signals.stream().map(signal -> signal.eventId).toList();
        RiskAnalysisBatch batch = new RiskAnalysisBatch();
        batch.episodeId = hash(
                "ste",
                currentKey,
                match.candidateType(),
                match.correlationEntityId(),
                String.join("|", eventIds)
        );
        batch.revision = 1;
        batch.evidenceFingerprint = hash("evidence", String.join("|", eventIds));
        batch.triggerReason = "pattern_match";
        batch.tenantId = source.tenantId;
        batch.environmentId = source.environmentId;
        batch.workspaceId = source.workspaceId;
        batch.workspacePath = source.workspacePath;
        batch.agentCorrelationId = source.agentCorrelationId;
        batch.agentType = source.agentType;
        batch.sessionId = source.sessionId;
        batch.windowStart = signals.get(0).eventTime;
        batch.windowEnd = signals.get(signals.size() - 1).eventTime;
        batch.generatedAt = System.currentTimeMillis();
        batch.candidateType = match.candidateType();
        batch.decisionPath = "strong".equals(match.evidenceConfidence())
                ? "deterministic_rule"
                : "composite_judge";
        batch.ruleVersion = "supply-chain-temporal-v2";
        batch.evidenceConfidence = match.evidenceConfidence();
        batch.synthetic = signals.stream().anyMatch(signal -> signal.synthetic);
        LinkedHashSet<String> traces = new LinkedHashSet<>();
        for (BehaviorSignal signal : signals) {
            batch.evidence.add(RiskAnalysisBatch.Evidence.from(signal));
            if (signal.traceId != null && !signal.traceId.isBlank()) traces.add(signal.traceId);
        }
        batch.traceIds.addAll(traces);
        return batch;
    }

    private void prune(long threshold) throws Exception {
        if (threshold <= 0) return;
        List<String> expired = new ArrayList<>();
        for (BehaviorSignal signal : facts.values()) {
            if (signal.eventTime < threshold) expired.add(signal.eventId);
        }
        for (String eventId : expired) facts.remove(eventId);
        rebuildActiveSeeds();
    }

    private void boundFacts() throws Exception {
        List<BehaviorSignal> ordered = factList();
        if (ordered.size() <= MAX_FACTS) return;
        int remove = ordered.size() - MAX_FACTS;
        for (int index = 0; index < remove; index += 1) {
            facts.remove(ordered.get(index).eventId);
        }
        rebuildActiveSeeds();
    }

    private void rebuildActiveSeeds() throws Exception {
        activeSeeds.clear();
        for (BehaviorSignal signal : facts.values()) {
            if (SupplyChainTemporalMatcher.vulnerableExecution(signal)) {
                activeSeeds.put(seedKey(signal), true);
            }
        }
    }

    private List<BehaviorSignal> factList() throws Exception {
        List<BehaviorSignal> result = new ArrayList<>();
        for (BehaviorSignal signal : facts.values()) result.add(signal);
        result.sort(Comparator.comparingLong((BehaviorSignal signal) -> signal.eventTime)
                .thenComparing(signal -> value(signal.eventId)));
        return result;
    }

    private static boolean valid(BehaviorSignal signal) {
        return signal != null
                && "event".equals(signal.signalType)
                && !signal.platformRuntime
                && !signal.failed
                && signal.eventId != null
                && !signal.eventId.isBlank()
                && SupplyChainTemporalMatcher.relevant(signal);
    }

    private static String seedKey(BehaviorSignal signal) {
        String processId = signal.processIdentity == null
                ? ""
                : value(signal.processIdentity.processInstanceId);
        String findingId = signal.runtimeVulnerabilities.stream()
                .map(match -> value(match.findingId))
                .sorted()
                .reduce((left, right) -> left + "|" + right)
                .orElse("");
        return processId + "\0" + findingId + "\0" + value(signal.eventId);
    }

    private static <T> int stateSize(MapState<String, T> state) throws Exception {
        int count = 0;
        for (String ignored : state.keys()) count += 1;
        return count;
    }

    private void reject(Context context, BehaviorSignal signal, String reason) {
        context.output(
                REJECTED_FACTS,
                CanonicalEventParser.dlq(
                        value(signal.eventId),
                        new IllegalArgumentException(reason)
                )
        );
    }

    private static long value(Long value) {
        return value == null ? 0 : value;
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }

    private static String hash(String prefix, String... parts) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String part : parts) {
                digest.update(value(part).getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
            }
            return prefix + "_" + HexFormat.of().formatHex(digest.digest()).substring(0, 24);
        } catch (Exception error) {
            throw new IllegalStateException("supply-chain temporal episode hash failed", error);
        }
    }
}
