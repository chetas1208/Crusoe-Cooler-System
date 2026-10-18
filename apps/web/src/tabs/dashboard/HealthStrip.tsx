import { useId, type ReactNode } from 'react';
import { EyeOff } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { READING_META } from '@loopkeeper/core/contracts';
import { useTick } from '../../ui/kit';
import { IconButton } from '../../ui/kit/index';

/** A value with a keyboard- and hover-reachable "where does this come from" note. */
function Cell({ label, value, unit, note, dim, badge, tone }: { label: string; value: string; unit: string; note: ReactNode; dim: boolean; badge?: string; tone?: 'warn' | 'bad' }) {
  const id = useId();
  return (
    <div className="hs__cell" tabIndex={0} aria-describedby={id} data-dim={dim} data-tone={tone}>
      <span className="hs__label">{label}</span>
      <span className="hs__value num">
        {value}
        <small>{unit}</small>
      </span>
      {badge && <span className="hs__badge" data-tone={tone}>{badge}</span>}
      <div className="hs__tip panel" role="tooltip" id={id}>
        {note}
      </div>
    </div>
  );
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

/**
 * Live cooling health, straight from asset readings. Every number says where it was measured; there is no
 * composite score. When the stream stops, values stay on screen, dimmed, with the age of the last update.
 */
export function HealthStrip({ onHide }: { onHide(): void }) {
  const cdu = useWorld((s) => s.assets['cdu_01']?.readings);
  const trunk = useWorld((s) => s.assets['p_10']?.readings);
  const kpis = useWorld((s) => s.kpis);
  const connection = useWorld((s) => s.connection);
  const stale = useWorld((s) => s.stale);
  const lastAt = useWorld((s) => s.lastEventAt);
  const backend = useWorld((s) => s.health?.backend);
  const limits = useWorld((s) => s.topology?.limits);
  useTick(1000);

  const age = lastAt ? Date.now() - lastAt : Infinity;
  const offline = connection === 'offline';
  const state: 'live' | 'stale' | 'offline' | 'connecting' = offline ? 'offline' : connection === 'reconnecting' || connection === 'connecting' ? 'connecting' : stale ? 'stale' : 'live';
  const dim = state !== 'live';
  const src = backend === 'mock' ? 'Simulated plant (MOCK)' : 'Live backend';
  const when = lastAt ? `last update ${ago(age)} ago` : 'no update yet';

  const fmt = (v: number | undefined, metric: string) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(READING_META[metric]?.decimals ?? 1));
  const supply = cdu?.tcs_supply_c ?? kpis?.tcs_supply_c;
  const ret = cdu?.tcs_return_c ?? kpis?.tcs_return_c;
  const flow = cdu?.tcs_flow_kg_s ?? kpis?.tcs_flow_kg_s;
  const hasAbs = trunk?.pressure_kpa !== undefined;
  // thermal margin: the real value, always, with what it means. Negative = the hottest GPU is past its limit.
  const margin = kpis?.min_margin_k;
  const warnK = limits?.margin_warn_k ?? 11;
  const critK = limits?.margin_crit_k ?? 5;
  const mState = margin === undefined || Number.isNaN(margin) ? undefined : margin < 0 ? { badge: 'Unrecovered', tone: 'bad' as const } : margin < critK ? { badge: 'Critical', tone: 'bad' as const } : margin < warnK ? { badge: 'Low', tone: 'warn' as const } : undefined;
  const origin = (what: string) => (
    <>
      <b>{what}</b>
      <span>{src} · {when}</span>
    </>
  );

  return (
    <section className="hs panel" aria-label="Cooling loop health" data-state={state} data-inset="top">
      <Cell
        label="GPU margin"
        value={fmt(margin, 'margin_k')}
        unit="K"
        dim={dim}
        badge={mState?.badge}
        tone={mState?.tone}
        note={
          <>
            <b>Minimum thermal margin across racks</b>
            <span>Kelvin below the GPU throttle limit. Zero or negative means the hottest GPU is at or past its limit. Warning below {warnK} K, critical below {critK} K.</span>
            {mState?.badge === 'Unrecovered' && <span>The plant has not recovered: the value is real, not a display fault.</span>}
            <span>{src} · {when}</span>
          </>
        }
      />
      <Cell label="TCS supply" value={fmt(supply, 'tcs_supply_c')} unit="°C" dim={dim} note={origin('CDU-01 secondary outlet, reading tcs_supply_c. Coolant temperature going to the racks.')} />
      <Cell label="TCS return" value={fmt(ret, 'tcs_return_c')} unit="°C" dim={dim} note={origin('CDU-01 secondary inlet, reading tcs_return_c. Mixed outlet temperature of all racks.')} />
      <Cell label="TCS flow" value={fmt(flow, 'tcs_flow_kg_s')} unit="kg/s" dim={dim} note={origin('CDU-01 secondary loop, reading tcs_flow_kg_s. Total coolant mass flow.')} />
      {hasAbs ? (
        <Cell label="TCS pressure" value={fmt(trunk?.pressure_kpa, 'pressure_kpa')} unit="kPa" dim={dim} note={origin('TCS supply trunk P-10, reading pressure_kpa at the upstream end.')} />
      ) : (
        <Cell label="Trunk ΔP" value={fmt(trunk?.dp_kpa, 'dp_kpa')} unit="kPa" dim={dim} note={origin('TCS supply trunk P-10, reading dp_kpa. This backend does not report absolute pressure.')} />
      )}
      <div className="hs__fresh" data-state={state} role="status">
        <i />
        {state === 'live' && <span>Live · {ago(age)} ago</span>}
        {state === 'stale' && <span>Stale · no data for {ago(age)}</span>}
        {state === 'connecting' && <span>Reconnecting · {when}</span>}
        {state === 'offline' && <span>Offline · {when}</span>}
      </div>
      <IconButton size="sm" onClick={onHide} aria-label="Hide cooling health" icon={<EyeOff size={14} />} />
    </section>
  );
}
