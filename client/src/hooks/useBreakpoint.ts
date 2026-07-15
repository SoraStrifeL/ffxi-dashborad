import { useState, useEffect } from 'react';

export type Breakpoint = 'desktop' | 'tablet' | 'phone';

const QUERIES: Record<Breakpoint, string> = {
  desktop: '(min-width: 1024px)',
  tablet: '(min-width: 768px) and (max-width: 1023px)',
  phone: '(max-width: 767px)',
};

function resolve(): Breakpoint {
  if (window.matchMedia(QUERIES.desktop).matches) return 'desktop';
  if (window.matchMedia(QUERIES.tablet).matches) return 'tablet';
  return 'phone';
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(resolve);

  useEffect(() => {
    const mqls = Object.values(QUERIES).map((q) => window.matchMedia(q));
    const onChange = () => setBreakpoint(resolve());
    mqls.forEach((mql) => mql.addEventListener('change', onChange));
    onChange();
    return () => mqls.forEach((mql) => mql.removeEventListener('change', onChange));
  }, []);

  return breakpoint;
}
