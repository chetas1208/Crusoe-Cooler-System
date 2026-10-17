/**
 * Hall layout shared by the facility topology (facility.ts) and the plant model (plant.ts).
 * Kept free of imports so neither side creates a cycle.
 *
 * 2 rows x 8 liquid-fed racks. Four are instrumented GPU racks ("hero": faults, diagnosis, missions);
 * twelve are lighter network / storage / CPU racks on the same headers ("aux": hydraulics + thermals
 * simulated, no fault injection). One reserved bay per row is left for expansion.
 */
export const HALL = {
  minX: -10.5,
  maxX: 9.5,
  minZ: -6,
  maxZ: 6,
  height: 4.6,
  wallThickness: 0.3,
};

export const RACK = { w: 1.0, h: 2.3, d: 1.3 };
export const ROW_Z = { a: -2.65, b: 2.65 };
/** x-centres of every bay in a row (index 0 is the reserved expansion bay). */
export const BAY_X = [-2.1, -1.0, 0.1, 1.2, 2.3, 3.4, 4.5, 5.6, 6.7];
export const RACK_X = { a1: -1.0, a2: 0.1, b1: -1.0, b2: 0.1 };

export type ZoneKey = 'a' | 'b';

export interface RackSlot {
  /** short key: `a1`..`a8`, `b1`..`b8` (asset id is `rack_<key>`) */
  key: string;
  zone: ZoneKey;
  x: number;
  z: number;
  /** instrumented GPU rack (fault targets, diagnosis) */
  hero: boolean;
  /** design heat load, kW */
  kw: number;
  role: string;
  /** supply / return drop edge ids */
  supEdge: string;
  retEdge: string;
}

const HERO_EDGES: Record<string, [string, string]> = {
  a1: ['p_13', 'p_23'], a2: ['p_14', 'p_24'], b1: ['p_18', 'p_28'], b2: ['p_19', 'p_29'],
};
const AUX_ROLES: Array<[string, number]> = [
  ['Network fabric', 5],
  ['Storage', 8],
  ['CPU / inference', 11],
];

function buildSlots(): RackSlot[] {
  const out: RackSlot[] = [];
  for (const zone of ['a', 'b'] as const) {
    for (let n = 1; n <= 8; n++) {
      const key = `${zone}${n}`;
      const hero = n <= 2;
      const [sup, ret] = HERO_EDGES[key] ?? (zone === 'a' ? [`p_${30 + n - 2}`, `p_${40 + n - 2}`] : [`p_${50 + n - 2}`, `p_${60 + n - 2}`]);
      const [role, kw] = hero ? ['GPU training', 120] : AUX_ROLES[(n + (zone === 'a' ? 0 : 1)) % 3];
      out.push({ key, zone, x: BAY_X[n], z: ROW_Z[zone], hero, kw, role, supEdge: sup, retEdge: ret });
    }
  }
  return out;
}

export const RACK_SLOTS: RackSlot[] = buildSlots();
export const AUX_SLOTS: RackSlot[] = RACK_SLOTS.filter((s) => !s.hero);
export const SLOT_BY_KEY: Record<string, RackSlot> = Object.fromEntries(RACK_SLOTS.map((s) => [s.key, s]));
