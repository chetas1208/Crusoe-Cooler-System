import { useWorld } from '@loopkeeper/core/store';
import { useView } from '@loopkeeper/scene';
import { IncidentSheet } from './IncidentSheet';
import { Inspector } from './Inspector';
import { PipeSheet } from './PipeCam';

/** What the Live sheet shows: pipe telemetry inside a bore, else the selected object's inspector, else the pinned incident. */
export function SheetContent() {
  const mode = useView((s) => s.mode);
  const selected = useView((s) => s.selectedId);
  const known = useWorld((s) => (selected ? !!(s.robots[selected] || s.edgesById[selected] || s.assetsById[selected]) : false));
  if (mode === 'pipe') return <PipeSheet />;
  if (selected && known) return <Inspector id={selected} />;
  return <IncidentSheet />;
}
