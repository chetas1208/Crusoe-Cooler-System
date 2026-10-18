import { View } from 'react-native';
import { useWorld } from '@loopkeeper/core/store';
import { READING_META } from '@loopkeeper/core/contracts';
import { colors } from '@/theme';
import { useTick } from '@/hooks/useTick';
import { useLinkStatus } from '@/hooks/useConnection';
import { Dot, T } from '@/components/ui';

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

function Cell({ label, value, unit, dim }: { label: string; value: string; unit: string; dim: boolean }) {
  return (
    <View style={{ flex: 1, gap: 3, opacity: dim ? 0.5 : 1 }}>
      <T v="eyebrow" style={{ fontSize: 9.5 }}>
        {label}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <T v="num" style={{ fontSize: 19 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {value}
        </T>
        <T v="micro" color={colors.t3}>
          {unit}
        </T>
      </View>
    </View>
  );
}

/**
 * Live cooling health, straight from asset readings (CDU-01 secondary loop, trunk P-10). No composite score.
 * When the stream stops the values stay, dimmed, with the age of the last update — never a fake green heartbeat.
 */
export function HealthStrip() {
  const cdu = useWorld((s) => s.assets['cdu_01']?.readings);
  const trunk = useWorld((s) => s.assets['p_10']?.readings);
  const kpis = useWorld((s) => s.kpis);
  const lastAt = useWorld((s) => s.lastEventAt);
  const backend = useWorld((s) => s.health?.backend);
  const link = useLinkStatus();
  const now = useTick(1000);
  const age = lastAt ? Math.max(0, now - lastAt) : Infinity;
  const dim = link.degraded;
  const fmt = (v: number | undefined, metric: string) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(READING_META[metric]?.decimals ?? 1));
  const supply = cdu?.tcs_supply_c ?? kpis?.tcs_supply_c;
  const ret = cdu?.tcs_return_c ?? kpis?.tcs_return_c;
  const flow = cdu?.tcs_flow_kg_s ?? kpis?.tcs_flow_kg_s;
  const hasAbs = trunk?.pressure_kpa !== undefined;
  return (
    <View accessibilityLabel="Cooling loop health" style={{ padding: 14, gap: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Cell label="TCS supply" value={fmt(supply, 'tcs_supply_c')} unit="°C" dim={dim} />
        <Cell label="TCS return" value={fmt(ret, 'tcs_return_c')} unit="°C" dim={dim} />
      </View>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Cell label="TCS flow" value={fmt(flow, 'tcs_flow_kg_s')} unit="kg/s" dim={dim} />
        {hasAbs ? <Cell label="TCS pressure" value={fmt(trunk?.pressure_kpa, 'pressure_kpa')} unit="kPa" dim={dim} /> : <Cell label="Trunk ΔP" value={fmt(trunk?.dp_kpa, 'dp_kpa')} unit="kPa" dim={dim} />}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
        <Dot tone={link.tone} pulse={link.level === 'live'} size={7} />
        <T v="caption" color={link.degraded ? colors.warning : colors.t2} style={{ flex: 1 }} numberOfLines={1}>
          {link.level === 'live' || link.level === 'paused' ? `${link.label} · updated ${ago(age)} ago` : `${link.label} · ${lastAt ? `last update ${ago(age)} ago` : 'no update yet'}`}
        </T>
        {backend === 'mock' ? (
          <T v="micro" color={colors.watch}>
            MOCK
          </T>
        ) : null}
      </View>
    </View>
  );
}
