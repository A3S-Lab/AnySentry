package org.a3s.anysentry.streaming;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

final class TemporalEpisodeMatcher {
    static final long WINDOW_MS = 5 * 60_000L;

    private TemporalEpisodeMatcher() {}

    static List<Match> match(List<BehaviorSignal> input) {
        List<BehaviorSignal> ordered = input.stream()
                .filter(signal -> signal != null && !signal.failed && signal.eventId != null)
                .sorted(Comparator.comparingLong((BehaviorSignal signal) -> signal.eventTime)
                        .thenComparing(signal -> value(signal.eventId)))
                .toList();
        Map<String, List<BehaviorSignal>> byFile = new LinkedHashMap<>();
        for (BehaviorSignal signal : ordered) {
            String fileId = fileId(signal);
            if (!fileId.isBlank()) byFile.computeIfAbsent(fileId, ignored -> new ArrayList<>()).add(signal);
        }

        List<Match> matches = new ArrayList<>();
        for (Map.Entry<String, List<BehaviorSignal>> entry : byFile.entrySet()) {
            Match downloadExecute = downloadExecute(entry.getKey(), entry.getValue());
            if (downloadExecute != null) matches.add(downloadExecute);
            Match exfiltration = sensitiveExfiltration(entry.getKey(), entry.getValue(), ordered);
            if (exfiltration != null) matches.add(exfiltration);
        }
        Match persistence = persistence(ordered);
        if (persistence != null) matches.add(persistence);
        Match sandboxBreakout = sandboxBreakout(ordered);
        if (sandboxBreakout != null) matches.add(sandboxBreakout);
        Match destructive = destructiveBehavior(ordered);
        if (destructive != null) matches.add(destructive);
        Match lateralMovement = lateralMovement(ordered);
        if (lateralMovement != null) matches.add(lateralMovement);
        return matches;
    }

    static List<Match> ambiguous(List<BehaviorSignal> input) {
        List<BehaviorSignal> ordered = input.stream()
                .filter(signal -> signal != null && !signal.failed && signal.eventId != null)
                .sorted(Comparator.comparingLong((BehaviorSignal signal) -> signal.eventTime)
                        .thenComparing(signal -> value(signal.eventId)))
                .toList();
        Map<String, List<BehaviorSignal>> byFile = new LinkedHashMap<>();
        for (BehaviorSignal signal : ordered) {
            String fileId = fileId(signal);
            if (!fileId.isBlank()) byFile.computeIfAbsent(fileId, ignored -> new ArrayList<>()).add(signal);
        }
        List<Match> matches = new ArrayList<>();
        for (Map.Entry<String, List<BehaviorSignal>> entry : byFile.entrySet()) {
            Match download = ambiguousDownloadExecute(entry.getKey(), entry.getValue());
            if (download != null) matches.add(download);
            Match exfiltration = ambiguousExfiltration(entry.getKey(), entry.getValue(), ordered);
            if (exfiltration != null) matches.add(exfiltration);
        }
        Match persistence = ambiguousPersistence(ordered);
        if (persistence != null) matches.add(persistence);
        Match sandbox = ambiguousSandbox(ordered);
        if (sandbox != null) matches.add(sandbox);
        Match destructive = ambiguousDestructive(ordered);
        if (destructive != null) matches.add(destructive);
        Match lateral = ambiguousLateral(ordered);
        if (lateral != null) matches.add(lateral);
        return matches;
    }

    private static Match downloadExecute(String fileId, List<BehaviorSignal> fileSignals) {
        BehaviorSignal execute = latest(
                fileSignals,
                signal -> "execute".equals(signal.operation)
        );
        BehaviorSignal chmod = latestBefore(
                fileSignals,
                execute,
                signal -> "chmod".equals(signal.operation)
        );
        BehaviorSignal write = latestBefore(
                fileSignals,
                chmod,
                signal -> "file_write".equals(signal.operation)
        );
        BehaviorSignal download = latestBefore(
                fileSignals,
                write,
                signal -> "download".equals(signal.operation)
        );
        if (!complete(download, write, chmod, execute)
                || execute.eventTime - download.eventTime > WINDOW_MS) return null;
        List<BehaviorSignal> evidence = List.of(download, write, chmod, execute);
        return new Match(
                "download_execute",
                fileId,
                evidence,
                minimumConfidence(evidence),
                "deterministic_rule"
        );
    }

    private static Match sensitiveExfiltration(
            String fileId,
            List<BehaviorSignal> fileSignals,
            List<BehaviorSignal> allSignals
    ) {
        BehaviorSignal egress = latest(
                allSignals,
                signal -> "egress".equals(signal.operation) && signal.externalDestination
        );
        BehaviorSignal transform = latestBefore(
                fileSignals,
                egress,
                signal -> "encode".equals(signal.operation) || "compress".equals(signal.operation)
        );
        BehaviorSignal read = latestBefore(
                fileSignals,
                transform,
                signal -> "file_read".equals(signal.operation) && signal.sensitiveResource
        );
        if (!complete(read, transform, egress)
                || egress.eventTime - read.eventTime > WINDOW_MS) return null;
        List<BehaviorSignal> evidence = List.of(read, transform, egress);
        return new Match(
                "sensitive_data_exfiltration",
                fileId,
                evidence,
                minimumConfidence(List.of(read, transform)),
                "deterministic_rule"
        );
    }

    private static Match persistence(List<BehaviorSignal> signals) {
        BehaviorSignal activation = latest(
                signals,
                signal -> "persistence_activate".equals(signal.operation)
        );
        BehaviorSignal write = latestBefore(
                signals,
                activation,
                signal -> "file_write".equals(signal.operation)
                        && "persistence_write".equals(signal.behaviorStage)
                        && samePersistenceTarget(signal, activation)
        );
        if (!complete(write, activation)
                || activation.eventTime - write.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(write, activation))) return null;
        List<BehaviorSignal> evidence = List.of(write, activation);
        return new Match(
                "persistence_installation",
                "persistence:" + persistenceTarget(activation),
                evidence,
                minimumConfidence(evidence),
                "deterministic_rule"
        );
    }

    private static Match sandboxBreakout(List<BehaviorSignal> signals) {
        BehaviorSignal consequence = latest(
                signals,
                TemporalEpisodeMatcher::privilegedConsequence
        );
        BehaviorSignal privilege = latestBefore(
                signals,
                consequence,
                signal -> "privilege_change".equals(signal.operation)
        );
        BehaviorSignal probe = latestBefore(
                signals,
                privilege,
                signal -> "sandbox_probe".equals(signal.operation)
        );
        if (!complete(probe, privilege, consequence)
                || consequence.eventTime - probe.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(probe, privilege, consequence))) return null;
        List<BehaviorSignal> evidence = List.of(probe, privilege, consequence);
        return new Match(
                "sandbox_privilege_breakout",
                processScope(probe),
                evidence,
                processConfidence(evidence),
                "deterministic_rule"
        );
    }

    private static Match destructiveBehavior(List<BehaviorSignal> signals) {
        BehaviorSignal terminal = latest(
                signals,
                signal -> "destroy".equals(signal.operation)
        );
        BehaviorSignal firstDestruction = latestBefore(
                signals,
                terminal,
                signal -> "destroy".equals(signal.operation)
        );
        BehaviorSignal discovery = latestBefore(
                signals,
                firstDestruction,
                signal -> "target_discovery".equals(signal.operation)
                        && withinPathScope(signal.resource, firstDestruction.resource)
                        && withinPathScope(signal.resource, terminal.resource)
        );
        if (!complete(discovery, firstDestruction, terminal)
                || terminal.eventTime - discovery.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(discovery, firstDestruction, terminal))) return null;
        List<BehaviorSignal> evidence = List.of(discovery, firstDestruction, terminal);
        return new Match(
                "destructive_behavior",
                "path:" + normalizedPath(discovery.resource),
                evidence,
                processConfidence(evidence),
                "deterministic_rule"
        );
    }

    private static Match lateralMovement(List<BehaviorSignal> signals) {
        BehaviorSignal action = latest(
                signals,
                signal -> "remote_execute".equals(signal.operation)
                        || "remote_copy".equals(signal.operation)
        );
        BehaviorSignal connection = latestBefore(
                signals,
                action,
                signal -> "remote_connect".equals(signal.operation)
                        && sameDestination(signal, action)
                        && sameFile(signal, action)
        );
        BehaviorSignal credential = latestBefore(
                signals,
                connection,
                signal -> "file_read".equals(signal.operation)
                        && signal.sensitiveResource
                        && sameFile(signal, connection)
        );
        if (!complete(credential, connection, action)
                || action.eventTime - credential.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(credential, connection, action))) return null;
        List<BehaviorSignal> evidence = List.of(credential, connection, action);
        return new Match(
                "lateral_movement",
                "lateral:" + fileId(credential) + "@" + value(action.destination),
                evidence,
                minimumConfidence(evidence),
                "deterministic_rule"
        );
    }

    private static Match ambiguousDownloadExecute(String fileId, List<BehaviorSignal> signals) {
        BehaviorSignal execute = latest(signals, signal -> "execute".equals(signal.operation));
        BehaviorSignal download = latestBefore(signals, execute, signal -> "download".equals(signal.operation));
        if (!complete(download, execute)
                || execute.eventTime - download.eventTime > WINDOW_MS
                || downloadExecute(fileId, signals) != null) return null;
        return ambiguousMatch("download_execute", fileId, List.of(download, execute));
    }

    private static Match ambiguousExfiltration(
            String fileId,
            List<BehaviorSignal> fileSignals,
            List<BehaviorSignal> allSignals
    ) {
        BehaviorSignal egress = latest(
                allSignals,
                signal -> "egress".equals(signal.operation) && signal.externalDestination
        );
        BehaviorSignal read = latestBefore(
                fileSignals,
                egress,
                signal -> "file_read".equals(signal.operation) && signal.sensitiveResource
        );
        if (!complete(read, egress)
                || egress.eventTime - read.eventTime > WINDOW_MS
                || sensitiveExfiltration(fileId, fileSignals, allSignals) != null) return null;
        return ambiguousMatch("sensitive_data_exfiltration", fileId, List.of(read, egress));
    }

    private static Match ambiguousPersistence(List<BehaviorSignal> signals) {
        BehaviorSignal activation = latest(
                signals,
                signal -> "persistence_activate".equals(signal.operation)
        );
        BehaviorSignal write = latestBefore(
                signals,
                activation,
                signal -> "file_write".equals(signal.operation)
                        && "persistence_write".equals(signal.behaviorStage)
        );
        if (!complete(write, activation)
                || activation.eventTime - write.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(write, activation))
                || persistence(signals) != null) return null;
        return ambiguousMatch(
                "persistence_installation",
                processScope(write),
                List.of(write, activation)
        );
    }

    private static Match ambiguousSandbox(List<BehaviorSignal> signals) {
        BehaviorSignal consequence = latest(signals, TemporalEpisodeMatcher::privilegedConsequence);
        BehaviorSignal precursor = latestBefore(
                signals,
                consequence,
                signal -> "sandbox_probe".equals(signal.operation)
                        || "privilege_change".equals(signal.operation)
        );
        if (!complete(precursor, consequence)
                || consequence.eventTime - precursor.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(precursor, consequence))
                || sandboxBreakout(signals) != null) return null;
        return ambiguousMatch(
                "sandbox_privilege_breakout",
                processScope(precursor),
                List.of(precursor, consequence)
        );
    }

    private static Match ambiguousDestructive(List<BehaviorSignal> signals) {
        BehaviorSignal terminal = latest(signals, signal -> "destroy".equals(signal.operation));
        BehaviorSignal discovery = latestBefore(
                signals,
                terminal,
                signal -> "target_discovery".equals(signal.operation)
                        && withinPathScope(signal.resource, terminal.resource)
        );
        if (!complete(discovery, terminal)
                || terminal.eventTime - discovery.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(discovery, terminal))
                || destructiveBehavior(signals) != null) return null;
        return ambiguousMatch(
                "destructive_behavior",
                "path:" + normalizedPath(discovery.resource),
                List.of(discovery, terminal)
        );
    }

    private static Match ambiguousLateral(List<BehaviorSignal> signals) {
        BehaviorSignal action = latest(
                signals,
                signal -> "remote_execute".equals(signal.operation)
                        || "remote_copy".equals(signal.operation)
        );
        BehaviorSignal credential = latestBefore(
                signals,
                action,
                signal -> "file_read".equals(signal.operation)
                        && signal.sensitiveResource
                        && sameFile(signal, action)
        );
        if (!complete(credential, action)
                || action.eventTime - credential.eventTime > WINDOW_MS
                || !sameProcessScope(List.of(credential, action))
                || lateralMovement(signals) != null) return null;
        return ambiguousMatch(
                "lateral_movement",
                "lateral:" + fileId(credential) + "@" + value(action.destination),
                List.of(credential, action)
        );
    }

    private static Match ambiguousMatch(
            String candidateType,
            String correlationEntityId,
            List<BehaviorSignal> evidence
    ) {
        return new Match(
                candidateType,
                correlationEntityId,
                evidence,
                "weak",
                "composite_judge"
        );
    }

    private static boolean samePersistenceTarget(
            BehaviorSignal write,
            BehaviorSignal activation
    ) {
        String writeTarget = persistenceTarget(write);
        String activationTarget = persistenceTarget(activation);
        return !writeTarget.isBlank()
                && (writeTarget.equals(activationTarget)
                || leaf(writeTarget).equals(leaf(activationTarget)));
    }

    private static String persistenceTarget(BehaviorSignal signal) {
        return normalizedPath(signal == null ? "" : signal.resource);
    }

    private static boolean privilegedConsequence(BehaviorSignal signal) {
        if (signal == null) return false;
        return signal.sensitiveResource
                || signal.externalDestination
                || signal.dangerous
                || "destroy".equals(signal.operation);
    }

    private static boolean withinPathScope(String scopeValue, String targetValue) {
        String scope = normalizedPath(scopeValue);
        String target = normalizedPath(targetValue);
        return !scope.isBlank()
                && !target.isBlank()
                && (target.equals(scope) || target.startsWith(scope + "/"));
    }

    private static String normalizedPath(String value) {
        String result = value(value).replace('\\', '/');
        while (result.length() > 1 && result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static String leaf(String value) {
        String normalized = normalizedPath(value);
        int separator = normalized.lastIndexOf('/');
        return separator < 0 ? normalized : normalized.substring(separator + 1);
    }

    private static boolean sameDestination(BehaviorSignal left, BehaviorSignal right) {
        return left != null
                && right != null
                && !value(left.destination).isBlank()
                && value(left.destination).equalsIgnoreCase(value(right.destination));
    }

    private static boolean sameFile(BehaviorSignal left, BehaviorSignal right) {
        return left != null
                && right != null
                && !fileId(left).isBlank()
                && fileId(left).equals(fileId(right));
    }

    private static boolean sameProcessScope(List<BehaviorSignal> evidence) {
        if (evidence.isEmpty()) return false;
        CanonicalEvent.ProcessIdentity first = evidence.get(0).processIdentity;
        if (first == null) return false;
        for (BehaviorSignal signal : evidence) {
            CanonicalEvent.ProcessIdentity current = signal.processIdentity;
            if (current == null
                    || incompatible(first.hostId, current.hostId)
                    || incompatible(first.bootId, current.bootId)
                    || incompatible(first.containerId, current.containerId)) return false;
            if (first.rootPid != null && current.rootPid != null
                    && !first.rootPid.equals(current.rootPid)) return false;
        }
        return first.rootPid != null
                || evidence.stream().allMatch(signal ->
                signal.processIdentity != null && signal.processIdentity.pid != null);
    }

    private static boolean incompatible(String left, String right) {
        return left != null && !left.isBlank()
                && right != null && !right.isBlank()
                && !left.equals(right);
    }

    private static String processScope(BehaviorSignal signal) {
        CanonicalEvent.ProcessIdentity process = signal.processIdentity;
        if (process == null) return "process:unknown";
        return "process:" + value(process.hostId)
                + ":" + value(process.bootId)
                + ":" + (process.rootPid == null ? value(process.processInstanceId) : process.rootPid);
    }

    private static BehaviorSignal latest(
            List<BehaviorSignal> signals,
            Predicate<BehaviorSignal> predicate
    ) {
        BehaviorSignal result = null;
        for (BehaviorSignal signal : signals) {
            if (predicate.test(signal)) result = signal;
        }
        return result;
    }

    private static BehaviorSignal latestBefore(
            List<BehaviorSignal> signals,
            BehaviorSignal next,
            Predicate<BehaviorSignal> predicate
    ) {
        if (next == null) return null;
        BehaviorSignal result = null;
        for (BehaviorSignal signal : signals) {
            if (signal.eventTime >= next.eventTime) break;
            if (predicate.test(signal)) result = signal;
        }
        return result;
    }

    private static boolean complete(BehaviorSignal... signals) {
        for (BehaviorSignal signal : signals) {
            if (signal == null) return false;
        }
        return true;
    }

    private static String fileId(BehaviorSignal signal) {
        return signal.fileIdentity == null ? "" : value(signal.fileIdentity.fileInstanceId);
    }

    private static String minimumConfidence(List<BehaviorSignal> signals) {
        int rank = 2;
        for (BehaviorSignal signal : signals) {
            String confidence = signal.fileIdentity == null
                    ? "weak"
                    : value(signal.fileIdentity.identityConfidence);
            rank = Math.min(rank, confidenceRank(confidence));
        }
        return switch (rank) {
            case 2 -> "strong";
            case 1 -> "medium";
            default -> "weak";
        };
    }

    private static String processConfidence(List<BehaviorSignal> signals) {
        int rank = 2;
        for (BehaviorSignal signal : signals) {
            String confidence = signal.processIdentity == null
                    ? "weak"
                    : value(signal.processIdentity.identityConfidence);
            rank = Math.min(rank, confidenceRank(confidence));
        }
        return switch (rank) {
            case 2 -> "strong";
            case 1 -> "medium";
            default -> "weak";
        };
    }

    private static int confidenceRank(String confidence) {
        if ("strong".equals(confidence)) return 2;
        if ("medium".equals(confidence)) return 1;
        return 0;
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }

    record Match(
            String candidateType,
            String correlationEntityId,
            List<BehaviorSignal> evidence,
            String evidenceConfidence,
            String decisionPath
    ) {
        String candidateCompletionKey() {
            return candidateType
                    + "\0"
                    + correlationEntityId
                    + "\0"
                    + evidence.subList(0, evidence.size() - 1).stream()
                            .map(signal -> value(signal.eventId))
                            .reduce((left, right) -> left + "|" + right)
                            .orElse("");
        }

        String terminalCompletionKey() {
            BehaviorSignal terminal = evidence.get(evidence.size() - 1);
            return candidateType
                    + "\0"
                    + correlationEntityId
                    + "\0"
                    + value(terminal.eventId);
        }
    }
}
