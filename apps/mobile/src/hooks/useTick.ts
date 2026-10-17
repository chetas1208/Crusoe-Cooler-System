import { useEffect, useState } from 'react';

/** Re-render on an interval (wall clock countdowns). */
export function useTick(ms = 1000) {
  const [n, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}
