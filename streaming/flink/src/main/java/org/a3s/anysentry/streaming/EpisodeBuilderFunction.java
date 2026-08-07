package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.TimerService;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

public class EpisodeBuilderFunction extends KeyedProcessFunction<String, BehaviorSignal, RiskAnalysisBatch> {
    private static final long IDLE_MS = 60_000L;
    private static final long MAX_DURATION_MS = 5 * 60_000L;
    private static final long CRITICAL_GRACE_MS = 10_000L;
    private static final long EPISODE_GAP_MS = 5 * 60_000L;
    private static final long ALLOWED_LATENESS_MS = 30_000L;
    private static final int MAX_EVENTS = 20;
    private static final int CARRYOVER_EVENTS = 10;
    private static final long DUPLICATE_WINDOW_MS = 30_000L;
    public static final OutputTag<String> LATE_EVENTS =
            new OutputTag<>("late-episode-events", TypeInformation.of(String.class));

    private transient MapState<String, RiskAnalysisBatch.Evidence> evidence;
    private transient MapState<String, RiskAnalysisBatch.Judgment> pendingJudgments;
    private transient MapState<String, Long> semanticSeenAt;
    private transient ValueState<String> episodeId;
    private transient ValueState<Long> revision;
    private transient ValueState<String> lastFingerprint;
    private transient ValueState<Long> firstEventAt;
    private transient ValueState<Long> lastEventAt;
    private transient ValueState<Long> idleTimer;
    private transient ValueState<Long> maximumTimer;
    private transient ValueState<Long> criticalTimer;
    private transient ValueState<Boolean> dirty;
    private transient ValueState<String> pendingTrigger;
    private transient ValueState<BehaviorSignal> identity;

    @Override
    public void open(OpenContext openContext) throws Exception {
        StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofMinutes(30))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .build();
        MapStateDescriptor<String, RiskAnalysisBatch.Evidence> evidenceDescriptor =
                new MapStateDescriptor<>("episode-evidence", String.class, RiskAnalysisBatch.Evidence.class);
        evidenceDescriptor.enableTimeToLive(ttl);
        evidence = getRuntimeContext().getMapState(evidenceDescriptor);
        MapStateDescriptor<String, RiskAnalysisBatch.Judgment> pendingJudgmentDescriptor =
                new MapStateDescriptor<>("episode-pending-judgments", String.class, RiskAnalysisBatch.Judgment.class);
        pendingJudgmentDescriptor.enableTimeToLive(ttl);
        pendingJudgments = getRuntimeContext().getMapState(pendingJudgmentDescriptor);
        MapStateDescriptor<String, Long> semanticSeenDescriptor =
                new MapStateDescriptor<>("episode-semantic-seen-at", String.class, Long.class);
        semanticSeenDescriptor.enableTimeToLive(ttl);
        semanticSeenAt = getRuntimeContext().getMapState(semanticSeenDescriptor);
        episodeId = value("episode-id", String.class, ttl);
        revision = value("episode-revision", Long.class, ttl);
        lastFingerprint = value("episode-fingerprint", String.class, ttl);
        firstEventAt = value("episode-first-event-at", Long.class, ttl);
        lastEventAt = value("episode-last-event-at", Long.class, ttl);
        idleTimer = value("episode-idle-timer", Long.class, ttl);
        maximumTimer = value("episode-maximum-timer", Long.class, ttl);
        criticalTimer = value("episode-critical-timer", Long.class, ttl);
        dirty = value("episode-dirty", Boolean.class, ttl);
        pendingTrigger = value("episode-pending-trigger", String.class, ttl);
        identity = value("episode-identity", BehaviorSignal.class, ttl);
    }

    private <T> ValueState<T> value(String name, Class<T> type, StateTtlConfig ttl) {
        ValueStateDescriptor<T> descriptor = new ValueStateDescriptor<>(name, type);
        descriptor.enableTimeToLive(ttl);
        return getRuntimeContext().getState(descriptor);
    }

    @Override
    public void processElement(BehaviorSignal signal, Context context, Collector<RiskAnalysisBatch> output) throws Exception {
        boolean changed = false;
        if ("event".equals(signal.signalType)) {
            if (signal.platformRuntime || blank(signal.behaviorStage) || "none".equals(signal.behaviorStage)) return;
            long previousEventAt = number(lastEventAt.value());
            if (tooLate(signal.eventTime, previousEventAt)) {
                context.output(
                        LATE_EVENTS,
                        CanonicalEventParser.dlq(
                                value(signal.eventId),
                                new IllegalArgumentException(
                                        "late episode event: eventTime=" + signal.eventTime
                                                + " maximumEventTime=" + previousEventAt
                                                + " allowedLatenessMs=" + ALLOWED_LATENESS_MS
                                )
                        )
                );
                return;
            }
            if (previousEventAt > 0 && signal.eventTime - previousEventAt > EPISODE_GAP_MS) {
                resetEpisode(context);
                previousEventAt = 0;
            }
            long maximumEventAt = Math.max(previousEventAt, signal.eventTime);
            pruneEvidenceBefore(maximumEventAt - EPISODE_GAP_MS);
            String semanticKey = semanticKey(signal);
            Long seenAt = semanticSeenAt.get(semanticKey);
            if (seenAt != null && Math.abs(signal.eventTime - seenAt) <= DUPLICATE_WINDOW_MS) return;
            semanticSeenAt.put(semanticKey, signal.eventTime);
            identity.update(signal);
            RiskAnalysisBatch.Evidence item = RiskAnalysisBatch.Evidence.from(signal);
            RiskAnalysisBatch.Evidence previous = evidence.get(signal.eventId);
            if (previous != null) item.judgment = previous.judgment;
            RiskAnalysisBatch.Judgment pending = pendingJudgments.get(signal.eventId);
            if (pending != null) {
                item.judgment = pending;
                pendingJudgments.remove(signal.eventId);
            }
            evidence.put(signal.eventId, item);
            long first = number(firstEventAt.value());
            if (first == 0 || signal.eventTime < first) firstEventAt.update(signal.eventTime);
            lastEventAt.update(maximumEventAt);
            pendingTrigger.update("idle");
            changed = true;
        } else if (signal.judgment != null) {
            if (technicalJudgment(signal.judgment)) return;
            RiskAnalysisBatch.Evidence item = evidence.get(signal.eventId);
            if (item == null) {
                RiskAnalysisBatch.Judgment current = pendingJudgments.get(signal.eventId);
                if (current == null || signal.judgment.revision >= current.revision) {
                    pendingJudgments.put(signal.eventId, RiskAnalysisBatch.Judgment.from(signal.judgment));
                }
                return;
            }
            RiskAnalysisBatch.Judgment current = item.judgment;
            if (current == null || signal.judgment.revision >= current.revision) {
                if (identity.value() == null) identity.update(signal);
                item.judgment = RiskAnalysisBatch.Judgment.from(signal.judgment);
                evidence.put(signal.eventId, item);
                pendingTrigger.update("judgment_update");
                changed = true;
            }
        }
        if (!changed) return;
        dirty.update(true);

        long now = context.timerService().currentProcessingTime();
        replaceTimer(context, idleTimer, now + IDLE_MS);
        if (number(maximumTimer.value()) == 0) replaceTimer(context, maximumTimer, now + MAX_DURATION_MS);

        int size = evidenceSize();
        if (size >= MAX_EVENTS) {
            emit(context.getCurrentKey(), context.timerService(), output, "event_limit");
            return;
        }
        if ("event".equals(signal.signalType) && terminal(signal)) {
            replaceTimer(context, criticalTimer, now + CRITICAL_GRACE_MS);
            pendingTrigger.update("critical_evidence");
        }
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext context, Collector<RiskAnalysisBatch> output) throws Exception {
        if (timestamp == number(criticalTimer.value())) {
            criticalTimer.clear();
            emit(context.getCurrentKey(), context.timerService(), output, "critical_evidence");
        } else if (timestamp == number(idleTimer.value())) {
            idleTimer.clear();
            emit(context.getCurrentKey(), context.timerService(), output, Objects.requireNonNullElse(pendingTrigger.value(), "idle"));
        } else if (timestamp == number(maximumTimer.value())) {
            maximumTimer.clear();
            emit(context.getCurrentKey(), context.timerService(), output, "max_duration");
        }
    }

    private void emit(String currentKey, TimerService timerService, Collector<RiskAnalysisBatch> output, String trigger) throws Exception {
        if (!Boolean.TRUE.equals(dirty.value())) return;
        pruneEvidenceBefore(number(lastEventAt.value()) - EPISODE_GAP_MS);
        List<RiskAnalysisBatch.Evidence> items = boundedEvidence(evidenceItems());
        if (items.size() < 2) {
            dirty.update(false);
            return;
        }
        if (items.size() > MAX_EVENTS) items = new ArrayList<>(items.subList(items.size() - MAX_EVENTS, items.size()));
        String candidateType = candidateType(items);
        if (candidateType == null) {
            dirty.update(false);
            return;
        }

        String fingerprint = fingerprint(items);
        if (fingerprint.equals(lastFingerprint.value())) {
            dirty.update(false);
            return;
        }
        BehaviorSignal source = identity.value();
        if (source == null) return;
        long nextRevision = number(revision.value()) + 1;
        String currentEpisodeId = episodeId.value();
        if (blank(currentEpisodeId)) {
            currentEpisodeId = hash("ep", currentKey, String.valueOf(items.get(0).eventTime));
            episodeId.update(currentEpisodeId);
        }

        RiskAnalysisBatch batch = new RiskAnalysisBatch();
        batch.episodeId = currentEpisodeId;
        batch.revision = nextRevision;
        batch.supersedesRevision = nextRevision > 1 ? nextRevision - 1 : null;
        batch.evidenceFingerprint = fingerprint;
        batch.triggerReason = trigger;
        batch.tenantId = source.tenantId;
        batch.environmentId = source.environmentId;
        batch.workspaceId = source.workspaceId;
        batch.workspacePath = source.workspacePath;
        batch.agentCorrelationId = source.agentCorrelationId;
        batch.agentType = source.agentType;
        batch.sessionId = source.sessionId;
        batch.windowStart = items.get(0).eventTime;
        batch.windowEnd = items.get(items.size() - 1).eventTime;
        batch.generatedAt = System.currentTimeMillis();
        batch.candidateType = candidateType;
        batch.ruleVersion = supplyChainCandidate(candidateType)
                ? "supply-chain-exploit-v1"
                : "composite-risk-v2";
        batch.decisionPath = decisionPath(items, candidateType);
        batch.synthetic = items.stream().anyMatch(item -> item.synthetic);
        batch.evidence.addAll(items);
        LinkedHashSet<String> traces = new LinkedHashSet<>();
        for (RiskAnalysisBatch.Evidence item : items) {
            if (!blank(item.traceId)) traces.add(item.traceId);
        }
        batch.traceIds.addAll(traces);
        output.collect(batch);

        revision.update(nextRevision);
        lastFingerprint.update(fingerprint);
        dirty.update(false);
        pendingTrigger.clear();
        clearTimer(timerService, idleTimer);
        clearTimer(timerService, maximumTimer);
        clearTimer(timerService, criticalTimer);
        retainCarryover(items);
        firstEventAt.clear();
    }

    private void retainCarryover(List<RiskAnalysisBatch.Evidence> items) throws Exception {
        List<RiskAnalysisBatch.Evidence> retained = items.size() <= CARRYOVER_EVENTS
                ? items
                : items.subList(items.size() - CARRYOVER_EVENTS, items.size());
        evidence.clear();
        for (RiskAnalysisBatch.Evidence item : retained) evidence.put(item.eventId, item);
    }

    private int evidenceSize() throws Exception {
        int size = 0;
        for (RiskAnalysisBatch.Evidence ignored : evidence.values()) size++;
        return size;
    }

    private List<RiskAnalysisBatch.Evidence> evidenceItems() throws Exception {
        List<RiskAnalysisBatch.Evidence> items = new ArrayList<>();
        for (RiskAnalysisBatch.Evidence item : evidence.values()) {
            if (item.eventId != null && !item.eventId.isBlank()) items.add(item);
        }
        return items;
    }

    private void pruneEvidenceBefore(long threshold) throws Exception {
        if (threshold <= 0) return;
        List<String> expired = new ArrayList<>();
        for (RiskAnalysisBatch.Evidence item : evidence.values()) {
            if (item.eventId != null && item.eventTime < threshold) expired.add(item.eventId);
        }
        for (String eventId : expired) evidence.remove(eventId);
    }

    private void resetEpisode(Context context) throws Exception {
        clearTimer(context.timerService(), idleTimer);
        clearTimer(context.timerService(), maximumTimer);
        clearTimer(context.timerService(), criticalTimer);
        evidence.clear();
        pendingJudgments.clear();
        semanticSeenAt.clear();
        episodeId.clear();
        revision.clear();
        lastFingerprint.clear();
        firstEventAt.clear();
        lastEventAt.clear();
        dirty.clear();
        pendingTrigger.clear();
        identity.clear();
    }

    private void replaceTimer(Context context, ValueState<Long> state, long timestamp) throws Exception {
        long previous = number(state.value());
        if (previous > 0) context.timerService().deleteProcessingTimeTimer(previous);
        context.timerService().registerProcessingTimeTimer(timestamp);
        state.update(timestamp);
    }

    private void clearTimer(TimerService timerService, ValueState<Long> state) throws Exception {
        long timestamp = number(state.value());
        if (timestamp > 0) timerService.deleteProcessingTimeTimer(timestamp);
        state.clear();
    }

    private static boolean terminal(BehaviorSignal signal) {
        return signal.externalDestination
                || (signal.dangerous && signal.sensitiveResource)
                || ("destructive_action".equals(signal.behaviorStage));
    }

    static boolean technicalJudgment(JudgmentUpdate judgment) {
        String status = value(judgment.status).toLowerCase();
        String reason = value(judgment.reason).toLowerCase();
        return "failed".equals(status)
                || "timeout".equals(status)
                || reason.contains("unavailable")
                || reason.contains("timed out")
                || reason.contains("timeout")
                || reason.contains("incomplete toolexec evidence")
                || reason.contains("technical failure");
    }

    static boolean tooLate(long eventTime, long maximumEventTime) {
        return maximumEventTime > 0 && eventTime < maximumEventTime - ALLOWED_LATENESS_MS;
    }

    static List<RiskAnalysisBatch.Evidence> boundedEvidence(List<RiskAnalysisBatch.Evidence> items) {
        if (items.isEmpty()) return List.of();
        long maximumEventTime = items.stream()
                .mapToLong(item -> item.eventTime)
                .max()
                .orElse(0);
        long minimumEventTime = maximumEventTime - EPISODE_GAP_MS;
        return items.stream()
                .filter(item -> item.eventTime >= minimumEventTime)
                .sorted(Comparator.comparingLong(item -> item.eventTime))
                .toList();
    }

    static String candidateType(List<RiskAnalysisBatch.Evidence> items) {
        Set<String> stages = new HashSet<>();
        for (RiskAnalysisBatch.Evidence item : items) {
            if (!blank(item.behaviorStage) && !"none".equals(item.behaviorStage)) stages.add(item.behaviorStage);
        }
        boolean sensitive = stages.contains("credential_access") || stages.contains("staging");
        boolean transform = stages.contains("transform");
        boolean egress = stages.contains("external_egress");
        boolean dangerous = stages.contains("dangerous_exec");
        boolean destructive = stages.contains("destructive_action");
        if (sensitive && egress) return "sensitive_data_egress";
        if (sensitive && transform) return "sensitive_data_staging";
        if (transform && egress) return "transformed_external_egress";
        if (dangerous && egress) return "dangerous_execution_with_egress";
        if (dangerous && destructive) return "destructive_execution";
        return null;
    }

    static String decisionPath(List<RiskAnalysisBatch.Evidence> items, String candidateType) {
        if (!supplyChainCandidate(candidateType)) return "composite_judge";
        boolean highConfidenceMatch = false;
        boolean vulnerableExecution = false;
        boolean dangerousOrDestructive = false;
        boolean sensitive = false;
        boolean egress = false;
        boolean destructive = false;
        Set<String> evidenceIds = new HashSet<>();
        for (RiskAnalysisBatch.Evidence item : items) {
            if (!blank(item.eventId)) evidenceIds.add(item.eventId);
            if (item.runtimeVulnerabilities != null && !item.runtimeVulnerabilities.isEmpty()) {
                vulnerableExecution = true;
                highConfidenceMatch |= item.runtimeVulnerabilities.stream()
                        .anyMatch(match -> "high".equalsIgnoreCase(match.confidence));
            }
            String stage = value(item.behaviorStage);
            dangerousOrDestructive |= "dangerous_exec".equals(stage)
                    || "destructive_action".equals(stage);
            sensitive |= "credential_access".equals(stage)
                    || "staging".equals(stage);
            egress |= "external_egress".equals(stage);
            destructive |= "destructive_action".equals(stage);
        }
        return highConfidenceMatch
                && vulnerableExecution
                && dangerousOrDestructive
                && ((sensitive && egress) || destructive)
                && evidenceIds.size() >= 3
                ? "deterministic_rule"
                : "composite_judge";
    }

    private static boolean supplyChainCandidate(String candidateType) {
        return "known_vulnerability_exploitation".equals(candidateType);
    }

    private static String semanticKey(BehaviorSignal signal) {
        return value(signal.behaviorStage) + ":" + value(signal.operation) + ":"
                + normalize(signal.resource) + ":" + normalize(signal.destination) + ":"
                + normalize(signal.command);
    }

    private static String normalize(String value) {
        return value(value).toLowerCase().replaceAll("\\s+", " ").trim();
    }

    private static String fingerprint(List<RiskAnalysisBatch.Evidence> items) {
        List<String> parts = new ArrayList<>();
        for (RiskAnalysisBatch.Evidence item : items) {
            String judgment = item.judgment == null
                    ? ""
                    : value(item.judgment.stage) + ":" + value(item.judgment.status) + ":"
                    + value(item.judgment.verdict) + ":" + item.judgment.revision;
            parts.add(item.eventId + ":" + judgment);
            if (item.runtimeVulnerabilities != null) {
                for (CanonicalEvent.RuntimeVulnerabilityMatch match : item.runtimeVulnerabilities) {
                    parts.add(value(match.findingId) + ":" + value(match.vulnerabilityAssessmentId)
                            + ":" + value(match.confidence));
                }
            }
        }
        return hash("evidence", String.join("|", parts));
    }

    private static long number(Long value) {
        return value == null ? 0 : value;
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
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
            throw new IllegalStateException(error);
        }
    }
}
