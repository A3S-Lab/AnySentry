import { useEffect } from 'react';

export function PageEffects() {
  useEffect(() => {
    const root = document.documentElement;
    const home = document.querySelector<HTMLElement>('.as-home');
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>('[data-reveal]'),
    );
    root.classList.add('as-reveal-ready');

    const reducedMotionQuery = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    const finePointerQuery = window.matchMedia('(pointer: fine)');
    const reducedMotion = reducedMotionQuery.matches;
    let pointerFrame = 0;

    const movePointerLight = (event: PointerEvent) => {
      if (!home || reducedMotionQuery.matches || !finePointerQuery.matches) {
        return;
      }

      window.cancelAnimationFrame(pointerFrame);
      pointerFrame = window.requestAnimationFrame(() => {
        const x = event.clientX;
        const y = event.clientY;
        home.style.setProperty('--as-pointer-x', `${x}px`);
        home.style.setProperty('--as-pointer-y', `${y}px`);
        home.style.setProperty(
          '--as-pointer-shift-x',
          `${(x / window.innerWidth - 0.5) * 12}px`,
        );
        home.style.setProperty(
          '--as-pointer-shift-y',
          `${(y / window.innerHeight - 0.5) * 8}px`,
        );
        home.dataset.pointerActive = 'true';
      });
    };

    const hidePointerLight = () => {
      if (home) home.dataset.pointerActive = 'false';
    };

    if (home && !reducedMotion && finePointerQuery.matches) {
      window.addEventListener('pointermove', movePointerLight, {
        passive: true,
      });
      document.documentElement.addEventListener('mouseleave', hidePointerLight);
    }

    const cleanupPointer = () => {
      window.cancelAnimationFrame(pointerFrame);
      window.removeEventListener('pointermove', movePointerLight);
      document.documentElement.removeEventListener(
        'mouseleave',
        hidePointerLight,
      );
      home?.style.removeProperty('--as-pointer-x');
      home?.style.removeProperty('--as-pointer-y');
      home?.style.removeProperty('--as-pointer-shift-x');
      home?.style.removeProperty('--as-pointer-shift-y');
      if (home) delete home.dataset.pointerActive;
    };

    if (reducedMotion || !('IntersectionObserver' in window)) {
      targets.forEach((target) => target.classList.add('is-visible'));
      return () => {
        cleanupPointer();
        root.classList.remove('as-reveal-ready');
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          (entry.target as HTMLElement).classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    targets.forEach((target) => observer.observe(target));

    return () => {
      observer.disconnect();
      cleanupPointer();
      root.classList.remove('as-reveal-ready');
    };
  }, []);

  return null;
}
