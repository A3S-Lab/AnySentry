import { useLang, useSite, withBase } from '@rspress/core/runtime';
import { AgentRuntimeStory } from './AgentRuntimeStory';
import { CapabilityMatrix } from './CapabilityMatrix';
import { CanvasGridEffect } from './CanvasGridEffect';
import { EvidenceCaseFile } from './EvidenceCaseFile';
import { FeatureRail } from './FeatureRail';
import { HeroProductDemo } from './HeroProductDemo';
import { copy, type HomeLabels, type Locale } from './home-copy';
import { Icon } from './icons';
import { InstallCommand } from './InstallCommand';
import { PageEffects } from './PageEffects';
import { SemanticTitle } from './SemanticTitle';

function formatHeroTitle(labels: HomeLabels, locale: Locale) {
  const heroTitle = [
    labels.hero.titleLine1,
    labels.hero.titleLead,
    labels.hero.titleFocus,
    labels.hero.titleTail,
  ].filter(Boolean);

  return heroTitle.join(locale === 'zh' ? '' : ' ');
}

function MarkdownHome({
  labels,
  locale,
}: {
  labels: HomeLabels;
  locale: Locale;
}) {
  const heroTitle = formatHeroTitle(labels, locale);

  return (
    <main>
      <h1>{heroTitle}</h1>
      <p>{labels.hero.body}</p>

      <h2>{labels.signature.title}</h2>
      <p>{labels.signature.body}</p>
      <h2>{labels.runtimeStory.title}</h2>
      <p>{labels.runtimeStory.body}</p>
      <h2>{labels.loop.title}</h2>
      <p>{labels.loop.body}</p>
      <h2>{labels.governance.title}</h2>
      <p>{labels.governance.body}</p>
      <h2>{labels.trust.title}</h2>
      <p>{labels.trust.body}</p>
    </main>
  );
}

function SectionLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="as-section-link" href={href}>
      <span>{label}</span>
      <Icon name="arrow" />
    </a>
  );
}

export function HomeLayout() {
  const rawLang = useLang();
  const locale: Locale = rawLang === 'zh' ? 'zh' : 'en';
  const labels = copy[locale];
  const { site } = useSite();
  const route = (pathname: string) => {
    const normalized = pathname.replace(/^\/+/, '');
    const prefix = locale === site.lang ? '' : locale;
    return withBase(`/${[prefix, normalized].filter(Boolean).join('/')}`);
  };

  if (import.meta.env.SSG_MD) {
    return <MarkdownHome labels={labels} locale={locale} />;
  }

  return (
    <main className="as-home">
      <PageEffects />
      <div className="as-global-grid" aria-hidden="true">
        <CanvasGridEffect
          cellSize={54}
          className="as-global-grid__canvas"
          intensity={0.68}
          interactionScope="page"
        />
      </div>

      <div className="as-home-canvas">
        <section className="as-hero">
          <div className="as-hero__copy">
            <div className="as-hero__main">
              <div className="as-eyebrow">
                <span />
                {labels.hero.eyebrow}
              </div>
              <h1
                aria-label={formatHeroTitle(labels, locale)}
                className="as-hero-title"
              >
                <span>{labels.hero.titleLine1}</span>
                <span>
                  {labels.hero.titleLead ? <>{labels.hero.titleLead} </> : null}
                  <strong>{labels.hero.titleFocus}</strong>{' '}
                  {labels.hero.titleTail}
                </span>
              </h1>
              <p>{labels.hero.body}</p>
              <div className="as-hero__actions">
                <a
                  className="as-button as-button--primary"
                  href={route('/guide/')}
                >
                  {labels.hero.primary}
                  <Icon name="arrow" />
                </a>
                <a
                  className="as-button as-button--secondary"
                  href="https://github.com/A3S-Lab/AnySentry"
                >
                  <Icon name="github" />
                  {labels.hero.secondary}
                </a>
              </div>
              <InstallCommand labels={labels.hero} />
              <div className="as-hero__support">
                <Icon name="check" />
                <span>{labels.hero.support}</span>
              </div>
            </div>
            <div
              className="as-hero__proof"
              aria-label={locale === 'zh' ? '项目事实' : 'Project facts'}
            >
              {labels.proof.map((fact, index) => (
                <span key={fact} className={index === 4 ? 'is-wide' : ''}>
                  <i />
                  {fact}
                </span>
              ))}
            </div>
          </div>
          <div className="as-hero__visual">
            <HeroProductDemo locale={locale} />
          </div>
        </section>

        <section className="as-home-block as-capabilities" id="capabilities">
          <CapabilityMatrix labels={labels} route={route} />
        </section>

        <section
          className="as-home-block as-runtime-story-section"
          id="agent-runtime-story"
        >
          <header className="as-home-section-head as-home-section-head--runtime">
            <div>
              <span className="as-section-eyebrow">
                {labels.runtimeStory.eyebrow}
              </span>
              <SemanticTitle lines={labels.runtimeStory.titleLines} />
              <SectionLink
                href={route('/safety-loop/')}
                label={labels.runtimeStory.detailLabel}
              />
            </div>
            <p>{labels.runtimeStory.body}</p>
          </header>
          <div className="as-agent-story-slot">
            <AgentRuntimeStory locale={locale} />
          </div>
        </section>

        <section className="as-home-block as-case-section" id="case-file">
          <header className="as-home-section-head as-home-section-head--compact as-home-section-head--case">
            <div>
              <span className="as-section-eyebrow">{labels.loop.eyebrow}</span>
              <SemanticTitle lines={labels.loop.titleLines} />
              <SectionLink
                href={route('/evidence/')}
                label={labels.loop.detailLabel}
              />
            </div>
            <p>{labels.loop.body}</p>
          </header>
          <EvidenceCaseFile labels={labels} locale={locale} />
        </section>

        <section className="as-home-block as-feature-section" id="governance">
          <header className="as-home-section-head as-home-section-head--governance">
            <div>
              <span className="as-section-eyebrow">
                {labels.governance.eyebrow}
              </span>
              <SemanticTitle lines={labels.governance.titleLines} />
              <SectionLink
                href={route('/architecture/')}
                label={labels.governance.detailLabel}
              />
            </div>
            <p>{labels.governance.body}</p>
          </header>
          <FeatureRail labels={labels} route={route} />
        </section>

        <section className="as-home-block as-boundaries" id="trust">
          <header className="as-home-section-head as-home-section-head--compact as-home-section-head--trust">
            <div>
              <span className="as-section-eyebrow">{labels.trust.eyebrow}</span>
              <SemanticTitle lines={labels.trust.titleLines} />
              <SectionLink
                href={route('/evidence/')}
                label={labels.trust.detailLabel}
              />
            </div>
            <p>{labels.trust.body}</p>
          </header>
          <div className="as-boundary-table">
            {labels.trust.items.map((item, index) => (
              <article key={item.code}>
                <span>0{index + 1}</span>
                <div className="as-boundary-table__code">
                  <Icon name={item.icon} />
                  <strong>{item.code}</strong>
                </div>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
                <ul>
                  {item.meta.map((meta) => (
                    <li key={meta}>
                      <Icon name="check" />
                      {meta}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="as-cta">
          <div>
            <span className="as-section-eyebrow">{labels.cta.eyebrow}</span>
            <h2>{labels.cta.title}</h2>
            <p>{labels.cta.body}</p>
          </div>
          <div className="as-cta__actions">
            <a className="as-button as-button--primary" href={route('/guide/')}>
              {labels.cta.primary}
              <Icon name="arrow" />
            </a>
            <a
              className="as-button as-button--secondary"
              href="https://github.com/A3S-Lab/AnySentry"
            >
              <Icon name="github" />
              {labels.cta.secondary}
            </a>
          </div>
        </section>

        <footer className="as-footer">
          <a href={route('/')}>
            <img
              alt="AnySentry"
              src={withBase('/anysentry-logo-horizontal-reversed.svg')}
            />
          </a>
          <span>{labels.footer}</span>
          <a href="https://github.com/A3S-Lab/AnySentry">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </footer>
      </div>
    </main>
  );
}
