import { useState } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';

export function SystemContextField({
  labels,
}: {
  labels: HomeLabels['hero']['visual'];
}) {
  const [paused, setPaused] = useState(false);
  const { containerRef, restart, setStep, step } = useAnimatedSequence({
    interval: 1300,
    length: labels.sequence.length,
    paused,
  });
  const contextStep = Math.min(2, Math.max(0, step - 1));
  const stageStep = Math.min(2, Math.max(0, step - 3));

  return (
    <figure
      className="as-decision-lens"
      aria-label={labels.aria}
      data-step={step}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      ref={containerRef}
    >
      <header className="as-decision-lens__bar">
        <span>
          <i aria-hidden="true" />
          {labels.live}
        </span>
        <code>{labels.trace}</code>
        <button
          type="button"
          onClick={restart}
          aria-label="Replay runtime judgment"
        >
          <Icon name="replay" />
        </button>
      </header>

      <div
        className="as-decision-lens__progress"
        role="tablist"
        aria-label={labels.aria}
      >
        {labels.sequence.map((item, index) => (
          <button
            aria-selected={step === index}
            className={
              step === index ? 'is-active' : index < step ? 'is-complete' : ''
            }
            key={item}
            onClick={() => setStep(index)}
            role="tab"
            type="button"
          >
            <span>0{index + 1}</span>
            <strong>{item}</strong>
            <i aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="as-decision-lens__body">
        <section
          className={`as-decision-lens__event ${step === 0 ? 'is-active' : step > 0 ? 'is-past' : ''}`}
        >
          <span>{labels.eventLabel}</span>
          <div>
            <Icon name="terminal" />
            <code>{labels.event}</code>
          </div>
          <small>{labels.eventMeta}</small>
        </section>

        <section
          className={`as-decision-lens__context ${step >= 1 && step <= 3 ? 'is-active' : step > 3 ? 'is-past' : ''}`}
        >
          <span>{labels.contextLabel}</span>
          <ol>
            {labels.contexts.map((context, index) => (
              <li
                className={
                  step >= index + 1
                    ? contextStep === index && step <= 3
                      ? 'is-active'
                      : 'is-reached'
                    : ''
                }
                key={context.key}
              >
                <span>0{index + 1}</span>
                <div>
                  <small>{context.key}</small>
                  <strong>{context.label}</strong>
                  <p>{context.value}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={`as-decision-lens__judgment ${step >= 4 ? 'is-active' : ''}`}
        >
          <header>
            <span>{labels.decision}</span>
            <Icon name="layers" />
          </header>
          <ol>
            {labels.stages.map((stage, index) => (
              <li
                className={
                  step >= 4 && index <= stageStep
                    ? index === stageStep
                      ? 'is-active'
                      : 'is-reached'
                    : ''
                }
                key={stage.tier}
              >
                <span>{stage.tier}</span>
                <div>
                  <strong>{stage.label}</strong>
                  <small>{stage.value}</small>
                </div>
                <i aria-hidden="true" />
              </li>
            ))}
          </ol>
        </section>

        <div
          className={`as-decision-lens__result ${step === labels.sequence.length - 1 ? 'is-active' : ''}`}
        >
          <div>
            <span>{labels.riskLabel}</span>
            <strong>{labels.risk}</strong>
          </div>
          <Icon name="arrow" />
          <div>
            <span>{labels.verdictLabel}</span>
            <strong>{labels.verdict}</strong>
            <small>{labels.guard}</small>
          </div>
        </div>
      </div>

      <figcaption className="as-decision-lens__facts">
        {labels.facts.map(([value, label]) => (
          <span key={label}>
            <strong>{value}</strong>
            <small>{label}</small>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
