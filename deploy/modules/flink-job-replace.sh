#!/usr/bin/env bash
set -euo pipefail

jobmanager="${ANYSENTRY_FLINK_JOBMANAGER:-flink-jobmanager:8081}"
job_name="${ANYSENTRY_FLINK_JOB_NAME:-AnySentry Flink Shadow Risk}"
job_class="${ANYSENTRY_FLINK_JOB_CLASS:-org.a3s.anysentry.streaming.AnySentryStreamJob}"
job_jar="${ANYSENTRY_FLINK_JOB_JAR:-/opt/flink/usrlib/anysentry-flink-streaming.jar}"
replace_existing="${ANYSENTRY_FLINK_REPLACE_EXISTING_JOB:-true}"
restore_path="${ANYSENTRY_FLINK_RESTORE_PATH:-}"

until flink list -m "$jobmanager" >/dev/null 2>&1; do
    sleep 2
done

running_job_ids() {
    flink list -m "$jobmanager" -r 2>/dev/null \
        | awk -v expected="$job_name" '
            index($0, " : " expected " (") {
                for (field = 1; field <= NF; field += 1) {
                    if ($field ~ /^[[:xdigit:]]{32}$/) print $field
                }
            }
        '
}

submit_job() {
    local -a arguments=(run -d -m "$jobmanager" -c "$job_class")
    if [[ -n "$restore_path" ]]; then
        arguments+=(-s "$restore_path")
    fi
    arguments+=("$job_jar")
    flink "${arguments[@]}"
}

if [[ "$replace_existing" == "1" || "$replace_existing" == "true" || "$replace_existing" == "on" ]]; then
    while read -r job_id; do
        [[ -n "$job_id" ]] && flink cancel -m "$jobmanager" "$job_id"
    done < <(running_job_ids)
fi

if [[ -z "$(running_job_ids)" ]]; then
    submit_job
fi

while sleep 15; do
    if [[ -z "$(running_job_ids)" ]]; then
        submit_job || true
    fi
done
