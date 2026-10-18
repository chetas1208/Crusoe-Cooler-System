import { useEffect, useState } from 'react';

/** Re-render on an interval (wall clock countdowns). Returns the wall-clock time of the latest tick (ms). */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
