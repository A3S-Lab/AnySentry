import { useState } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';
import { useAnimatedSequence } from './useAnimatedSequence';

export function GovernanceLoop({
  labels,
}: {
  labels: HomeLabels['governance'];
}) {
  const [paused, setPaused] = useState(false);
  const { containerRef, restart, setStep, step } = useAnimatedSequence({
    interval: 1900,
    length: labels.loop.length,
    paused,
  });
  const active = labels.loop[step];

  return (
    <div
      className="as-governance-sequence"
      data-path={active.path}
      data-step={step}
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
      <header className="as-governance-sequence__toolbar">
        <div>
          <i aria-hidden="true" />
          <span>
            {active.path === 'review'
              ? labels.paths[0].code
              : active.path === 'guard'
                ? labels.paths[1].code
                : labels.approval.label}
          </span>
          <strong>{active.title}</strong>
        </div>
        <button type="button" onClick={restart} aria-label={labels.replay}>
          <Icon name="replay" />
          <span>{labels.replay}</span>
        </button>
      </header>

      <div className="as-governance-sequence__stage">
        <svg
          aria-hidden="true"
          className="as-governance-sequence__routes"
          viewBox="0 0 1200 460"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="governance-review" x1="0" x2="1">
              <stop offset="0" stopColor="#2dd4bf" stopOpacity=".18" />
              <stop offset="1" stopColor="#65c7ff" stopOpacity=".9" />
            </linearGradient>
            <linearGradient id="governance-guard" x1="0" x2="1">
              <stop offset="0" stopColor="#f6c85f" stopOpacity=".9" />
              <stop offset="1" stopColor="#2dd4bf" stopOpacity=".3" />
            </linearGradient>
          </defs>
          <path className="is-review" d="M120 222H548" />
          <path className="is-guard" d="M652 222H1080" />
          <path
            className="is-return"
            d="M1080 260C1080 390 930 418 600 418S120 390 120 260"
          />
          <circle
            className="as-governance-sequence__packet is-review"
            cx="120"
            cy="222"
            r="6"
          />
          <circle
            className="as-governance-sequence__packet is-guard"
            cx="652"
            cy="222"
            r="6"
          />
        </svg>

        <section className="as-governance-rail as-governance-rail--review">
          <header>
            <span>{labels.paths[0].code}</span>
            <Icon name="search" />
          </header>
          <h3>{labels.paths[0].title}</h3>
          <p>{labels.paths[0].subtitle}</p>
          <ol>
            {labels.loop.slice(0, 3).map((item, index) => (
              <li
                className={
                  step === index
                    ? 'is-active'
                    : step > index
                      ? 'is-complete'
                      : ''
                }
                key={item.number}
              >
                <span>{item.number}</span>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.body}</small>
                </div>
                <i aria-hidden="true" />
              </li>
            ))}
          </ol>
        </section>

        <section
          className={`as-governance-core ${step === 3 ? 'is-active' : step > 3 ? 'is-complete' : ''}`}
        >
          <div className="as-governance-core__rings" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span>
            <Icon name="shield" />
          </span>
          <small>{labels.approval.label}</small>
          <h3>{labels.approval.title}</h3>
          <p>{labels.approval.body}</p>
          <ul>
            {labels.approval.meta.map((item) => (
              <li key={item}>
                <Icon name="check" />
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section className="as-governance-rail as-governance-rail--guard">
          <header>
            <span>{labels.paths[1].code}</span>
            <Icon name="action" />
          </header>
          <h3>{labels.paths[1].title}</h3>
          <p>{labels.paths[1].subtitle}</p>
          <ol>
            {labels.loop.slice(4).map((item, index) => {
              const realIndex = index + 4;
              return (
                <li
                  className={
                    step === realIndex
                      ? 'is-active'
                      : step > realIndex
                        ? 'is-complete'
                        : ''
                  }
                  key={item.number}
                >
                  <span>{item.number}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.body}</small>
                  </div>
                  <i aria-hidden="true" />
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      <footer className="as-governance-sequence__timeline">
        <ol>
          {labels.loop.map((item, index) => (
            <li key={item.number}>
              <button
                aria-current={step === index ? 'step' : undefined}
                aria-label={`${item.number} · ${item.title} · ${item.body}`}
                className={
                  step === index
                    ? 'is-active'
                    : index < step
                      ? 'is-complete'
                      : ''
                }
                onClick={() => setStep(index)}
                type="button"
              >
                <span>{item.number}</span>
                <strong>{item.title}</strong>
                <i aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </footer>
    </div>
  );
}
