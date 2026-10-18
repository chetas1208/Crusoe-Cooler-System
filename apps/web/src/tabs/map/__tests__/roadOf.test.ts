import { describe, expect, it } from 'vitest';
import type { NavGraph } from '@loopkeeper/core/control';
import { nearestEdge } from '../roadOf';

const g: NavGraph = {
  kind: 'exterior',
  graph_revision: 'g',
  closed_edges: [],
  nodes: [],
  edges: [
    { id: 'E:ROAD-01:00', a: 'a', b: 'b', centerline_xz_m: [[7.4, -6], [21.6, -6]] },
    { id: 'E:ROAD-02:00', a: 'c', b: 'd', centerline_xz_m: [[7.4, -2], [21.6, -2]] },
    { id: 'E:XA-W:04', a: 'e', b: 'f', centerline_xz_m: [[5, -6], [5, 6]] },
  ],
};

describe('nearestEdge', () => {
  it('names the road whose centreline is nearest', () => {
    expect(nearestEdge(g, 12, -1.6)).toMatchObject({ id: 'E:ROAD-02:00', road: 'ROAD-02' });
    expect(nearestEdge(g, 5.1, 0)).toMatchObject({ id: 'E:XA-W:04', road: 'XA-W' });
  });
  it('reports the distance so a far pose can be called off-centreline', () => {
    expect(nearestEdge(g, 12, -4)!.dist).toBeCloseTo(2, 5);
  });
  it('returns null with no graph', () => {
    expect(nearestEdge(undefined, 0, 0)).toBeNull();
  });
});
