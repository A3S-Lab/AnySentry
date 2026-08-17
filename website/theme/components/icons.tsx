import type { SVGProps } from 'react';

export type IconName =
  | 'action'
  | 'arrow'
  | 'bundle'
  | 'check'
  | 'decision'
  | 'eye'
  | 'github'
  | 'identity'
  | 'layers'
  | 'network'
  | 'pause'
  | 'play'
  | 'replay'
  | 'search'
  | 'shield'
  | 'terminal'
  | 'timeline';

const paths: Record<IconName, React.ReactNode> = {
  action: (
    <>
      <path d="M13 2 4.5 12.5H11L10 22l8.5-11H12l1-9Z" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  bundle: (
    <>
      <path d="M7 3h8l4 4v14H7z" />
      <path d="M15 3v5h5M10 13h6M10 17h6" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  decision: (
    <>
      <path d="M4 5h11M4 12h7M4 19h11" />
      <circle cx="18" cy="12" r="3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  github: (
    <path d="M12 2.8a9.2 9.2 0 0 0-2.9 17.9c.5.1.6-.2.6-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.3-2.3-.3-4.7-1.1-4.7-5.1 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.4.1 2.7.7.7 1.1 1.7 1.1 2.8 0 4-2.4 4.8-4.7 5.1.4.3.7 1 .7 2v3c0 .3.2.6.7.5A9.2 9.2 0 0 0 12 2.8Z" />
  ),
  identity: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2M19 4v4M17 6h4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </>
  ),
  network: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="m7 11 10-5M7 13l10 5" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7V5Z" />,
  replay: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-2 5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2 20 5v6c0 5-3 8.6-8 11-5-2.4-8-6-8-11V5l8-3Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M12 15h5" />
    </>
  ),
  timeline: (
    <>
      <path d="M5 3v18M5 7h7l3 3h4M5 17h6l3-3h5" />
      <circle cx="5" cy="7" r="1.5" />
      <circle cx="5" cy="17" r="1.5" />
    </>
  ),
};

export function Icon({
  name,
  ...props
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
