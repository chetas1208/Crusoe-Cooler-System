import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { CommunicationsPanel } from '../communications/CommunicationsPanel';
import { useCommunicationsIngest } from '../communications/useRunCommunications';
import { useCommunications } from '../communications/communicationStore';
import { DodPanel, TeamPanel, useDodPolling } from '../dod/Panels';
import { ScorecardPanel } from '../scorecard/ScorecardPanel';
import { useRunsPolling } from '../../tabs/execution/controller';
import { useUi } from '../../ui/store';
import { BottomSheet, type SheetState } from './BottomSheet';
import { IconButton } from '../../ui/kit/index';
import { useLayoutMode } from './layout';
import { PANELS, closePanel, openPanel, useActivePanel, usePanelOpen, type PanelKey } from './panels';

/** Runs list is only polled by the Execution tab; Done / Team need the run id from anywhere, so poll it here for the other tabs. */
function RunsFeed() {
  useRunsPolling();
  return null;
}

function PanelBody({ k }: { k: PanelKey }) {
  if (k === 'comms') return <CommunicationsPanel variant="host" />;
  if (k === 'dod') return <DodPanel />;
  if (k === 'team') return <TeamPanel />;
  return <ScorecardPanel onClose={() => closePanel('scorecard')} inSheet />;
}

/** Tab strip: the same chrome in the dock, the drawer and the sheet. Every panel is one tap away from any other; arrows / Home / End move between tabs. */
function Tabs({ active }: { active: PanelKey }) {
  const conn = useCommunications((s) => s.conn);
  const unread = useCommunications((s) => s.unread);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = PANELS.findIndex((p) => p.key === active);
    const n = e.key === 'ArrowRight' ? (i + 1) % PANELS.length : e.key === 'ArrowLeft' ? (i + PANELS.length - 1) % PANELS.length : e.key === 'Home' ? 0 : e.key === 'End' ? PANELS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    openPanel(PANELS[n].key, false);
    requestAnimationFrame(() => document.getElementById(`ptab-${PANELS[n].key}`)?.focus());
  };
  return (
    <div className="phost__tabs" role="tablist" aria-label="Panels" onKeyDown={onKey}>
      {PANELS.map((p) => (
        <button key={p.key} type="button" role="tab" id={`ptab-${p.key}`} className="phost__tab" aria-selected={active === p.key} tabIndex={active === p.key ? 0 : -1} aria-controls="phost-body" data-testid={`ptab-${p.key}`} data-key={p.key} onClick={() => openPanel(p.key, false)} title={p.title}>
          {p.key === 'comms' && <i className="phost__dot" data-conn={conn} aria-hidden />}
          <span>{p.label}</span>
          {p.key === 'comms' && unread > 0 && active !== 'comms' && <span className="cm-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      ))}
    </div>
  );
}

function CloseBtn({ active }: { active: PanelKey }) {
  const title = PANELS.find((p) => p.key === active)!.title;
  return <IconButton className={`phost__close${active === 'comms' ? ' cm-x' : ''}`} size="sm" aria-label={active === 'comms' ? 'Close communications' : `Close ${title}`} onClick={() => closePanel(active)} icon={<X size={18} />} />;
}

/**
 * The single host for every side panel. One component, three presentations chosen by the layout model:
 *   dock   (>= 900 x 520, regular chrome): fixed to the right edge; the app shrinks beside it, so nothing is covered
 *   drawer (landscape, short):             slim right drawer, ~40 % width, full height
 *   sheet  (portrait):                     bottom sheet with peek / half / expanded snap points
 * Closing a panel only hides it: ingestion, polling, filters, scroll and the selected run live in their stores.
 */
export function PanelsHost() {
  const { host } = useLayoutMode();
  const active = useActivePanel();
  const open = usePanelOpen();
  const tab = useUi((s) => s.tab);
  const [snap, setSnap] = useState<SheetState>('half');
  const asideRef = useRef<HTMLElement>(null);
  useCommunicationsIngest();
  useDodPolling();
  useEffect(() => {
    document.documentElement.dataset.dock = active && host === 'dock' ? 'open' : 'closed';
    return () => void (document.documentElement.dataset.dock = 'closed');
  }, [active, host]);
  // opening / switching a panel moves keyboard focus into it, so Escape works from the keyboard for every panel (the sheet does this itself)
  useEffect(() => {
    const el = asideRef.current;
    if (el && active && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [active]);
  const needRuns = tab !== 'execution' && (open.dod || open.team);
  const feed = needRuns ? <RunsFeed /> : null;
  if (!active) return feed;
  const head: ReactNode = (
    <>
      <Tabs active={active} />
      <CloseBtn active={active} />
    </>
  );
  const body = (
    <div className="phost__body" id="phost-body" role="tabpanel" aria-labelledby={`ptab-${active}`}>
      <PanelBody k={active} />
    </div>
  );
  if (host === 'sheet')
    return (
      <>
        {feed}
        <BottomSheet className="phost phost--sheet" closeClass={active === 'comms' ? 'cm-x' : undefined} closeLabel={active === 'comms' ? 'Close communications' : `Close ${PANELS.find((p) => p.key === active)!.title}`} state={snap} onState={(s) => (s === 'closed' ? closePanel(active) : setSnap(s))} title={PANELS.find((p) => p.key === active)!.title} head={<Tabs active={active} />} onClose={() => closePanel(active)}>
          {body}
        </BottomSheet>
      </>
    );
  return (
    <>
      {feed}
      <aside ref={asideRef} tabIndex={-1} className={`phost phost--${host}`} aria-label="Panels" data-active={active} onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && closePanel(active)}>
        <header className="phost__head">{head}</header>
        {body}
      </aside>
    </>
  );
}
