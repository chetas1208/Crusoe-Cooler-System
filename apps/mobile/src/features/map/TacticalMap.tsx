import { memo, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { Minus, Plus, Maximize2 } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useWorld, usePreviewDrive } from '@loopkeeper/core/store';
import type { AssetType, Robot } from '@loopkeeper/core/contracts';
import { buildPath, labelOfId, samplePath } from '@loopkeeper/core';
import { alpha, colors, toneColor, type Tone } from '@/theme';
import { PressableScale, T } from '@/components/ui';
import { useMapSel } from './store';

/**
 * 2D tactical map from /topology + streamed poses (ground plane: world x → right, world z → down).
 * It draws only what the backend reported: pipe centrelines, assets, nav obstacles, robots at their last pose.
 * Used on every platform; the 3D scene is an optional native-only alternative (see Map3D).
 */
const ASSET_FILL: Partial<Record<AssetType, string>> = { rack: '#2a3140', cdu: '#27424a', pump: '#2f4a3f', chiller: '#3a3a52', valve: '#4a4030', strainer: '#4a4030', sensor: '#33384a' };
const STATUS_TONE: Record<string, Tone> = { watch: 'watch', warning: 'warning', critical: 'critical', isolated: 'isolated', offline: 'isolated', service: 'service' };

const robotColor = (r: Robot) => (r.mode === 'FAILED' || r.mode === 'BLOCKED' || r.mode === 'SAFE_HOLD' || r.mode === 'ABORTED' ? colors.critical : r.class === 'inpipe' ? colors.inpipe : colors.outrig);

function TacticalMapBase({ height = 300 }: { height?: number }) {
  const topo = useWorld((s) => s.topology);
  const assetState = useWorld((s) => s.assets);
  const robots = useWorld(useShallow((s) => Object.values(s.robots)));
  const incidents = useWorld(useShallow((s) => Object.values(s.incidents).filter((i) => !i.closed_tick)));
  const selected = useMapSel((s) => s.selectedId);
  const select = useMapSel((s) => s.select);
  const ghost = usePreviewDrive((s) => s.ghostPose);
  const ghostActive = usePreviewDrive((s) => s.active);
  const ghostClass = usePreviewDrive((s) => s.robotClass);
  const edgesById = useWorld((s) => s.edgesById);
  const [box, setBox] = useState({ w: 0, h: height });
  const [zoom, setZoom] = useState(1);

  const f = topo?.facility;
  const view = useMemo(() => {
    if (!f) return null;
    const pad = 1.5;
    const x0 = f.bounds_min[0] - pad;
    const x1 = f.bounds_max[0] + pad;
    const z0 = f.bounds_min[2] - pad;
    const z1 = f.bounds_max[2] + pad;
    return { x0, z0, w: x1 - x0, h: z1 - z0 };
  }, [f]);

  const sel = selected ? robots.find((r) => r.id === selected) : undefined;
  if (!topo || !view || !f) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.line }}>
        <T v="caption" color={colors.t3}>
          Waiting for the facility topology…
        </T>
      </View>
    );
  }

  // viewBox: whole facility at zoom 1; zoomed views centre on the selected robot (or the facility centre)
  const vw = view.w / zoom;
  const vh = view.h / zoom;
  const cx = zoom > 1 && sel ? sel.pose.position_xyz_m[0] : view.x0 + view.w / 2;
  const cz = zoom > 1 && sel ? sel.pose.position_xyz_m[2] : view.z0 + view.h / 2;
  const vx = Math.min(Math.max(cx - vw / 2, view.x0), view.x0 + view.w - vw);
  const vz = Math.min(Math.max(cz - vh / 2, view.z0), view.z0 + view.h - vh);
  const unit = Math.max(vw / Math.max(box.w, 1), 0.01); // world metres per pixel — keeps strokes and labels a constant size on screen
  const px = (n: number) => n * unit;

  const interior = { x: f.interior_min[0], z: f.interior_min[2], w: f.interior_max[0] - f.interior_min[0], h: f.interior_max[2] - f.interior_min[2] };

  return (
    <View onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} style={{ height, borderRadius: 18, overflow: 'hidden', backgroundColor: '#0c0f15', borderWidth: 1, borderColor: colors.line }} accessibilityLabel="Tactical map of the facility">
      <Svg width="100%" height="100%" viewBox={`${vx} ${vz} ${vw} ${vh}`} preserveAspectRatio="xMidYMid meet">
        <Rect x={interior.x} y={interior.z} width={interior.w} height={interior.h} fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.14)" strokeWidth={px(1)} />
        {topo.nav.obstacles.map((o) => (
          <Rect key={o.id} x={o.rect[0]} y={o.rect[1]} width={o.rect[2] - o.rect[0]} height={o.rect[3] - o.rect[1]} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.08)" strokeWidth={px(0.6)} />
        ))}
        {topo.edges.map((e) => {
          const st = assetState[e.id]?.status;
          const tone = st ? STATUS_TONE[st] : undefined;
          const base = e.loop === 'fws' ? '#3b6ea8' : e.role === 'supply' ? '#2aa595' : '#b9774a';
          return <Polyline key={e.id} points={e.centerline_xyz_m.map((p) => `${p[0]},${p[2]}`).join(' ')} fill="none" stroke={tone ? toneColor[tone] : base} strokeOpacity={tone ? 0.95 : 0.55} strokeWidth={px(tone ? 2.4 : 1.4)} strokeLinejoin="round" />;
        })}
        {topo.assets
          .filter((a) => a.size_m && ASSET_FILL[a.type])
          .map((a) => {
            const [sx, , sz] = a.size_m!;
            const st = assetState[a.id]?.status;
            const tone = st ? STATUS_TONE[st] : undefined;
            const yaw = ((a.yaw_rad ?? 0) * 180) / Math.PI;
            return (
              <G key={a.id} rotation={yaw} originX={a.position_xyz_m[0]} originY={a.position_xyz_m[2]}>
                <Rect x={a.position_xyz_m[0] - sx / 2} y={a.position_xyz_m[2] - sz / 2} width={sx} height={sz} rx={px(2)} fill={tone ? alpha(toneColor[tone], 0.35) : ASSET_FILL[a.type]} stroke={tone ? toneColor[tone] : 'rgba(255,255,255,0.16)'} strokeWidth={px(tone ? 1.6 : 0.8)} />
              </G>
            );
          })}
        {incidents.map((i) => (
          <Circle key={i.id} cx={i.anchor.position_xyz_m[0]} cy={i.anchor.position_xyz_m[2]} r={px(10)} fill="none" stroke={i.severity === 'critical' ? colors.critical : colors.warning} strokeWidth={px(1.5)} strokeDasharray={`${px(4)} ${px(3)}`} />
        ))}
        {sel && sel.route_xyz_m && sel.route_xyz_m.length > 1 ? <Polyline points={sel.route_xyz_m.map((p) => `${p[0]},${p[2]}`).join(' ')} fill="none" stroke={colors.accent} strokeWidth={px(2)} strokeDasharray={`${px(6)} ${px(4)}`} strokeOpacity={0.8} /> : null}
        {robots.map((r) => {
          const [x, , z] = r.pose.position_xyz_m;
          const c = robotColor(r);
          const on = r.id === selected;
          const manual = r.control?.authority === 'HUMAN';
          const s = px(on ? 8 : 6);
          const yaw = r.pose.yaw_rad;
          return (
            <G key={r.id} onPress={() => select(on ? null : r.id)}>
              <Circle cx={x} cy={z} r={px(17)} fill="transparent" />
              {on ? <Circle cx={x} cy={z} r={px(12)} fill="none" stroke={colors.accent} strokeWidth={px(2)} /> : null}
              {manual ? <Circle cx={x} cy={z} r={px(10)} fill="none" stroke={colors.watch} strokeWidth={px(1.6)} strokeDasharray={`${px(3)} ${px(2)}`} /> : null}
              {r.class === 'inpipe' ? (
                <Polygon points={`${x},${z - s} ${x + s},${z} ${x},${z + s} ${x - s},${z}`} fill={c} stroke="#0c0f15" strokeWidth={px(1)} />
              ) : (
                <Rect x={x - s} y={z - s} width={s * 2} height={s * 2} rx={px(2)} fill={c} stroke="#0c0f15" strokeWidth={px(1)} />
              )}
              {r.class === 'outrig' ? <Line x1={x} y1={z} x2={x + Math.sin(yaw) * s * 1.8} y2={z + Math.cos(yaw) * s * 1.8} stroke="#0c0f15" strokeWidth={px(1.6)} /> : null}
              {on || zoom > 1.6 ? (
                <SvgText x={x} y={z - px(11)} fontSize={px(10)} fill={colors.t1} textAnchor="middle" fontWeight="600">
                  {labelOfId(r.id)}
                </SvgText>
              ) : null}
            </G>
          );
        })}
        {ghostActive && ghost ? (
          (() => {
            // a crawler's ghost moves along its pipe (s_m on the segment); an exterior robot's ghost moves on the floor
            const e = ghostClass === 'inpipe' && ghost.segment_id ? edgesById[ghost.segment_id] : undefined;
            const at = e && ghost.s_m !== undefined ? samplePath(buildPath(e.centerline_xyz_m, e.fillet_radius_m), ghost.s_m).p : ghost.position_xyz_m;
            return (
              <G>
                <Circle cx={at[0]} cy={at[2]} r={px(9)} fill={alpha(colors.watch, 0.25)} stroke={colors.watch} strokeWidth={px(1.8)} strokeDasharray={`${px(4)} ${px(3)}`} />
                {ghostClass === 'outrig' ? <Line x1={at[0]} y1={at[2]} x2={at[0] + Math.sin(ghost.yaw_rad) * px(16)} y2={at[2] + Math.cos(ghost.yaw_rad) * px(16)} stroke={colors.watch} strokeWidth={px(2)} /> : null}
              </G>
            );
          })()
        ) : null}
      </Svg>
      <View style={{ position: 'absolute', right: 10, top: 10, gap: 8 }}>
        {[
          { id: 'in', icon: Plus, label: 'Zoom in', on: () => setZoom((z) => Math.min(6, z * 1.6)) },
          { id: 'out', icon: Minus, label: 'Zoom out', on: () => setZoom((z) => Math.max(1, z / 1.6)) },
          { id: 'fit', icon: Maximize2, label: 'Fit', on: () => setZoom(1) },
        ].map((b) => (
          <PressableScale key={b.id} onPress={b.on} accessibilityRole="button" accessibilityLabel={b.label} scaleTo={0.92} style={{ width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(16,19,26,0.82)', borderWidth: 1, borderColor: colors.line2 }}>
            <b.icon size={16} color={colors.t1} />
          </PressableScale>
        ))}
      </View>
      <View style={{ position: 'absolute', left: 10, bottom: 8, flexDirection: 'row', gap: 12 }} pointerEvents="none">
        <T v="micro" color={colors.inpipe}>
          ◆ INPIPE
        </T>
        <T v="micro" color={colors.outrig}>
          ■ OUTRIG
        </T>
        <T v="micro" color={colors.t4}>
          2D tactical · simulated
        </T>
      </View>
    </View>
  );
}

export const TacticalMap = memo(TacticalMapBase);
