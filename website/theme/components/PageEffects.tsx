import { useEffect } from 'react';

const SURFACE_SELECTOR = [
  '.as-install__command',
  '.as-capability-card',
  '.as-case-file > article',
  '.as-feature-rail__tablist > button',
  '.as-boundary-table > article',
].join(',');

type PointerPosition = {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
};

export function PageEffects() {
  useEffect(() => {
    const home = document.querySelector<HTMLElement>('.as-home');
    if (!home) return undefined;

    const motionPreference = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    const hero = home.querySelector<HTMLElement>('.as-hero');
    let activeSurface: HTMLElement | null = null;
    let animationFrame = 0;
    let latestPointer: PointerPosition | null = null;

    const clearActiveSurface = () => {
      activeSurface?.classList.remove('is-pointer-active');
      activeSurface = null;
    };

    const paintPointer = () => {
      animationFrame = 0;
      const pointer = latestPointer;
      if (!pointer || motionPreference.matches) {
        clearActiveSurface();
        return;
      }

      const target =
        pointer.target instanceof Element ? pointer.target : undefined;
      const surface = target?.closest<HTMLElement>(SURFACE_SELECTOR) ?? null;

      if (surface && home.contains(surface)) {
        if (surface !== activeSurface) {
          clearActiveSurface();
          activeSurface = surface;
          surface.classList.add('is-pointer-active');
        }

        const bounds = surface.getBoundingClientRect();
        surface.style.setProperty(
          '--as-spot-x',
          `${pointer.clientX - bounds.left}px`,
        );
        surface.style.setProperty(
          '--as-spot-y',
          `${pointer.clientY - bounds.top}px`,
        );
      } else {
        clearActiveSurface();
      }

      if (hero && target && hero.contains(target)) {
        const bounds = hero.getBoundingClientRect();
        const x = ((pointer.clientX - bounds.left) / bounds.width) * 100;
        const y = ((pointer.clientY - bounds.top) / bounds.height) * 100;
        hero.style.setProperty(
          '--as-hero-x',
          `${Math.max(0, Math.min(x, 100))}%`,
        );
        hero.style.setProperty(
          '--as-hero-y',
          `${Math.max(0, Math.min(y, 100))}%`,
        );
      } else {
        hero?.style.removeProperty('--as-hero-x');
        hero?.style.removeProperty('--as-hero-y');
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      latestPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(paintPointer);
      }
    };

    const handlePointerLeave = () => {
      latestPointer = null;
      clearActiveSurface();
      hero?.style.removeProperty('--as-hero-x');
      hero?.style.removeProperty('--as-hero-y');
    };

    const handleMotionChange = () => {
      if (motionPreference.matches) handlePointerLeave();
    };

    home.dataset.premiumEffects = 'ready';
    home.addEventListener('pointermove', handlePointerMove);
    home.addEventListener('pointerleave', handlePointerLeave);
    motionPreference.addEventListener('change', handleMotionChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      clearActiveSurface();
      delete home.dataset.premiumEffects;
      home.removeEventListener('pointermove', handlePointerMove);
      home.removeEventListener('pointerleave', handlePointerLeave);
      motionPreference.removeEventListener('change', handleMotionChange);
    };
  }, []);

  return null;
}
