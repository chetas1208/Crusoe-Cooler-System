/**
 * Dump contract-shaped fixtures from the TypeScript mock engine (the behavioural reference).
 * Used only by the API tests / FakeEngine so they exercise realistic payloads.
 *
 *   cd backend && ../node_modules/.bin/tsx scripts/dump_mock_fixtures.ts
 *
 * Output: backend/tests/fixtures/{topology,world,events}.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../packages/core/src/engine/engine';
import type { StreamEvent } from '../../packages/core/src/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'tests', 'fixtures');
fs.mkdirSync(out, { recursive: true });

const eng = new Engine({ seed: 8, speed: 6, faultsEnabled: false });
const events: StreamEvent[] = [];
eng.subscribe((e) => events.push(e));
eng.faults.begin('strainer_blockage' as never, undefined);
eng.fastForward(900);
eng.publishPoses();
eng.publishHeartbeat();

const KEEP_ALL = /^(incident\.|agent\.|verification\.|mission\.)/;
const seen: Record<string, number> = {};
const kept = events.filter((e) => {
  if (KEEP_ALL.test(e.type)) return true;
  seen[e.type] = (seen[e.type] ?? 0) + 1;
  return seen[e.type] <= 3;
});
// compact: keep at most ~400 events (drop repeated mission/agent updates beyond the cap)
const capped = kept.slice(0, 400);

fs.writeFileSync(path.join(out, 'topology.json'), JSON.stringify(eng.topology));
fs.writeFileSync(path.join(out, 'world.json'), JSON.stringify(eng.snapshot()));
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(capped));
console.log(`topology, world (seq ${eng.snapshot().last_seq}), ${capped.length}/${events.length} events`);
