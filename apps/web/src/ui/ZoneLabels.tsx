import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { roadSel, rowSel, siteModel, useMapCamera, useView } from '@loopkeeper/scene';
import { AnchoredLabel } from './anchors';

interface Room {
  id: string;
  name: string;
  kind: string;
  rect: [number, number, number, number];
}

const SHORT: Record<string, (r: Room) => string> = {
  hall: (r) => r.name.replace(/^server\s+/i, ''),
  mechanical: () => 'Mechanical',
  cdu: () => 'CDU zone',
  corridor: () => 'Service corridor',
  cross_aisle: (r) => (/west|^xa_w/i.test(r.name + r.id) ? 'XA-W' : 'XA-E'),
  yard: () => 'Heat rejection yard',
};

/** Floor-level zone names straight from /topology site.rooms (no ids parsed, nothing hard-coded). */
export function ZoneLabels() {
  const topo = useWorld((s) => s.topology);
  const mode = useView((s) => s.mode);
  const labels = useView((s) => s.layers.labels);
  const rooms = useMemo<Room[]>(() => ((topo as unknown as { site?: { rooms?: Room[] } } | null)?.site?.rooms ?? []), [topo]);
  const roads = useMemo(() => (topo ? siteModel(topo).roads : []), [topo]);
  const rows = useMemo(() => (topo ? siteModel(topo).pods.flatMap((p) => p.rows) : []), [topo]);
  const selected = useView((s) => s.selectedId);
  // robot POV / chase cameras show the floor from inside: no overview names there
  const robotCam = useMapCamera((s) => s.active && s.cameraMode !== 'tactical');
  const cdus = useMemo(() => (topo ? topo.assets.filter((a) => a.type === 'cdu') : []), [topo]);
  if (!labels || mode !== 'facility' || !rooms.length || robotCam) return null;
  // roads get their own compact markers, so the big hall / road room names are not repeated on top of the racks
  const shown = rooms.filter((r) => r.kind !== 'road' && !(r.kind === 'hall' && roads.length > 0));
  return (
    <div className="zones" aria-hidden>
      {roads.map((rd, i) => (
        <AnchoredLabel key={rd.id} get={() => [rd.x1 + 0.8, 0.1, (rd.z0 + rd.z1) / 2]} priority={5}>
          <button type="button" className="zone zone--road" title={`${rd.roadId ?? `ROAD-0${i + 1}`}: select road`} onClick={() => useView.getState().select(roadSel(rd.roadId ?? rd.id))}>{(rd.roadId ?? `ROAD-0${i + 1}`).replace('ROAD-0', 'R')}</button>
        </AnchoredLabel>
      ))}
      {cdus.map((c) => (
        <AnchoredLabel key={c.id} get={() => [c.position_xyz_m[0], (c.size_m?.[1] ?? 2.2) + 0.5, c.position_xyz_m[2]]} priority={9}>
          <button type="button" className="zone zone--cdu" title="CDU: select" onClick={() => useView.getState().select(c.id)}>{c.label}</button>
        </AnchoredLabel>
      ))}
      {rows.map((r) => {
        const rid = r.rowId ?? r.id;
        return (
          <AnchoredLabel key={rid} get={() => [r.x0 - 0.9, 0.1, r.z]} priority={selected === rowSel(rid) ? 12 : 4}>
            <button type="button" className="zone zone--row" data-on={selected === rowSel(rid)} title={`${rid}: select row`} onClick={() => useView.getState().select(rowSel(rid))}>
              {rid.replace('ROW-0', 'Row ')}
            </button>
          </AnchoredLabel>
        );
      })}
      {shown.map((r) => {
        const [x0, z0, x1, z1] = r.rect;
        // names sit on the empty strip at the north edge of the room, never on top of the equipment or the rack rows
        const at: [number, number, number] = [(x0 + x1) / 2, 0.08, r.kind === 'corridor' || r.kind === 'cross_aisle' || r.kind === 'mechanical' ? z0 + 0.9 : (z0 + z1) / 2];
        return (
          <AnchoredLabel key={r.id} get={() => at}>
            <span className="zone" data-kind={r.kind}>{(SHORT[r.kind]?.(r) ?? r.name).toUpperCase()}</span>
          </AnchoredLabel>
        );
      })}
    </div>
  );
}
