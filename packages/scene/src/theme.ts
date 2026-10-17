/** Shared colour language — 3D scene and both UIs read from here (frontend-ui.md §1). */
export const C = {
  bg: '#090b0f',
  bgTop: '#141922',
  floor: '#575e6b',
  floorDeep: '#444b57',
  wall: '#6b727f',
  wallTop: '#9aa2b0',
  concrete: '#8b9099',
  steel: '#9aa3b2',
  steelDark: '#4b525e',
  graphite: '#1f252d',
  graphiteLight: '#2c323b',
  rackFace: '#1b1f26',
  ghostRack: '#363d49',
  white: '#e9ecf1',
  safety: '#e8b93b',

  // fluids — separate visual channels per loop & direction (ASHRAE/OCP)
  tcsSupply: '#00d8f6', // Electric Coolant Cyan (secondary supply to cold plates)
  tcsReturn: '#f59e0b', // Warm Amber (secondary return from server heat)
  fwsSupply: '#2563eb', // Facility Water Blue (primary loop from cooling plant)
  fwsReturn: '#475569', // Darker Slate / Blue-Gray (primary return to plant)

  // semantic state
  nominal: '#41d6a3',
  watch: '#e7cb4b',
  warning: '#ff9a3c',
  critical: '#ff4f4f',
  isolated: '#8b93a7',
  service: '#a78bfa',

  // agents
  sentinel: '#a78bfa',
  inpipe: '#2fd3e8',
  outrig: '#ff9a3c',

  accent: '#5be3d0',
};

export const STATUS_COLOR: Record<string, string> = {
  nominal: C.nominal,
  watch: C.watch,
  warning: C.warning,
  critical: C.critical,
  offline: C.isolated,
  isolated: C.isolated,
  service: C.service,
};

export const fluidColor = (loop: 'fws' | 'tcs', role: 'supply' | 'return') =>
  loop === 'tcs' ? (role === 'supply' ? C.tcsSupply : C.tcsReturn) : role === 'supply' ? C.fwsSupply : C.fwsReturn;

/** thermal margin (K) → colour: cool teal → amber → red */
export function marginColor(marginK: number, warn = 11, crit = 5): string {
  if (marginK <= crit) return C.critical;
  if (marginK <= warn) return mix(C.warning, C.critical, (warn - marginK) / (warn - crit));
  if (marginK <= warn + 6) return mix(C.nominal, C.warning, 1 - (marginK - warn) / 6);
  return C.nominal;
}

export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
