import { useState } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';

export function ContextComparison({
  labels,
}: {
  labels: HomeLabels['context'];
}) {
  const [paused, setPaused] = useState(false);
  const { containerRef, setStep, step } = useAnimatedSequence({
    interval: 5200,
    length: labels.comparison.contexts.length,
    paused,
  });
  const active = labels.comparison.contexts[step];

  return (
    <div
      className="as-context-compare"
      data-context={step}
      data-reveal
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      ref={containerRef}
    >
      <div className="as-context-compare__action">
        <div>
          <span>{labels.comparison.actionLabel}</span>
          <code>{labels.comparison.action}</code>
        </div>
        <i aria-hidden="true">
          <Icon name="terminal" />
        </i>
      </div>

      <div
        className="as-context-compare__switcher"
        role="tablist"
        aria-label={labels.comparison.switchLabel}
      >
        <span>{labels.comparison.switchLabel}</span>
        <div>
          {labels.comparison.contexts.map((context, index) => (
            <button
              aria-controls="as-context-panel"
              aria-selected={step === index}
              className={step === index ? 'is-active' : ''}
              id={`as-context-tab-${index}`}
              key={context.environment}
              onClick={() => setStep(index)}
              role="tab"
              type="button"
            >
              <span>0{index + 1}</span>
              {context.environment}
            </button>
          ))}
        </div>
      </div>

      <section
        aria-labelledby={`as-context-tab-${step}`}
        className={`as-context-stage ${step === 0 ? 'is-expected' : 'is-critical'}`}
        id="as-context-panel"
        role="tabpanel"
      >
        <div className="as-context-stage__system">
          <div className="as-context-stage__grid" aria-hidden="true" />
          <header>
            <span>SYSTEM CONTEXT / 0{step + 1}</span>
            <strong>{active.tone}</strong>
          </header>
          <div className="as-context-stage__host">
            <Icon name={step === 0 ? 'bundle' : 'network'} />
            <div>
              <strong>{active.environment}</strong>
              <small>{active.meta}</small>
            </div>
          </div>
          <ol>
            {active.signals.map(([key, value], index) => (
              <li
                key={key}
                style={{ '--context-index': index } as React.CSSProperties}
              >
                <span>0{index + 1}</span>
                <div>
                  <small>{key}</small>
                  <strong>{value}</strong>
                </div>
                <i aria-hidden="true" />
              </li>
            ))}
          </ol>
        </div>

        <div className="as-context-stage__verdict">
          <span>
            {step === 0 ? <Icon name="check" /> : <Icon name="shield" />}
          </span>
          <small>VERDICT</small>
          <strong>{active.verdict}</strong>
          <p>{active.reason}</p>
        </div>
      </section>

      <div className="as-context-equation" aria-label={labels.body}>
        {labels.comparison.equation.map((item, index) => (
          <div
            className={
              index === labels.comparison.equation.length - 1 ? 'is-result' : ''
            }
            key={item}
          >
            <span>0{index + 1}</span>
            <strong>{item}</strong>
            {index < labels.comparison.equation.length - 1 && (
              <i aria-hidden="true">+</i>
            )}
          </div>
        ))}
      </div>

      <div className="as-context-compare__facts">
        {labels.facts.map((fact) => (
          <div key={fact.label}>
            <strong>{fact.value}</strong>
            <span>{fact.label}</span>
            <small>{fact.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
