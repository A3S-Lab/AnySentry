package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.TimeDomain;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class TemporalEpisodeBuilderFunction
        extends KeyedProcessFunction<String, BehaviorSignal, RiskAnalysisBatch> {
    static final int MAX_ACTIVE_FILE_CANDIDATES = 8;
    static final int MAX_AMBIGUOUS_CANDIDATES = 8;
    static final int MAX_FACTS = 64;
    static final long ALLOWED_LATENESS_MS = 30_000L;
    static final long AMBIGUOUS_SETTLE_MS = 30_000L;
    public static final OutputTag<String> REJECTED_FACTS =
            new OutputTag<>("temporal-episode-rejected-facts", TypeInformation.of(String.class));

    private transient MapState<String, BehaviorSignal> facts;
    private transient MapState<String, Boolean> emittedEpisodes;
    private transient MapState<String, Boolean> matchedCandidates;
    private transient MapState<String, Boolean> matchedTerminals;
    private transient MapState<String, Boolean> activeFiles;
    private transient MapState<String, Long> pendingAmbiguousCandidates;
    private transient ValueState<Long> maximumEventTime;

    @Override
    public void open(OpenContext openContext) throws Exception {
        StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofMinutes(30))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .build();
        facts = mapState("temporal-facts", BehaviorSignal.class, ttl);
        emittedEpisodes = mapState("temporal-emitted-episodes", Boolean.class, ttl);
        matchedCandidates = mapState("temporal-matched-candidates", Boolean.class, ttl);
        matchedTerminals = mapState("temporal-matched-terminals", Boolean.class, ttl);
        activeFiles = mapState("temporal-active-files", Boolean.class, ttl);
        pendingAmbiguousCandidates = mapState("temporal-pending-ambiguous", Long.class, ttl);
        ValueStateDescriptor<Long> maximumDescriptor =
                new ValueStateDescriptor<>("temporal-maximum-event-time", Long.class);
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
        if (!relevant(signal) || facts.contains(signal.eventId)) return;
        long maximum = value(maximumEventTime.value());
        if (maximum > 0 && signal.eventTime < maximum - ALLOWED_LATENESS_MS) {
            reject(context, signal, "event exceeded temporal allowed lateness");
            return;
        }

        String fileId = fileId(signal);
        if (boundedFileCandidate(signal) && !fileId.isBlank() && !activeFiles.contains(fileId)) {
            if (!candidateSeed(signal)) return;
            if (stateSize(activeFiles) >= MAX_ACTIVE_FILE_CANDIDATES) {
                reject(context, signal, "active temporal file candidate limit exceeded");
                return;
            }
            activeFiles.put(fileId, true);
        }

        facts.put(signal.eventId, signal);
        maximum = Math.max(maximum, signal.eventTime);
        maximumEventTime.update(maximum);
        prune(maximum - TemporalEpisodeMatcher.WINDOW_MS - ALLOWED_LATENESS_MS);
        boundFacts();
        context.timerService().registerEventTimeTimer(
                signal.eventTime + TemporalEpisodeMatcher.WINDOW_MS + ALLOWED_LATENESS_MS
        );

        List<BehaviorSignal> snapshot = factList();
        emitDeterministicMatches(context.getCurrentKey(), snapshot, output);
        for (TemporalEpisodeMatcher.Match match : TemporalEpisodeMatcher.ambiguous(snapshot)) {
            String terminalKey = match.terminalCompletionKey();
            if (matchedCandidates.contains(match.candidateCompletionKey())
                    || matchedTerminals.contains(terminalKey)
                    || pendingAmbiguousCandidates.contains(terminalKey)) continue;
            if (stateSize(pendingAmbiguousCandidates) >= MAX_AMBIGUOUS_CANDIDATES) {
                reject(context, signal, "active ambiguous temporal candidate limit exceeded");
                break;
            }
            long dueAt = context.timerService().currentProcessingTime() + AMBIGUOUS_SETTLE_MS;
            pendingAmbiguousCandidates.put(terminalKey, dueAt);
            context.timerService().registerProcessingTimeTimer(dueAt);
        }
    }

    @Override
    public void onTimer(
            long timestamp,
            OnTimerContext context,
            Collector<RiskAnalysisBatch> output
    ) throws Exception {
        if (context.timeDomain() == TimeDomain.PROCESSING_TIME) {
            List<BehaviorSignal> snapshot = factList();
            emitDeterministicMatches(context.getCurrentKey(), snapshot, output);
            Map<String, TemporalEpisodeMatcher.Match> ambiguous = new java.util.HashMap<>();
            for (TemporalEpisodeMatcher.Match match : TemporalEpisodeMatcher.ambiguous(snapshot)) {
                ambiguous.put(match.terminalCompletionKey(), match);
            }
            List<String> dueKeys = new ArrayList<>();
            for (java.util.Map.Entry<String, Long> entry : pendingAmbiguousCandidates.entries()) {
                if (entry.getValue() <= timestamp) dueKeys.add(entry.getKey());
            }
            for (String terminalKey : dueKeys) {
                pendingAmbiguousCandidates.remove(terminalKey);
                if (matchedTerminals.contains(terminalKey)) continue;
                TemporalEpisodeMatcher.Match match = ambiguous.get(terminalKey);
                if (match != null) emitMatch(context.getCurrentKey(), match, output);
            }
            return;
        }
        prune(timestamp - TemporalEpisodeMatcher.WINDOW_MS - ALLOWED_LATENESS_MS);
    }

    private void emitDeterministicMatches(
            String currentKey,
            List<BehaviorSignal> snapshot,
            Collector<RiskAnalysisBatch> output
    ) throws Exception {
        for (TemporalEpisodeMatcher.Match match : TemporalEpisodeMatcher.match(snapshot)) {
            pendingAmbiguousCandidates.remove(match.terminalCompletionKey());
            emitMatch(currentKey, match, output);
        }
    }

    private void emitMatch(
            String currentKey,
            TemporalEpisodeMatcher.Match match,
            Collector<RiskAnalysisBatch> output
    ) throws Exception {
        if (matchedCandidates.contains(match.candidateCompletionKey())
                || matchedTerminals.contains(match.terminalCompletionKey())) return;
        RiskAnalysisBatch batch = batch(currentKey, match);
        if (!emittedEpisodes.contains(batch.episodeId)) {
            emittedEpisodes.put(batch.episodeId, true);
            output.collect(batch);
        }
        matchedCandidates.put(match.candidateCompletionKey(), true);
        matchedTerminals.put(match.terminalCompletionKey(), true);
    }

    private void prune(long threshold) throws Exception {
        if (threshold <= 0) return;
        List<String> expired = new ArrayList<>();
        for (BehaviorSignal signal : facts.values()) {
            if (signal.eventTime < threshold) expired.add(signal.eventId);
        }
        for (String eventId : expired) facts.remove(eventId);
        rebuildActiveFiles();
    }

    private void boundFacts() throws Exception {
        List<BehaviorSignal> ordered = factList();
        if (ordered.size() <= MAX_FACTS) return;
        int remove = ordered.size() - MAX_FACTS;
        for (int index = 0; index < remove; index += 1) {
            facts.remove(ordered.get(index).eventId);
        }
        rebuildActiveFiles();
    }

    private void rebuildActiveFiles() throws Exception {
        Set<String> retained = new HashSet<>();
        for (BehaviorSignal signal : facts.values()) {
            String fileId = fileId(signal);
            if (!fileId.isBlank() && candidateSeed(signal)) retained.add(fileId);
        }
        activeFiles.clear();
        for (String fileId : retained) activeFiles.put(fileId, true);
    }

    private List<BehaviorSignal> factList() throws Exception {
        List<BehaviorSignal> result = new ArrayList<>();
        for (BehaviorSignal signal : facts.values()) result.add(signal);
        result.sort(Comparator.comparingLong((BehaviorSignal signal) -> signal.eventTime)
                .thenComparing(signal -> value(signal.eventId)));
        return result;
    }

    private RiskAnalysisBatch batch(
            String currentKey,
            TemporalEpisodeMatcher.Match match
    ) {
        List<BehaviorSignal> signals = match.evidence();
        BehaviorSignal source = signals.get(0);
        List<String> eventIds = signals.stream().map(signal -> signal.eventId).toList();
        RiskAnalysisBatch batch = new RiskAnalysisBatch();
        batch.episodeId = hash(
                "tep",
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
        batch.decisionPath = match.decisionPath();
        batch.ruleVersion = v2Candidate(match.candidateType())
                ? "temporal-episode-v2"
                : "temporal-episode-v1";
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

    private static boolean relevant(BehaviorSignal signal) {
        if (signal == null
                || !"event".equals(signal.signalType)
                || signal.platformRuntime
                || signal.failed
                || signal.eventId == null
                || signal.eventId.isBlank()) return false;
        return switch (value(signal.operation)) {
            case "download", "file_write", "chmod", "execute", "encode", "compress",
                    "persistence_activate", "remote_connect", "remote_execute", "remote_copy" ->
                    !fileId(signal).isBlank();
            case "file_read" -> signal.sensitiveResource && !fileId(signal).isBlank();
            case "egress" -> signal.externalDestination;
            case "sandbox_probe", "privilege_change", "target_discovery", "destroy" -> true;
            default -> false;
        };
    }

    private static boolean opensCandidate(BehaviorSignal signal) {
        return "download".equals(signal.operation)
                || ("file_read".equals(signal.operation) && signal.sensitiveResource)
                || ("file_write".equals(signal.operation)
                && "persistence_write".equals(signal.behaviorStage));
    }

    private static boolean candidateSeed(BehaviorSignal signal) {
        if (opensCandidate(signal)) return true;
        String path = signal.fileIdentity == null ? "" : value(signal.fileIdentity.path);
        return path.startsWith("/tmp/")
                || path.startsWith("/var/tmp/")
                || path.startsWith("/dev/shm/");
    }

    private static boolean boundedFileCandidate(BehaviorSignal signal) {
        return switch (value(signal.operation)) {
            case "target_discovery", "destroy", "sandbox_probe", "privilege_change" -> false;
            default -> true;
        };
    }

    private static boolean v2Candidate(String candidateType) {
        return "persistence_installation".equals(candidateType)
                || "sandbox_privilege_breakout".equals(candidateType)
                || "destructive_behavior".equals(candidateType)
                || "lateral_movement".equals(candidateType);
    }

    private static String fileId(BehaviorSignal signal) {
        return signal.fileIdentity == null ? "" : value(signal.fileIdentity.fileInstanceId);
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
            throw new IllegalStateException("temporal episode hash failed", error);
        }
    }
}
