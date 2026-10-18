/**
 * Single shared display map for fault kinds: short label, one-line plain-language description, and a hazard class.
 * Import from '@loopkeeper/core' (or '@loopkeeper/core/faultLabels'). Always go through the helpers below for kinds that come off the
 * wire: the backend can emit kinds a given client build does not know yet, and those must render (humanized), never crash.
 */
import type { FaultKind } from './contracts';

export type FaultClass = 'degradation' | 'hazard' | 'facility';

export interface FaultInfo {
  /** Short title, e.g. for chips and table cells. */
  label: string;
  /** One or two plain-language sentences for tooltips, cards and the scenario library. */
  description: string;
  /** What operators should expect: `hazard` kinds can end CONTAINED_NOT_REPAIRED / PARTIAL / escalated rather than repaired. */
  class: FaultClass;
}

export const FAULT_INFO: Record<FaultKind, FaultInfo> = {
  fouling: { label: 'Pipe fouling', class: 'degradation', description: 'Deposit builds up inside a supply pipe, narrowing it so coolant flow falls and pressure drop rises.' },
  strainer_blockage: { label: 'Strainer blockage', class: 'degradation', description: 'Debris clogs a strainer basket, raising the pressure drop across it and starving downstream racks.' },
  valve_stuck: { label: 'Valve stuck', class: 'degradation', description: 'A rack balancing valve freezes part-open, so that rack gets too little coolant.' },
  pump_degradation: { label: 'Pump degradation', class: 'degradation', description: 'A pump wears: it delivers less head and flow and vibrates more.' },
  sensor_drift: { label: 'Sensor drift', class: 'degradation', description: 'A flow sensor slowly reads wrong, disagreeing with the redundant meters. The plant itself is fine.' },
  workload_spike: { label: 'Workload surge', class: 'degradation', description: 'A rack suddenly draws extra electrical power for a few minutes, producing more heat than cooling expects.' },
  leak: { label: 'Leak', class: 'hazard', description: 'Coolant escapes from a pipe. Inventory and pressure fall and a puddle can spread across a service route.' },
  manifold_leak: { label: 'Manifold leak', class: 'hazard', description: 'A coolant manifold or header is leaking or has ruptured. Pressure and inventory drop, a puddle spreads and can block robot routes. Repair needs the leaking zone isolated first.' },
  power_failure: { label: 'Power failure', class: 'hazard', description: 'A power feed is lost. Racks run briefly on UPS and are then tripped, or pumps on the dead feed stop. Power must be restored or load shed to protect compute.' },
  rack_thermal_runaway: { label: 'Rack thermal runaway', class: 'hazard', description: 'A rack overheats and starts smoking. Robots are kept out; the response is to detect, depower the rack, contain the smoke and escalate to humans. There is no automatic fire suppression.' },
  cdu_pump_backup_failure: { label: 'Pump and backup pump failure', class: 'hazard', description: 'A coolant distribution pump fails and its backup also fails to take over, so coolant circulation to its racks collapses.' },
  facility_heat_rejection_loss: { label: 'Heat rejection loss', class: 'facility', description: 'The facility chiller loses capacity, so heat cannot leave the building. Local repairs cannot fix it; the response is to curtail load and escalate.' },
};

const isKnown = (k: unknown): k is FaultKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(FAULT_INFO, k);

/** 'some_new_kind' -> 'Some new kind'. Safe for any input. */
export function humanizeKind(kind: unknown): string {
  if (typeof kind !== 'string' || !kind) return 'Unknown fault';
  const s = kind.replace(/[_-]+/g, ' ').trim().slice(0, 60);
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Unknown fault';
}

/** Display label; unknown kinds are humanized instead of throwing or rendering "undefined". */
export function faultLabel(kind: unknown): string {
  return isKnown(kind) ? FAULT_INFO[kind].label : humanizeKind(kind);
}

/** Plain-language description; unknown kinds get a neutral sentence. */
export function faultDescription(kind: unknown): string {
  return isKnown(kind) ? FAULT_INFO[kind].description : `${humanizeKind(kind)}: a fault type this app version has no description for yet.`;
}

export function faultClass(kind: unknown): FaultClass {
  return isKnown(kind) ? FAULT_INFO[kind].class : 'hazard';
}

/** True for kinds this client build was compiled with. */
export const isKnownFaultKind = isKnown;
export const KNOWN_FAULT_KINDS = Object.keys(FAULT_INFO) as FaultKind[];
