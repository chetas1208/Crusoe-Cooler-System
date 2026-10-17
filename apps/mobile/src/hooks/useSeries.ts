import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';

export function useSeries(assetId: string | undefined, metric: string, take = 90): [number, number][] {
  const v = useWorld((s) => s.seriesVersion);
  return useMemo(() => {
    if (!assetId) return [];
    const arr = useWorld.getState().series[`${assetId}.${metric}`] ?? [];
    return arr.slice(-take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, metric, take, v]);
}
