package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;

public class RiskCorrelationFunction extends KeyedProcessFunction<String, CanonicalEvent, StreamFinding> {
    private static final long MINUTE = 60_000L;
    private static final long FIVE_MINUTES = 5 * MINUTE;
    private static final long HOUR = 60 * MINUTE;
    private static final long COMPOSITE_WINDOW = 3 * MINUTE;
    private static final String PROFILE_RULE_VERSION = "risk-profile-v1";

    private transient MapState<String, Long> seenEvents;
    private transient MapState<String, Long> emittedCorrelations;
    private transient ListState<CanonicalEvent> history;
    private transient ValueState<Long> maximumEventTime;

    @Override
    public void open(OpenContext openContext) throws Exception {
        StateTtlConfig dayTtl = StateTtlConfig.newBuilder(Duration.ofHours(24))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .build();
        MapStateDescriptor<String, Long> seenDescriptor =
                new MapStateDescriptor<>("seen-events", String.class, Long.class);
        seenDescriptor.enableTimeToLive(dayTtl);
        seenEvents = getRuntimeContext().getMapState(seenDescriptor);

        MapStateDescriptor<String, Long> correlationDescriptor =
                new MapStateDescriptor<>("emitted-correlations", String.class, Long.class);
        correlationDescriptor.enableTimeToLive(dayTtl);
        emittedCorrelations = getRuntimeContext().getMapState(correlationDescriptor);

        ListStateDescriptor<CanonicalEvent> historyDescriptor =
                new ListStateDescriptor<>("event-history", CanonicalEvent.class);
        historyDescriptor.enableTimeToLive(dayTtl);
        history = getRuntimeContext().getListState(historyDescriptor);
        maximumEventTime = getRuntimeContext().getState(
                new ValueStateDescriptor<>("maximum-event-time", Long.class)
        );
    }

    @Override
    public void processElement(CanonicalEvent event, Context context, Collector<StreamFinding> output) throws Exception {
        if (seenEvents.contains(event.eventId)) return;
        seenEvents.put(event.eventId, event.eventTime);

        long maximum = Math.max(event.eventTime, value(maximumEventTime.value()));
        maximumEventTime.update(maximum);
        List<CanonicalEvent> events = retainedEvents(maximum);
        events.add(event);
        events.sort(Comparator.comparingLong(candidate -> candidate.eventTime));
        history.update(events);

        output.collect(profile(event, events, maximum));
    }

    private List<CanonicalEvent> retainedEvents(long maximum) throws Exception {
        List<CanonicalEvent> retained = new ArrayList<>();
        long cutoff = maximum - HOUR;
        for (CanonicalEvent candidate : history.get()) {
            if (candidate.eventTime >= cutoff) retained.add(candidate);
        }
        return retained;
    }

    private static StreamFinding profile(CanonicalEvent current, List<CanonicalEvent> events, long maximum) {
        int toolExec1m = count(events, maximum - MINUTE, event -> "ToolExec".equals(event.eventKind));
        int dangerous1m = count(events, maximum - MINUTE, event -> event.dangerous);
        int failed1m = count(events, maximum - MINUTE, event -> event.failed);
        int sensitive5m = count(events, maximum - FIVE_MINUTES, event -> event.sensitiveResource);
        int transforms5m = count(events, maximum - FIVE_MINUTES, event -> transform(event.operation));
        int egress5m = count(events, maximum - FIVE_MINUTES, event -> "egress".equals(event.operation) && event.externalDestination);
        int sessions5m = distinct(events, maximum - FIVE_MINUTES, event -> event.sessionId);
        int destinations5m = distinct(events, maximum - FIVE_MINUTES, event -> event.destination);

        int score = Math.min(100,
                Math.min(25, dangerous1m * 5)
                        + Math.min(25, sensitive5m * 10)
                        + Math.min(20, egress5m * 8)
                        + Math.min(15, transforms5m * 5)
                        + (toolExec1m >= 20 ? 10 : 0)
                        + (failed1m >= 5 ? 5 : 0)
        );
        long windowEnd = (maximum / MINUTE) * MINUTE + MINUTE;
        long calculatedAt = System.currentTimeMillis();
        StreamFinding finding = base(current, "risk_profile", calculatedAt);
        finding.profileId = hash("profile", current.agentCorrelationId, String.valueOf(windowEnd), PROFILE_RULE_VERSION);
        finding.findingId = finding.profileId;
        finding.windowStart = maximum - FIVE_MINUTES;
        finding.windowEnd = windowEnd;
        finding.riskScore = score;
        finding.riskLevel = riskLevel(score);
        finding.ruleVersion = PROFILE_RULE_VERSION;
        finding.features.put("toolExecCount1m", toolExec1m);
        finding.features.put("dangerousCommandCount1m", dangerous1m);
        finding.features.put("failedCount1m", failed1m);
        finding.features.put("sensitiveFileCount5m", sensitive5m);
        finding.features.put("transformCount5m", transforms5m);
        finding.features.put("externalEgressCount5m", egress5m);
        finding.features.put("distinctSessionCount5m", sessions5m);
        finding.features.put("distinctDestinationCount5m", destinations5m);
        if (toolExec1m >= 20) finding.hitRules.add("high-command-rate");
        if (dangerous1m >= 3) finding.hitRules.add("repeated-dangerous-command");
        if (sensitive5m > 0 && egress5m > 0) finding.hitRules.add("sensitive-access-with-egress");
        if (failed1m >= 5) finding.hitRules.add("high-failure-rate");
        return finding;
    }

    private static CompositeMatch composite(List<CanonicalEvent> events, String workspaceId) {
        List<CanonicalEvent> scoped = events.stream()
                .filter(event -> Objects.equals(workspaceId, event.workspaceId))
                .filter(event -> event.eventTime >= events.get(events.size() - 1).eventTime - 10 * MINUTE)
                .sorted(Comparator.comparingLong(event -> event.eventTime))
                .toList();
        for (CanonicalEvent read : scoped) {
            if (!"file_read".equals(read.operation) || !read.sensitiveResource) continue;
            for (CanonicalEvent transform : scoped) {
                if (!transform(transform.operation)
                        || transform.eventTime < read.eventTime
                        || transform.eventTime - read.eventTime > COMPOSITE_WINDOW) continue;
                for (CanonicalEvent egress : scoped) {
                    if (!"egress".equals(egress.operation)
                            || !egress.externalDestination
                            || egress.eventTime < transform.eventTime
                            || egress.eventTime - read.eventTime > COMPOSITE_WINDOW) continue;
                    List<CanonicalEvent> evidence = List.of(read, transform, egress);
                    String correlationId = hash(
                            "corr",
                            "sensitive-data-exfiltration",
                            "1",
                            evidence.stream().map(event -> event.eventId).sorted().reduce("", (a, b) -> a + ":" + b)
                    );
                    StreamFinding finding = base(egress, "composite_risk", System.currentTimeMillis());
                    finding.correlationId = correlationId;
                    finding.findingId = correlationId;
                    finding.ruleId = "sensitive-data-exfiltration";
                    finding.ruleVersion = "1";
                    finding.windowStart = read.eventTime;
                    finding.windowEnd = egress.eventTime;
                    finding.sessionId = same(read.sessionId, transform.sessionId, egress.sessionId) ? read.sessionId : null;
                    finding.traceId = same(read.traceId, transform.traceId, egress.traceId) ? read.traceId : null;
                    finding.evidenceScore = evidenceScore(read, transform, egress);
                    finding.severity = finding.evidenceScore >= 85 ? "critical" : "high";
                    finding.reason = "Sensitive file access was followed by data transformation and external egress.";
                    for (CanonicalEvent event : evidence) {
                        finding.evidenceEventIds.add(event.eventId);
                        finding.evidence.add(StreamFinding.Evidence.from(event));
                    }
                    return new CompositeMatch(correlationId, finding);
                }
            }
        }
        return null;
    }

    private static double evidenceScore(CanonicalEvent read, CanonicalEvent transform, CanonicalEvent egress) {
        double score = 60;
        if (same(read.traceId, transform.traceId, egress.traceId)) score += 15;
        if (same(read.sessionId, transform.sessionId, egress.sessionId)) score += 10;
        if (sameProcess(read, transform, egress)) score += 10;
        if (egress.eventTime - read.eventTime <= MINUTE) score += 5;
        return Math.min(100, score);
    }

    private static boolean sameProcess(CanonicalEvent... events) {
        if (events[0].processIdentity == null || events[0].processIdentity.pid == null) return false;
        String processInstanceId = events[0].processIdentity.processInstanceId;
        for (int i = 1; i < events.length; i++) {
            if (events[i].processIdentity == null) return false;
            if (processInstanceId != null && !processInstanceId.isBlank()
                    && events[i].processIdentity.processInstanceId != null
                    && !events[i].processIdentity.processInstanceId.isBlank()) {
                if (!processInstanceId.equals(events[i].processIdentity.processInstanceId)) return false;
                continue;
            }
            if (!Objects.equals(events[0].processIdentity.hostId, events[i].processIdentity.hostId)
                    || !Objects.equals(events[0].processIdentity.containerId, events[i].processIdentity.containerId)
                    || !Objects.equals(events[0].processIdentity.cgroupId, events[i].processIdentity.cgroupId)
                    || !Objects.equals(events[0].processIdentity.pid, events[i].processIdentity.pid)
                    || !Objects.equals(processStart(events[0]), processStart(events[i]))) return false;
        }
        return true;
    }

    private static String processStart(CanonicalEvent event) {
        if (event.processIdentity == null) return null;
        if (event.processIdentity.startTimeTicks != null && !event.processIdentity.startTimeTicks.isBlank()) {
            return "ticks:" + event.processIdentity.startTimeTicks;
        }
        return event.processIdentity.startTimeNs == null ? null : "ns:" + event.processIdentity.startTimeNs;
    }

    private static boolean same(String first, String second, String third) {
        return first != null && !first.isBlank() && first.equals(second) && first.equals(third);
    }

    private static StreamFinding base(CanonicalEvent event, String type, long calculatedAt) {
        StreamFinding finding = new StreamFinding();
        finding.findingType = type;
        finding.version = calculatedAt;
        finding.calculatedAt = calculatedAt;
        finding.tenantId = event.tenantId;
        finding.environmentId = event.environmentId;
        finding.workspaceId = event.workspaceId;
        finding.workspacePath = event.workspacePath;
        finding.agentCorrelationId = event.agentCorrelationId;
        finding.agentType = event.agentType;
        return finding;
    }

    private static int count(List<CanonicalEvent> events, long cutoff, Predicate predicate) {
        int count = 0;
        for (CanonicalEvent event : events) if (event.eventTime >= cutoff && predicate.test(event)) count++;
        return count;
    }

    private static int distinct(List<CanonicalEvent> events, long cutoff, Extractor extractor) {
        return (int) events.stream()
                .filter(event -> event.eventTime >= cutoff)
                .map(extractor::value)
                .filter(value -> value != null && !value.isBlank())
                .distinct()
                .count();
    }

    private static boolean transform(String operation) {
        return "encode".equals(operation) || "compress".equals(operation) || "copy".equals(operation);
    }

    private static String riskLevel(int score) {
        if (score >= 85) return "critical";
        if (score >= 65) return "high";
        if (score >= 35) return "medium";
        if (score > 0) return "low";
        return "safe";
    }

    private static long value(Long value) {
        return value == null ? 0 : value;
    }

    private static String hash(String prefix, String... parts) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String part : parts) {
                digest.update((part == null ? "" : part).getBytes(StandardCharsets.UTF_8));
                digest.update((byte) 0);
            }
            return prefix + "_" + HexFormat.of().formatHex(digest.digest()).substring(0, 24);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    @FunctionalInterface
    private interface Predicate {
        boolean test(CanonicalEvent event);
    }

    @FunctionalInterface
    private interface Extractor {
        String value(CanonicalEvent event);
    }

    private record CompositeMatch(String correlationId, StreamFinding finding) {}
}
