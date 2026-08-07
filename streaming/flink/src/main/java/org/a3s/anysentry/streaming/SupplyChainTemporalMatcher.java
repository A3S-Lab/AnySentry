package org.a3s.anysentry.streaming;

import java.util.Comparator;
import java.util.List;
import java.util.Locale;

final class SupplyChainTemporalMatcher {
    static final long WINDOW_MS = 5 * 60_000L;

    private SupplyChainTemporalMatcher() {}

    static List<Match> match(List<BehaviorSignal> input) {
        List<BehaviorSignal> ordered = input.stream()
                .filter(signal -> signal != null
                        && !signal.failed
                        && signal.eventId != null
                        && !signal.eventId.isBlank())
                .sorted(Comparator.comparingLong((BehaviorSignal signal) -> signal.eventTime)
                        .thenComparing(signal -> value(signal.eventId)))
                .toList();

        for (int consequenceIndex = ordered.size() - 1; consequenceIndex >= 0; consequenceIndex -= 1) {
            BehaviorSignal consequence = ordered.get(consequenceIndex);
            if (!consequence(consequence)) continue;
            for (int shellIndex = consequenceIndex - 1; shellIndex >= 0; shellIndex -= 1) {
                BehaviorSignal shell = ordered.get(shellIndex);
                if (!shellOrScript(shell) || !sameOrDirectChild(shell, consequence)) continue;
                for (int seedIndex = shellIndex - 1; seedIndex >= 0; seedIndex -= 1) {
                    BehaviorSignal seed = ordered.get(seedIndex);
                    if (!vulnerableExecution(seed) || !directChild(seed, shell)) continue;
                    if (consequence.eventTime - seed.eventTime > WINDOW_MS) break;
                    List<BehaviorSignal> evidence = List.of(seed, shell, consequence);
                    return List.of(new Match(
                            "known_vulnerability_exploitation",
                            processId(seed),
                            evidence,
                            evidenceConfidence(evidence)
                    ));
                }
            }
        }
        return List.of();
    }

    static boolean relevant(BehaviorSignal signal) {
        return vulnerableExecution(signal) || shellOrScript(signal) || consequence(signal);
    }

    static boolean vulnerableExecution(BehaviorSignal signal) {
        return signal != null
                && signal.runtimeVulnerabilities != null
                && !signal.runtimeVulnerabilities.isEmpty();
    }

    static boolean shellOrScript(BehaviorSignal signal) {
        if (signal == null) return false;
        if ("shell_execution".equals(signal.behaviorStage)) return true;
        String executable = basename(signal.executable).toLowerCase(Locale.ROOT);
        return executable.matches("(?:ba|z|fi|da)?sh|powershell|pwsh|python\\d*|node|perl|ruby");
    }

    static boolean consequence(BehaviorSignal signal) {
        if (signal == null) return false;
        if (signal.externalDestination && "egress".equals(signal.operation)) return true;
        if ("destructive_action".equals(signal.behaviorStage)) return true;
        if ("dangerous_exec".equals(signal.behaviorStage)) return true;
        return signal.sensitiveResource
                && ("file_read".equals(signal.operation)
                || "copy".equals(signal.operation)
                || "encode".equals(signal.operation)
                || "compress".equals(signal.operation));
    }

    static boolean directChild(BehaviorSignal parent, BehaviorSignal child) {
        CanonicalEvent.ProcessIdentity left = parent == null ? null : parent.processIdentity;
        CanonicalEvent.ProcessIdentity right = child == null ? null : child.processIdentity;
        return left != null
                && right != null
                && left.pid != null
                && right.ppid != null
                && left.pid.equals(right.ppid)
                && compatibleScope(left, right);
    }

    static boolean sameOrDirectChild(BehaviorSignal parent, BehaviorSignal child) {
        return sameProcess(parent, child) || directChild(parent, child);
    }

    private static boolean sameProcess(BehaviorSignal leftSignal, BehaviorSignal rightSignal) {
        CanonicalEvent.ProcessIdentity left = leftSignal == null ? null : leftSignal.processIdentity;
        CanonicalEvent.ProcessIdentity right = rightSignal == null ? null : rightSignal.processIdentity;
        if (left == null || right == null) return false;
        if (!blank(left.processInstanceId) && !blank(right.processInstanceId)) {
            return left.processInstanceId.equals(right.processInstanceId);
        }
        return left.pid != null
                && left.pid.equals(right.pid)
                && compatibleScope(left, right);
    }

    private static boolean compatibleScope(
            CanonicalEvent.ProcessIdentity left,
            CanonicalEvent.ProcessIdentity right
    ) {
        return compatible(left.hostId, right.hostId)
                && compatible(left.bootId, right.bootId)
                && compatible(left.containerId, right.containerId);
    }

    private static boolean compatible(String left, String right) {
        return blank(left) || blank(right) || left.equals(right);
    }

    private static String evidenceConfidence(List<BehaviorSignal> evidence) {
        BehaviorSignal seed = evidence.get(0);
        boolean highVulnerabilityMatch = seed.runtimeVulnerabilities.stream()
                .anyMatch(match -> "high".equalsIgnoreCase(match.confidence));
        boolean strongProcesses = evidence.stream().allMatch(signal ->
                signal.processIdentity != null
                        && "strong".equals(signal.processIdentity.identityConfidence)
                        && !blank(signal.processIdentity.bootId)
                        && !blank(signal.processIdentity.processInstanceId));
        return highVulnerabilityMatch && strongProcesses ? "strong" : "medium";
    }

    private static String processId(BehaviorSignal signal) {
        if (signal.processIdentity == null) return "";
        if (!blank(signal.processIdentity.processInstanceId)) {
            return signal.processIdentity.processInstanceId;
        }
        return value(signal.processIdentity.hostId)
                + ":" + value(signal.processIdentity.bootId)
                + ":" + value(signal.processIdentity.containerId)
                + ":" + signal.processIdentity.pid;
    }

    private static String basename(String path) {
        String normalized = value(path).replace('\\', '/');
        int separator = normalized.lastIndexOf('/');
        return separator >= 0 ? normalized.substring(separator + 1) : normalized;
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }

    record Match(
            String candidateType,
            String correlationEntityId,
            List<BehaviorSignal> evidence,
            String evidenceConfidence
    ) {
        String candidateCompletionKey() {
            return candidateType
                    + "\0"
                    + correlationEntityId
                    + "\0"
                    + value(evidence.get(0).eventId)
                    + "|"
                    + value(evidence.get(1).eventId);
        }

        String terminalCompletionKey() {
            return candidateType
                    + "\0"
                    + value(evidence.get(evidence.size() - 1).eventId);
        }
    }
}
