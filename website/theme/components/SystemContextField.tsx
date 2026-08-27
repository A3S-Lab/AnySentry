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
        <button type="button" onClick={restart} aria-label={labels.replay}>
          <Icon name="replay" />
        </button>
      </header>

      <div className="as-decision-lens__progress" aria-label={labels.aria}>
        {labels.sequence.map((item, index) => (
          <button
            aria-current={step === index ? 'step' : undefined}
            aria-label={`0${index + 1} · ${item}`}
            className={
              step === index ? 'is-active' : index < step ? 'is-complete' : ''
            }
            key={item}
            onClick={() => setStep(index)}
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
          className={`as-decision-lens__context ${step === 1 ? 'is-active' : step > 1 ? 'is-past' : ''}`}
        >
          <span>{labels.contextLabel}</span>
          <ol>
            {labels.contexts.map((context, index) => (
              <li
                className={
                  step >= 1
                    ? index === labels.contexts.length - 1 && step === 1
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
          className={`as-decision-lens__judgment ${step === 2 ? 'is-active' : step > 2 ? 'is-past' : ''}`}
        >
          <header>
            <span>{labels.decision}</span>
            <Icon name="layers" />
          </header>
          <ol>
            {labels.stages.map((stage, index) => (
              <li
                className={
                  step >= 2
                    ? index === labels.stages.length - 1 && step === 2
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
