import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '@loopkeeper/core/engine';
import type { WorldSnapshot } from '@loopkeeper/core/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Load root .env
dotenv.config({ path: path.join(here, '../../../.env') });

const dbUrl = process.env.DATABASE_URL;

export interface NeonDbHealth {
  status: 'connected' | 'failed' | 'n/a';
  database?: string;
  branch?: string;
  user?: string;
  version?: string;
  latency_ms?: number;
  last_saved_at?: string;
  error?: string;
}

let sql: ReturnType<typeof neon> | null = null;
let dbHealth: NeonDbHealth = { status: dbUrl ? 'n/a' : 'n/a', branch: process.env.NEON_BRANCH ?? 'production' };
let lastSavedAt: string | null = null;

export function getNeonHealth(): NeonDbHealth {
  return { ...dbHealth, last_saved_at: lastSavedAt ?? undefined };
}

export async function initNeonDb(engine: Engine, seed: number): Promise<{ restored: boolean; sim_time_s?: number }> {
  if (!dbUrl) {
    console.log('[Neon] No DATABASE_URL found. Running in offline memory mode.');
    dbHealth = { status: 'n/a', branch: process.env.NEON_BRANCH ?? 'production' };
    return { restored: false };
  }

  try {
    sql = neon(dbUrl);
    const t0 = Date.now();
    const rows = (await sql`SELECT 1 as ok, current_database(), current_user, version()`) as Array<Record<string, unknown>>;
    const row = rows[0] || {};
    const latency = Date.now() - t0;

    dbHealth = {
      status: 'connected',
      database: String(row.current_database || 'neondb'),
      user: String(row.current_user || 'neondb_owner'),
      version: String(row.version || '').split(' ')[0] + ' ' + String(row.version || '').split(' ')[1],
      branch: process.env.NEON_BRANCH ?? 'production',
      latency_ms: latency,
    };

    console.log(`[Neon] Connected to ${dbHealth.database} on branch "${dbHealth.branch}" (${latency}ms)`);

    // Ensure mock_world_state table exists
    await sql`
      CREATE TABLE IF NOT EXISTS mock_world_state (
        facility_id text PRIMARY KEY,
        seed bigint NOT NULL,
        sim_time_s double precision NOT NULL,
        last_seq bigint NOT NULL,
        snapshot jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    // Attempt to restore state from Neon Postgres
    const stateRows = (await sql`
      SELECT seed, sim_time_s, last_seq, snapshot, updated_at
      FROM mock_world_state
      WHERE facility_id = 'lab_01'
    `) as Array<Record<string, unknown>>;

    if (stateRows && stateRows.length > 0) {
      const saved = stateRows[0];
      const savedSeed = Number(saved.seed);
      const savedSimTime = Number(saved.sim_time_s);
      if (savedSeed === seed && savedSimTime > 0) {
        const ff0 = Date.now();
        engine.fastForward(savedSimTime);
        lastSavedAt = new Date(String(saved.updated_at)).toISOString();
        console.log(`[Neon] ↺ Restored world from Neon DB (seed ${seed}) to sim t=${savedSimTime.toFixed(0)}s in ${Date.now() - ff0}ms`);
        return { restored: true, sim_time_s: savedSimTime };
      }
    }

    return { restored: false };
  } catch (err) {
    console.error('[Neon] Failed to connect or initialize Neon Postgres:', err);
    dbHealth = {
      status: 'failed',
      branch: process.env.NEON_BRANCH ?? 'production',
      error: err instanceof Error ? err.message : String(err),
    };
    return { restored: false };
  }
}

export async function persistToNeon(facilityId: string, seed: number, simTimeS: number, snapshot: WorldSnapshot): Promise<boolean> {
  if (!sql || dbHealth.status !== 'connected') return false;

  try {
    const snapJson = JSON.stringify(snapshot);
    await sql`
      INSERT INTO mock_world_state (facility_id, seed, sim_time_s, last_seq, snapshot, updated_at)
      VALUES (${facilityId}, ${seed}, ${simTimeS}, ${snapshot.last_seq}, ${snapJson}::jsonb, now())
      ON CONFLICT (facility_id) DO UPDATE SET
        seed = EXCLUDED.seed,
        sim_time_s = EXCLUDED.sim_time_s,
        last_seq = EXCLUDED.last_seq,
        snapshot = EXCLUDED.snapshot,
        updated_at = now()
    `;
    lastSavedAt = new Date().toISOString();
    return true;
  } catch (err) {
    console.error('[Neon] Failed to persist state to Neon Postgres:', err);
    return false;
  }
}

export async function queryNeonTest(): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (!sql) {
    if (!dbUrl) return { success: false, error: 'DATABASE_URL is not configured' };
    sql = neon(dbUrl);
  }
  try {
    const t0 = Date.now();
    const rows = (await sql`
      SELECT 
        current_database() as database,
        current_user as user,
        now() as server_time,
        (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') as tables_count
    `) as Array<Record<string, unknown>>;
    const latency = Date.now() - t0;
    return {
      success: true,
      data: {
        ...(rows[0] || {}),
        latency_ms: latency,
        branch: process.env.NEON_BRANCH ?? 'production',
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
