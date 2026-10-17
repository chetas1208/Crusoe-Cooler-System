import { useMemo } from 'react';
import { ArrowRight, Check, ShieldCheck, Wrench, X } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import { Chip } from '../../ui/kit';
import { familyOf, oneLine } from './status';
import type { Row } from './rows';

export function BottomRibbon({ rows, onSelect }: { rows: Row[]; onSelect(id: string): void }) {
  const incidents = useWorld((s) => s.incidents);
  const intel = useWorld((s) => s.health?.intelligence);
  const backend = useWorld((s) => s.health?.backend);

  const latest = useMemo(() => {
    let deleg: Row | undefined;
    let tool: { row: Row; i: number } | undefined;
    let toolTick = -1;
    const byId = new Map(rows.map((r) => [r.task.id, r]));
    for (const r of rows) {
      if (r.task.parent_id && (!deleg || r.task.started_tick >= deleg.task.started_tick)) deleg = r;
      r.task.tool_calls.forEach((c, i) => {
        if (c.status !== 'running' && c.tick >= toolTick) (toolTick = c.tick), (tool = { row: r, i });
      });
    }
    let ver: Incident | undefined;
    for (const i of Object.values(incidents)) if (i.verification && (!ver || (i.verification.completed_tick ?? i.verification.started_tick) >= (ver.verification!.completed_tick ?? ver.verification!.started_tick))) ver = i;
    return { deleg, from: deleg?.task.parent_id ? byId.get(deleg.task.parent_id) : undefined, tool, ver };
  }, [rows, incidents]);

  const call = latest.tool ? latest.tool.row.task.tool_calls[latest.tool.i] : undefined;
  const v = latest.ver?.verification;
  const nonLive = intel ? (intel.status === 'live' ? `Nemotron live · ${intel.model_id}` : intel.status === 'mock' ? 'Development simulator' : 'Autonomous Policy · Calibrated Safety') : null;

  return (
    <div className="ag-ribbon ag-panel" role="status" aria-label="Latest agent activity">
      <button className="ag-rc" disabled={!latest.deleg} onClick={() => latest.deleg && onSelect(latest.deleg.task.id)}>
        <span className="ag-rc__k">Delegated</span>
        {latest.deleg ? (
          <span className="ag-rc__v">
            <span style={{ color: familyOf(latest.from?.task.role ?? latest.deleg.task.role).color }}>{(latest.from?.task.role ?? latest.deleg.task.role).toUpperCase()}</span>
            <ArrowRight size={12} />
            <span style={{ color: familyOf(latest.deleg.task.role).color }}>{latest.deleg.task.role.toUpperCase()}</span>
            <span className="ag-rc__t">{latest.deleg.task.title}</span>
          </span>
        ) : (
          <span className="ag-rc__v ag-rc__v--mute">Nothing delegated yet</span>
        )}
      </button>
      <button className="ag-rc" disabled={!call} onClick={() => latest.tool && onSelect(latest.tool.row.task.id)}>
        <span className="ag-rc__k">Tool outcome</span>
        {call ? (
          <span className="ag-rc__v" data-bad={call.status === 'error' || call.status === 'rejected'}>
            {call.status === 'ok' ? <Check size={12} /> : <X size={12} />}
            <span className="mono">{call.name}</span>
            <span className="ag-rc__t">{call.output ? oneLine(call.output, 60) : call.status}</span>
          </span>
        ) : (
          <span className="ag-rc__v ag-rc__v--mute"><Wrench size={12} /> No tool calls yet</span>
        )}
      </button>
      <div className="ag-rc ag-rc--static">
        <span className="ag-rc__k">Verification</span>
        {v && latest.ver ? (
          <span className="ag-rc__v" data-v={v.status}>
            {v.status === 'verified' ? <ShieldCheck size={12} /> : v.status === 'rejected' ? <X size={12} /> : <span className="spinner" style={{ width: 10, height: 10 }} />}
            <span className="mono">{latest.ver.id}</span>
            <span className="ag-rc__t num">
              {v.status === 'pending' ? `checking, ${Math.round(v.progress * 100)}%` : `${v.status} · ${v.checks.filter((c) => c.pass).length} of ${v.checks.length} checks · attempt ${v.attempt}`}
            </span>
          </span>
        ) : (
          <span className="ag-rc__v ag-rc__v--mute">No verification run yet</span>
        )}
      </div>
      {nonLive && <Chip sm tone={intel?.status === 'live' ? 'nominal' : 'sentinel'} title={backend === 'mock' ? 'Development simulator is serving' : undefined}>{backend === 'mock' ? 'MOCK · ' : ''}{nonLive}</Chip>}
    </div>
  );
}
