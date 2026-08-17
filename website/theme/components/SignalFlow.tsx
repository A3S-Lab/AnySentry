import { useRef, useState, type KeyboardEvent } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';

const stageIcons = ['eye', 'identity', 'decision', 'action'] as const;

export function SignalFlow({ labels }: { labels: HomeLabels['loop'] }) {
  const [paused, setPaused] = useState(false);
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const { containerRef, setStep, step } = useAnimatedSequence({
    interval: 3100,
    length: labels.stages.length,
    paused,
  });
  const active = labels.stages[step];

  const moveFocus = (index: number) => {
    setStep(index);
    tabsRef.current[index]?.focus();
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return moveFocus(0);
    if (event.key === 'End') return moveFocus(labels.stages.length - 1);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    moveFocus(
      (index + direction + labels.stages.length) % labels.stages.length,
    );
  };

  return (
    <div
      className="as-evidence-workbench"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      ref={containerRef}
    >
      <header className="as-evidence-workbench__identity">
        <div>
          <span>{labels.identity.label}</span>
          <strong>{labels.identity.value}</strong>
        </div>
        <code>{labels.identity.trace}</code>
        <p>
          <Icon name="check" />
          {labels.identity.integrity}
        </p>
      </header>

      <div className="as-signal-flow">
        <div
          className="as-signal-flow__steps"
          role="tablist"
          aria-label={labels.title}
          aria-orientation="vertical"
        >
          {labels.stages.map((stage, index) => (
            <button
              aria-controls="as-signal-stage-panel"
              aria-selected={step === index}
              className={step === index ? 'is-active' : ''}
              id={`as-signal-stage-${index}`}
              key={stage.key}
              onClick={() => setStep(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              ref={(node) => {
                tabsRef.current[index] = node;
              }}
              role="tab"
              tabIndex={step === index ? 0 : -1}
              type="button"
            >
              <span className="as-signal-flow__number">{stage.number}</span>
              <span className="as-signal-flow__step-copy">
                <strong>{stage.title}</strong>
                <small>{stage.subtitle}</small>
              </span>
              <span className="as-signal-flow__step-icon">
                <Icon name={stageIcons[index]} />
              </span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>

        <div
          aria-labelledby={`as-signal-stage-${step}`}
          className={`as-signal-flow__panel is-${active.key}`}
          id="as-signal-stage-panel"
          role="tabpanel"
        >
          <div className="as-signal-flow__panel-top">
            <div>
              <span>{labels.input}</span>
              <strong>
                {active.title} <i aria-hidden="true">→</i> {active.subtitle}
              </strong>
            </div>
            <span className="as-demo-chip">{labels.synthetic}</span>
          </div>

          <div className="as-flow-map" aria-hidden="true">
            {labels.stages.map((stage, index) => (
              <div
                className={index <= step ? 'is-reached' : ''}
                key={stage.key}
              >
                <span>{stage.number}</span>
                <small>{stage.title}</small>
                {index < labels.stages.length - 1 && <i />}
              </div>
            ))}
          </div>

          <div className="as-record">
            <div className="as-record__header">
              <span>{labels.output}</span>
              <code>{active.key}.json</code>
            </div>
            <div className="as-record__body">
              <span className="as-record__brace">{'{'}</span>
              {active.rows.map(([key, value]) => (
                <div className="as-record__row" key={key}>
                  <span className="as-record__line" />
                  <code className="as-record__key">&quot;{key}&quot;</code>
                  <span>:</span>
                  <code
                    className={`as-record__value as-record__value--${active.key}`}
                  >
                    &quot;{value}&quot;
                  </code>
                </div>
              ))}
              <span className="as-record__brace">{'}'}</span>
            </div>
          </div>

          <div className="as-signal-flow__summary">
            <span>
              <Icon name={stageIcons[step]} />
            </span>
            <div>
              <small>{labels.whyLabel}</small>
              <p>{active.summary}</p>
            </div>
          </div>
        </div>
      </div>

      <footer className="as-evidence-workbench__audit">
        {labels.audit.map(([label, value], index) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            {index < labels.audit.length - 1 && <i aria-hidden="true" />}
          </div>
        ))}
      </footer>
    </div>
  );
}
