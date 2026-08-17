import { useCallback, useEffect, useRef, useState } from 'react';

type SequenceOptions = {
  interval: number;
  length: number;
  paused?: boolean;
  reducedStep?: number;
};

export function useAnimatedSequence({
  interval,
  length,
  paused = false,
  reducedStep = length - 1,
}: SequenceOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(media.matches);
    updatePreference();
    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '120px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setStep(reducedStep);
      return;
    }
    if (!visible || paused) return;

    const timer = window.setInterval(
      () => setStep((current) => (current + 1) % length),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [
    generation,
    interval,
    length,
    paused,
    reducedMotion,
    reducedStep,
    visible,
  ]);

  const restart = useCallback(() => {
    setStep(0);
    setGeneration((current) => current + 1);
  }, []);

  return {
    containerRef,
    reducedMotion,
    restart,
    setStep,
    step,
  };
}
