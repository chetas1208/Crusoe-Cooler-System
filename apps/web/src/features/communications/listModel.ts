import type { CommunicationEventV1, Density } from './types';
import { isFailure } from './communicationStore';

/**
 * The feed is a flat list of display items (thread headers, messages, the new-messages divider) with fixed per-type heights,
 * so the virtual scroller can window it with prefix sums. Everything here is pure.
 */
export const ROW_H: Record<Density, number> = { comfortable: 82, compact: 48 };
export const HEAD_H = 40;
export const DIVIDER_H = 30;

export interface ThreadInfo {
  id: string;
  title: string;
  count: number;
  fails: number;
  firstMs: number;
  lastMs: number;
  collapsed: boolean;
}
export type Item =
  | { t: 'head'; key: string; thread: ThreadInfo; h: number }
  | { t: 'row'; key: string; e: CommunicationEventV1; depth: number; h: number }
  | { t: 'divider'; key: string; count: number; h: number };

export interface BuildOpts {
  grouped: boolean;
  collapsed: Record<string, boolean>;
  density: Density;
  depths: Map<string, number>;
  /** events after this seq get a "new messages" divider; null = no divider */
  newAfterSeq: number | null;
}
export interface Built {
  items: Item[];
  /** offsets[i] = top of item i, offsets[n] = total height */
  offsets: number[];
}

export const rowKey = (e: { run_id: string; seq: number }) => `${e.run_id}:${e.seq}`;

/**
 * Thread grouping: consecutive messages of one thread become a segment. A segment of two or more gets a collapsible header
 * (thread id, opening message, counts, sim-time span); a lone message stays flat. Collapse state is per thread id, so a
 * collapsed thread stays collapsed while it keeps talking (its header count still grows).
 */
export function buildItems(events: CommunicationEventV1[], o: BuildOpts): Built {
  const items: Item[] = [];
  const rowH = ROW_H[o.density];
  let dividerPlaced = o.newAfterSeq === null;
  const divider = () => {
    const count = events.reduce((n, e) => n + (e.seq > (o.newAfterSeq as number) ? 1 : 0), 0);
    items.push({ t: 'divider', key: 'new', count, h: DIVIDER_H });
    dividerPlaced = true;
  };
  const rowItem = (e: CommunicationEventV1): Item => ({ t: 'row', key: rowKey(e), e, depth: e.task_id ? o.depths.get(e.task_id) ?? 0 : 0, h: rowH });

  let i = 0;
  while (i < events.length) {
    const tid = events[i].thread_id;
    let j = i + 1;
    if (o.grouped && tid) while (j < events.length && events[j].thread_id === tid) j++;
    const seg = events.slice(i, j);
    const grouped = o.grouped && !!tid && seg.length >= 2;
    if (!grouped) {
      for (const e of seg) {
        if (!dividerPlaced && e.seq > (o.newAfterSeq as number) && items.length) divider();
        items.push(rowItem(e));
      }
    } else {
      const collapsed = !!o.collapsed[tid as string];
      const firstNew = seg.findIndex((e) => !dividerPlaced && e.seq > (o.newAfterSeq as number));
      if (firstNew === 0 && items.length && !dividerPlaced) divider();
      const info: ThreadInfo = {
        id: tid as string,
        title: seg[0].summary,
        count: seg.length,
        fails: seg.reduce((n, e) => n + (isFailure(e) ? 1 : 0), 0),
        firstMs: seg[0].sim_time_ms,
        lastMs: seg[seg.length - 1].sim_time_ms,
        collapsed,
      };
      items.push({ t: 'head', key: `h:${tid}:${seg[0].seq}`, thread: info, h: HEAD_H });
      if (!collapsed) {
        for (const e of seg) {
          if (!dividerPlaced && e.seq > (o.newAfterSeq as number)) divider();
          items.push(rowItem(e));
        }
      }
    }
    i = j;
  }
  const offsets = new Array<number>(items.length + 1);
  offsets[0] = 0;
  for (let k = 0; k < items.length; k++) offsets[k + 1] = offsets[k] + items[k].h;
  return { items, offsets };
}

/** first item index whose bottom edge is below `y` (binary search over prefix sums) */
export function indexAt(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** the scrollTop that brings item `i` fully into view with the least movement (unchanged when it already is) */
export function scrollToReveal(offsets: number[], i: number, top: number, viewport: number, pad = 6): number {
  const a = offsets[i];
  const b = offsets[i + 1];
  if (a === undefined || b === undefined) return top;
  if (a - pad < top) return Math.max(0, a - pad);
  if (b + pad > top + viewport) return b + pad - viewport;
  return top;
}

/** keyboard: j / k / arrows / Home / End over the navigable keys (messages and thread headers; never the divider) */
export function moveActive(keys: string[], current: string | null, move: number | 'first' | 'last'): string | null {
  if (!keys.length) return null;
  if (move === 'first') return keys[0];
  if (move === 'last') return keys[keys.length - 1];
  const i = current ? keys.indexOf(current) : -1;
  if (i < 0) return move > 0 ? keys[0] : keys[keys.length - 1];
  return keys[Math.max(0, Math.min(keys.length - 1, i + move))];
}
