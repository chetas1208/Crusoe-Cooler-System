import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, Eye, Radio } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { Chip, Eyebrow, Segmented } from './kit';
import { MiniMap } from './MiniMap';
import { SegmentStrip } from './Inspector';

/** Inside-pipe HUD. The 3D view is a rendered virtual viewpoint, lit only by the crawler's own lamp. */
export function PipeHud() {
  const mode = useView((s) => s.mode);
  const edgeId = useView((s) => s.pipeEdgeId);
  const cam = useView((s) => s.pipeCam);
  const setCam = useView((s) => s.setPipeCam);
  const exit = useView((s) => s.exitPipe);
  const probeS = useView((s) => s.pipeProbeS);
  const setProbe = useView((s) => s.setPipeProbe);
  const edge = useWorld((s) => (edgeId ? s.edgesById[edgeId] : undefined));
  const state = useWorld((s) => (edgeId ? s.assets[edgeId] : undefined));
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const incidents = useWorld((s) => s.incidents);
  // ride along: when the followed crawler crosses into the next segment, the bore view follows it
  const followId = useView((s) => s.followRobotId);
  const followSeg = useWorld((s) => (followId ? s.robots[followId]?.pose.segment_id : undefined));
  const followPassable = useWorld((s) => (followSeg ? !!s.edgesById[followSeg]?.robot_passable : false));
  useEffect(() => {
    const v = useView.getState();
    if (v.mode === 'pipe' && followSeg && followPassable && followSeg !== v.pipeEdgeId) useView.setState({ pipeEdgeId: followSeg, selectedId: followSeg });
  }, [followSeg, followPassable]);
  const crawler = useMemo(() => Object.values(robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === edgeId && r.mode !== 'DOCKED'), [robots, edgeId]);
  if (mode !== 'pipe' || !edge) return null;
  const mission = crawler?.mission_id ? missions[crawler.mission_id] : undefined;
  const s = crawler?.pose.s_m ?? probeS ?? Math.max((state?.fault?.location_s_m ?? edge.length_m / 2) - 1.1, 0.2);
  const occ = state?.fault?.occlusion ?? 0;
  const loc = state?.fault?.location_s_m ?? -99;
  const dep = occ * Math.exp(-(((s + 0.2 - loc) / 0.42) ** 2));
  const bore = edge.diameter_mm * (1 - Math.min(dep, 0.9));
  const obs = Object.values(incidents).flatMap((i) => i.evidence.filter((e) => e.kind === 'observation' && e.asset_id === edge.id));
  const rd = state?.readings ?? {};

  return (
    <AnimatePresence>
      <motion.div className="pipehud" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
        <div className="pipehud__vignette" />
        <div className="pipehud__grain" />
        <div className="pipehud__brackets"><i /><i /><i /><i /></div>

        <div className="pipehud__tl panel">
          <span className="rec"><i /> REC</span>
          <div>
            <div className="pipehud__cam">{crawler ? `${labelOfId(crawler.id)} · ${cam === 'front' ? 'Front camera' : 'Section view'}` : 'Service probe · no crawler in this segment'}</div>
            <div className="pipehud__sub">Virtual viewpoint rendered from simulator pose · lit only by the crawler's lamp</div>
          </div>
          <Segmented small group="pcam" value={cam} onChange={setCam} items={[{ id: 'front', label: 'Front cam' }, { id: 'section', label: 'Section' }]} />
        </div>

        <aside className="pipehud__left panel" data-inset="left">
          <Eyebrow style={{ marginBottom: 8 }}>{mission ? `Mission · ${mission.id}` : 'Mission'}</Eyebrow>
          {mission ? (
            <>
              <div className="mtitle">{mission.title}</div>
              <ol className="msteps">
                {mission.steps.map((st) => (
                  <li key={st.id} data-status={st.status}>
                    <i />
                    <span>{st.label}</span>
                    {st.result && <em>{st.result}</em>}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="empty__s">No active mission in this segment. The camera is a stationary service probe parked ahead of the suspected restriction.</div>
          )}
          <hr className="hr" style={{ margin: '14px 0' }} />
          <Eyebrow style={{ marginBottom: 8 }}>Tagged observations</Eyebrow>
          {obs.length === 0 ? (
            <div className="empty__s">None yet — the crawler tags findings as it inspects.</div>
          ) : (
            obs.slice(-4).map((o) => (
              <div key={o.id} className="obs"><Check size={12} className="tone-nominal" /> {o.summary}</div>
            ))
          )}
        </aside>

        <aside className="pipehud__right panel" data-inset="right">
          <div className="insp__secHead" style={{ marginBottom: 8 }}>
            <div>
              <Eyebrow>Segment</Eyebrow>
              <div style={{ fontSize: 17, fontWeight: 650, marginTop: 2 }}>{edge.label} <span style={{ color: 'var(--t3)', fontWeight: 500, fontSize: 12 }}>· {edge.name}</span></div>
            </div>
          </div>
          <SegmentStrip edge={edge} state={state} />
          <div style={{ marginTop: 10 }}><MiniMap width={304} height={196} focusEdge={edge.id} /></div>
          {!crawler && (
            <div style={{ marginTop: 12 }}>
              <Eyebrow style={{ marginBottom: 6 }}>Probe position · {s.toFixed(1)} m</Eyebrow>
              <input className="slider" type="range" min={0.2} max={Math.max(edge.length_m - 0.4, 0.5)} step={0.1} value={s} onChange={(e) => setProbe(Number(e.target.value))} aria-label="Probe position along the segment" />
            </div>
          )}
          <button className="btn" style={{ width: '100%', marginTop: 14 }} onClick={exit}>
            <ArrowLeft size={14} /> Return to facility <span className="kbd">esc</span>
          </button>
        </aside>

        <div className="pipehud__tele panel">
          {[
            ['Along segment', s.toFixed(1), 'm'],
            ['Pipe Ø', String(edge.diameter_mm), 'mm'],
            ['Bore ahead', bore.toFixed(0), 'mm', dep > 0.15 ? 'warning' : undefined],
            ['Flow velocity', (rd.velocity_m_s ?? 0).toFixed(2), 'm/s'],
            ['ΔP segment', (rd.dp_kpa ?? 0).toFixed(1), 'kPa'],
            ['Speed', (crawler?.pose.speed_m_s ?? 0).toFixed(2), 'm/s'],
          ].map(([l, v, u, tone]) => (
            <div key={l} className="tele">
              <span>{l}</span>
              <b className={`num${tone ? ` tone-${tone}` : ''}`}>{v}<em>{u}</em></b>
            </div>
          ))}
          <Chip sm tone="inpipe"><Radio size={10} /> {crawler ? ROBOT_MODE(crawler.mode) : 'PROBE'}</Chip>
        </div>
        <Eye size={0} />
      </motion.div>
    </AnimatePresence>
  );
}
const ROBOT_MODE = (m: string) => m.replace('_', ' ');
