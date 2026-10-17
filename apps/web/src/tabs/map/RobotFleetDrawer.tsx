import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { controlActions, useControl } from '@loopkeeper/core/control';
import { useMapCamera, type RobotCameraClass } from '@loopkeeper/scene';
import { SpatialMiniMap } from './SpatialMiniMap';
import { STATUS_FILTERS, activity, matchesQuery, type ClassFilter, type StatusFilter } from './fleetFilter';
import { Disc, Eye, Gauge, Navigation, ShieldAlert, Wrench } from 'lucide-react';

interface RobotFleetDrawerProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const chip = { fontSize: 10, padding: '2px 7px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 } as const;
const act = { flex: 1, padding: '3px 6px', fontSize: 10, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 } as const;

export function RobotFleetDrawer({ collapsed, onToggleCollapse }: RobotFleetDrawerProps) {
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const selectedRobotId = useMapCamera((s) => s.selectedRobotId);
  const selectCamRobot = useMapCamera((s) => s.selectRobot);
  const ctl = useControl();

  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null);
  const [query, setQuery] = useState('');

  // bring the selected row into view once per selection (not on every render: that forced a layout per pose update)
  useEffect(() => {
    if (selectedRobotId) listRef.current?.querySelector(`[data-robot="${selectedRobotId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedRobotId]);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => Object.values(robots).sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true })), [robots]);
  const leaseId = ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED' ? ctl.robotId : null;
  const inpipeCount = all.filter((r) => r.class === 'inpipe').length;
  const outrigCount = all.filter((r) => r.class === 'outrig').length;
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { working: 0, idle: 0, repairing: 0, manual: 0 };
    for (const r of all) {
      const a = activity(r, leaseId);
      for (const k of STATUS_FILTERS) if (a[k]) c[k]++;
    }
    return c;
  }, [all, leaseId]);
  const filteredList = all.filter(
    (r) => (classFilter === 'all' || r.class === classFilter) && (!statusFilter || activity(r, leaseId)[statusFilter]) && matchesQuery(r, query, r.mission_id ? missions[r.mission_id]?.title : undefined),
  );

  const handleSelect = (id: string, klass: RobotCameraClass) => {
    selectCamRobot(id, klass);
  };

  const handleTakeControl = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    selectCamRobot(id);
    void controlActions.takeControl(id);
  };

  const handleReleaseControl = (e: React.MouseEvent) => {
    e.stopPropagation();
    controlActions.release('operator_release');
  };

  if (collapsed) {
    return (
      <div
        className="map-drawer-collapsed panel"
        style={{
          width: 44,
          padding: '10px 4px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          background: 'rgba(10, 14, 22, 0.82)',
          backdropFilter: 'blur(12px)',
          borderRight: '1px solid rgba(255, 255, 255, 0.08)',
          cursor: 'pointer',
        }}
        onClick={onToggleCollapse}
        title="Expand Fleet Drawer"
      >
        <Navigation size={18} style={{ color: 'var(--c-cyan, #2fd3e8)' }} />
        <span
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            fontSize: '11px',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--t2)',
          }}
        >
          Fleet & Mini-Map
        </span>
      </div>
    );
  }

  return (
    <aside
      className="map-fleet-drawer panel"
        data-inset="left"
      style={{
        width: 290,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        background: 'rgba(10, 14, 22, 0.88)',
        backdropFilter: 'blur(14px)',
        borderRight: '1px solid rgba(255, 255, 255, 0.08)',
        overflow: 'hidden',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Navigation size={15} style={{ color: 'var(--c-cyan, #2fd3e8)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Fleet Selection
          </span>
        </div>
        {onToggleCollapse && (
          <button
            className="btn btn--ghost"
            style={{ padding: '2px 6px', fontSize: 11 }}
            onClick={onToggleCollapse}
            title="Collapse drawer"
          >
            Hide
          </button>
        )}
      </div>

      {/* search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${all.length} robots (id, segment, mission)`}
        aria-label="Search robots"
        style={{ width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 11, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: 'var(--t1)' }}
      />

      {/* filters: class chips + status chips (click again to clear) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {([['inpipe', `Internal (${inpipeCount})`], ['outrig', `External (${outrigCount})`]] as const).map(([k, label]) => (
          <button key={k} className={`btn ${classFilter === k ? 'btn--primary' : 'btn--ghost'}`} style={chip} aria-pressed={classFilter === k} onClick={() => setClassFilter(classFilter === k ? 'all' : k)}>
            {k === 'inpipe' ? <Disc size={11} /> : <Wrench size={11} />}
            {label}
          </button>
        ))}
        {STATUS_FILTERS.map((k) => (
          <button key={k} className={`btn ${statusFilter === k ? 'btn--primary' : 'btn--ghost'}`} style={{ ...chip, textTransform: 'capitalize' }} aria-pressed={statusFilter === k} onClick={() => setStatusFilter(statusFilter === k ? null : k)}>
            {k} {counts[k]}
          </button>
        ))}
      </div>

      {/* compact rows: one line per robot; only the selected row expands */}
      <div ref={listRef} role="listbox" aria-label="Fleet" style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 0', minHeight: 120, overflowY: 'auto', paddingRight: 2 }}>
        {filteredList.length === 0 && <div style={{ fontSize: 11, color: 'var(--t3)', padding: 8 }}>No robot matches these filters.</div>}
        {filteredList.map((r) => {
          const isSelected = r.id === selectedRobotId;
          const mission = r.mission_id ? missions[r.mission_id] : undefined;
          const isLeaseHolder = leaseId === r.id;
          const isPendingLease = ctl.robotId === r.id && ctl.state === 'LEASE_REQUESTED';
          const authority = isLeaseHolder ? 'HUMAN' : r.control?.authority ?? 'AUTO';
          const where = r.class === 'inpipe' ? (r.pose.segment_id ? `${r.pose.segment_id} ${(r.pose.s_m ?? 0).toFixed(1)}m` : 'docked') : `(${r.pose.position_xyz_m[0].toFixed(0)}, ${r.pose.position_xyz_m[2].toFixed(0)})`;
          return (
            <div key={r.id} role="option" aria-selected={isSelected} data-robot={r.id} onClick={() => selectCamRobot(r.id, r.class)} style={{ border: isSelected ? '1px solid #2fd3e8' : '1px solid transparent', background: isSelected ? 'rgba(47,211,232,0.08)' : 'rgba(255,255,255,0.025)', borderRadius: 6, padding: '5px 8px', cursor: 'pointer' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto auto', alignItems: 'center', gap: 7, fontSize: 11 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.class === 'inpipe' ? '#2fd3e8' : '#ff9a3c' }} />
                <span style={{ fontWeight: 700, fontSize: 12, color: isSelected ? '#fff' : 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.id}
                  <span style={{ fontWeight: 400, color: 'var(--t3)', marginLeft: 6 }}>{where}</span>
                </span>
                <span style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: authority === 'HUMAN' ? 'rgba(47,211,232,0.25)' : 'rgba(255,255,255,0.06)', color: authority === 'HUMAN' ? '#2fd3e8' : 'var(--t3)' }}>{authority === 'HUMAN' ? 'MANUAL' : r.mode}</span>
                <span style={{ color: r.battery_pct > 25 ? '#22c55e' : '#ef4444', minWidth: 28, textAlign: 'right' }}>{Math.round(r.battery_pct)}%</span>
              </div>
              {isSelected && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ fontSize: 11, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mission ? `Mission: ${mission.title}` : 'Standby / Autonomous Hold'}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn--ghost" style={act} onClick={(e) => (e.stopPropagation(), selectCamRobot(r.id, r.class))}>
                      <Eye size={11} /> Focus POV
                    </button>
                    {isLeaseHolder ? (
                      <button className="btn btn--danger" style={act} onClick={handleReleaseControl}>
                        <ShieldAlert size={11} /> Release
                      </button>
                    ) : (
                      <button className="btn btn--secondary" disabled={isPendingLease || r.battery_pct <= 8 || r.mode === 'WORKING'} style={act} onClick={(e) => handleTakeControl(e, r.id)}>
                        <Gauge size={11} /> {isPendingLease ? 'Claiming…' : 'Take Control'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Mini-Map */}
      <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t3)', marginBottom: 6 }}>
          Plan View & Centerlines
        </div>
        <SpatialMiniMap width={260} height={170} selectedRobotId={selectedRobotId} />
      </div>
    </aside>
  );
}
