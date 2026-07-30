package org.a3s.anysentry.streaming;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.streaming.api.functions.co.BroadcastProcessFunction;
import org.apache.flink.util.Collector;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

public class SupplyChainEnrichmentFunction extends BroadcastProcessFunction<
        CanonicalEvent,
        SupplyChainRuntimeContext,
        CanonicalEvent
        > {
    public static final MapStateDescriptor<String, SupplyChainRuntimeContext> CONTEXT_STATE =
            new MapStateDescriptor<>(
                    "supply-chain-runtime-context",
                    String.class,
                    SupplyChainRuntimeContext.class
            );

    @Override
    public void processBroadcastElement(
            SupplyChainRuntimeContext context,
            Context functionContext,
            Collector<CanonicalEvent> output
    ) throws Exception {
        functionContext.getBroadcastState(CONTEXT_STATE)
                .put(context.workspacePathFingerprint, context);
    }

    @Override
    public void processElement(
            CanonicalEvent event,
            ReadOnlyContext context,
            Collector<CanonicalEvent> output
    ) throws Exception {
        if (blank(event.workspacePathFingerprint)) {
            output.collect(event);
            return;
        }
        SupplyChainRuntimeContext runtime = context
                .getBroadcastState(CONTEXT_STATE)
                .get(event.workspacePathFingerprint);
        if (runtime == null || !"complete".equals(runtime.assessmentStatus)) {
            output.collect(event);
            return;
        }
        event.supplyChainWorkspaceId = runtime.workspaceId;
        event.dependencySnapshotId = runtime.dependencySnapshotId;
        event.vulnerabilityAssessmentId = runtime.vulnerabilityAssessmentId;
        event.runtimeVulnerabilities = matches(event, runtime);
        if (!event.runtimeVulnerabilities.isEmpty()
                && (blank(event.behaviorStage)
                || "none".equals(event.behaviorStage)
                || "shell_execution".equals(event.behaviorStage))) {
            event.behaviorStage = "vulnerable_component_execution";
        }
        output.collect(event);
    }

    static List<CanonicalEvent.RuntimeVulnerabilityMatch> matches(
            CanonicalEvent event,
            SupplyChainRuntimeContext runtime
    ) {
        List<CanonicalEvent.RuntimeVulnerabilityMatch> matches = new ArrayList<>();
        for (SupplyChainRuntimeContext.Finding finding : runtime.findings) {
            MatchBasis basis = matchBasis(event, finding);
            if (basis == null) continue;
            CanonicalEvent.RuntimeVulnerabilityMatch match =
                    new CanonicalEvent.RuntimeVulnerabilityMatch();
            match.findingId = finding.findingId;
            match.dependencySnapshotId = runtime.dependencySnapshotId;
            match.vulnerabilityAssessmentId = runtime.vulnerabilityAssessmentId;
            match.ecosystem = finding.ecosystem;
            match.packageName = finding.packageName;
            match.version = finding.version;
            match.vulnerabilityId = finding.vulnerabilityId;
            match.aliases = finding.aliases == null
                    ? new ArrayList<>()
                    : new ArrayList<>(finding.aliases);
            match.confidence = basis.confidence;
            match.matchBasis = basis.reason;
            matches.add(match);
        }
        return matches;
    }

    private static MatchBasis matchBasis(
            CanonicalEvent event,
            SupplyChainRuntimeContext.Finding finding
    ) {
        String packageName = value(finding.packageName).toLowerCase(Locale.ROOT);
        String leaf = packageName.contains(":")
                ? packageName.substring(packageName.lastIndexOf(':') + 1)
                : packageName.contains("/")
                ? packageName.substring(packageName.lastIndexOf('/') + 1)
                : packageName;
        String normalizedLeaf = leaf.replace('_', '-');
        if (normalizedLeaf.length() < 3) return null;
        if (explicitNodeModuleMatch(event, packageName, normalizedLeaf)) {
            return new MatchBasis("high", "node_modules path");
        }

        String text = String.join(" ",
                value(event.executable),
                value(event.command),
                value(event.resource),
                value(event.subject)
        ).toLowerCase(Locale.ROOT).replace('\\', '/');
        String normalizedText = text.replace('_', '-');
        String version = value(finding.version).toLowerCase(Locale.ROOT);
        String escapedLeaf = Pattern.quote(normalizedLeaf);
        String escapedPackage = Pattern.quote(packageName.replace('_', '-'));
        if (normalizedText.contains("/node_modules/" + packageName.replace('_', '-') + "/")
                || normalizedText.contains("/node_modules/.bin/" + normalizedLeaf)
                || Pattern.compile("(?:^|[/\\s])node_modules/\\.bin/"
                + escapedLeaf + "(?:\\s|$)").matcher(normalizedText).find()) {
            return new MatchBasis("high", "node_modules path");
        }
        if (Pattern.compile("(?:^|/)(?:site|dist)-packages/(?:"
                + escapedPackage + "|" + escapedLeaf + ")(?:/|\\s|$)")
                .matcher(normalizedText).find()) {
            return new MatchBasis("high", "language package path");
        }
        if (!version.isBlank()
                && Pattern.compile("(?:^|/)" + escapedLeaf + "[-_]" + Pattern.quote(version)
                + "(?:\\.jar|/|\\s|$)").matcher(normalizedText).find()) {
            return new MatchBasis("high", "versioned component artifact");
        }
        String executable = value(event.executable)
                .toLowerCase(Locale.ROOT)
                .replaceAll("\\.(?:exe|cmd|bat)$", "");
        if (executable.equals(normalizedLeaf)) {
            return new MatchBasis("medium", "executable name");
        }
        if (Pattern.compile("(?:^|\\s)(?:npx|pnpm\\s+exec|yarn|bunx|cargo\\s+run\\s+-p|python\\s+-m)\\s+"
                + escapedLeaf + "(?:\\s|$)").matcher(normalizedText).find()) {
            return new MatchBasis("medium", "package runner argument");
        }
        return null;
    }

    static boolean explicitNodeModuleMatch(
            CanonicalEvent event,
            String packageName,
            String normalizedLeaf
    ) {
        if (value(event.executable).toLowerCase(Locale.ROOT)
                .endsWith("/node_modules/.bin/" + normalizedLeaf)) {
            return true;
        }
        String normalizedExecutable = value(event.executable)
                .toLowerCase(Locale.ROOT)
                .replace('\\', '/')
                .replace('_', '-');
        return normalizedExecutable.endsWith("/node_modules/.bin/" + normalizedLeaf)
                || normalizedExecutable.contains("/node_modules/"
                + packageName.replace('_', '-') + "/");
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static String value(String value) {
        return value == null ? "" : value;
    }

    private record MatchBasis(String confidence, String reason) {}
}
