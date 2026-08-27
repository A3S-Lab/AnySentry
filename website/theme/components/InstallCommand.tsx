import { useEffect, useState } from 'react';
import type { HomeLabels } from './home-copy';
import { Icon } from './icons';

export function InstallCommand({ labels }: { labels: HomeLabels['hero'] }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(labels.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="as-install">
      <span className="as-install__label">{labels.commandLabel}</span>
      <div className="as-install__command">
        <span>
          <code>{labels.command}</code>
        </span>
        <button
          aria-label={labels.copy}
          className="as-icon-button"
          onClick={copyCommand}
          type="button"
        >
          <Icon name={copied ? 'check' : 'terminal'} />
        </button>
      </div>
      <span aria-live="polite" className="as-sr-only">
        {copied ? labels.copied : ''}
      </span>
    </div>
  );
}
