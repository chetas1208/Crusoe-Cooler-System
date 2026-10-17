import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Box, Cable, Cpu, Eye, History, Search, Sparkles, TriangleAlert } from 'lucide-react';
import { enterReplay, useWorld } from '@loopkeeper/core/store';
import { useView } from '@loopkeeper/scene';
import { useUi } from './store';

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: typeof Bot;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.palette);
  const setOpen = useUi((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const topo = useWorld((s) => s.topology);
  const robots = useWorld((s) => s.robots);
  const incidents = useWorld((s) => s.incidents);

  const items = useMemo<Item[]>(() => {
    const v = useView.getState();
    const go = (id: string) => () => {
      v.select(id);
      v.focusEntity(id);
    };
    const list: Item[] = [
      {
        id: 'simulate-incident-prompt',
        group: 'Actions',
        label: '⚡ Simulate an incident (Natural Language)...',
        sub: 'Crusoe Nemotron + Laya Router scenario compiler',
        icon: Sparkles as any,
        run: () => {
          setOpen(false);
          useUi.getState().setLauncher(true);
        },
      },
    ];
    for (const i of Object.values(incidents)) list.push({ id: i.id, group: 'Incidents', label: `${i.id} · ${i.title}`, sub: i.status, icon: TriangleAlert, run: () => { useUi.getState().pin(i.id); v.focusIncident(i.id); } });
    for (const r of Object.values(robots)) list.push({ id: r.id, group: 'Robots', label: r.name, sub: r.class === 'inpipe' ? 'Internal crawler' : 'External maintainer', icon: Bot, run: go(r.id) });
    for (const a of topo?.assets ?? []) if (a.type !== 'dock') list.push({ id: a.id, group: 'Equipment', label: `${a.label} · ${a.name}`, sub: a.type, icon: Cpu, run: go(a.id) });
    for (const e of topo?.edges ?? []) list.push({ id: e.id, group: 'Pipes', label: `${e.label} · ${e.name}`, sub: e.robot_passable ? 'crawler-passable' : 'outside only', icon: Cable, run: go(e.id) });
    const views: Array<[string, () => void]> = [
      ['Structure cutaway', () => v.preset('structure')],
      ['Exterior view', () => v.preset('exterior')],
      ['Cooling network (x-ray)', () => v.preset('cooling')],
      ['Rack zone', () => v.preset('racks')],
      ['Mechanical plant', () => v.preset('plant')],
      ['Pipe interior (crawler)', () => v.preset('pipe')],
      ['Agent operations', () => v.setMode('agents')],
      ['Facility mode', () => v.setMode('facility')],
      ['Replay recent history', () => void enterReplay()],
    ];
    for (const [label, run] of views) list.push({ id: label, group: 'Views', label, icon: label.startsWith('Replay') ? History : label.includes('Agent') ? Eye : Box, run });
    return list;
  }, [topo, robots, incidents]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const pool = t ? items.filter((i) => `${i.label} ${i.sub ?? ''} ${i.group}`.toLowerCase().includes(t)) : items.filter((i) => i.group === 'Actions' || i.group === 'Views' || i.group === 'Incidents' || i.group === 'Robots');
    return pool.slice(0, 40);
  }, [items, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);
  useEffect(() => setIdx(0), [q]);

  const run = (i?: Item) => {
    if (!i) return;
    setOpen(false);
    i.run();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="palette__scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div
            className="palette panel"
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Command palette"
          >
            <div className="palette__input">
              <Search size={16} />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Jump to a rack, pipe, robot, incident…"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(i + 1, results.length - 1)));
                  else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)));
                  else if (e.key === 'Enter') run(results[idx]);
                  else if (e.key === 'Escape') setOpen(false);
                }}
              />
              <span className="kbd">esc</span>
            </div>
            <div className="palette__list scroll">
              {results.length === 0 && <div className="empty__s" style={{ padding: 20 }}>No match.</div>}
              {results.map((r, i) => (
                <button key={`${r.group}-${r.id}`} className="pitem" data-active={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => run(r)}>
                  <r.icon size={15} />
                  <span className="pitem__l">{r.label}</span>
                  <span className="pitem__g">{r.sub ?? r.group}</span>
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
