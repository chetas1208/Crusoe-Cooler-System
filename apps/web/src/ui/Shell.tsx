import { useEffect, useState } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from '@loopkeeper/scene';
import { LabelLayer } from './Callouts';
import { ZoneLabels } from './ZoneLabels';
import { CommandPalette } from './Palette';
import { ConnectionBanner, NoticeToast } from './Ribbon';
import { TabHost } from '../tabs/TabHost';
import { TopBar } from './TopBar';
import { GlobalScenarioLauncher } from './GlobalScenarioLauncher';
import { useControl } from '@loopkeeper/core/control';
import { useUi } from './store';

/** On shorter screens the inspector and incident card compete for the right column — let the inspector win. */
function useAutoCollapse() {
  const selected = useView((s) => s.selectedId);
  const mode = useView((s) => s.mode);
  const setCollapsed = useUi((s) => s.setCollapsed);
  useEffect(() => {
    if (mode !== 'facility') return;
    if (selected && window.innerHeight < 960) setCollapsed(true);
    else if (!selected) setCollapsed(false);
  }, [selected, mode, setCollapsed]);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      const ui = useUi.getState();
      const v = useView.getState();
      const w = useWorld.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPalette(!ui.palette);
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        ui.setPalette(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (['1', '2', '3', '4'].includes(e.key)) {
        // tab shortcuts stay live everywhere except while the operator is driving a robot
        const cs = useControl.getState().state;
        if (cs === 'MANUAL_DRIVING' || cs === 'MANUAL_ARMED') return;
      }
      switch (e.key) {
        case '1':
          ui.setTab('dashboard');
          break;
        case '2':
          ui.setTab('map');
          break;
        case '3':
          ui.setTab('agents');
          break;
        case '4':
          ui.setTab('execution');
          break;
        case 'x':
        case 'X':
          v.toggleXray();
          break;
        case 'r':
        case 'R':
          v.resetCamera();
          break;
        case 'f':
        case 'F': {
          if (v.followRobotId) return v.follow(null);
          const sel = v.selectedId && w.robots[v.selectedId] ? v.selectedId : null;
          const active = Object.values(w.robots).find((r) => r.mode !== 'DOCKED');
          const target = sel ?? active?.id;
          if (target) v.follow(target);
          else v.say('No robot is out on a mission right now — select one to follow it.');
          break;
        }
        case 'Escape':
          if (ui.launcher) ui.setLauncher(false);
          else if (ui.palette) ui.setPalette(false);
          else if (ui.panel) ui.setPanel(null);
          else if (ui.drawer) ui.setDrawer(false);
          else if (v.mode === 'pipe') v.exitPipe();
          else if (ui.tab === 'agents') (ui.setTask(null), ui.setTab('dashboard'));
          else if (v.followRobotId) v.follow(null);
          else if (v.selectedId) v.select(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useReducedMotion() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => useView.getState().setReducedMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
}

function Hint() {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem('lk.hint.v1') !== '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 16000);
    return () => clearTimeout(t);
  }, [shown]);
  const close = () => {
    setShown(false);
    try {
      localStorage.setItem('lk.hint.v1', '1');
    } catch {
      /* private mode */
    }
  };
  if (!shown) return null;
  return (
    <div className="hint panel">
      <div className="hint__t">The plant is already running</div>
      <div className="hint__s">
        Click any component to inspect it · <span className="kbd">2</span> ride inside a pipe with the crawler · <span className="kbd">3</span> watch the agents work · <span className="kbd">⌘K</span> search
      </div>
      <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={close} aria-label="Dismiss tip">×</button>
    </div>
  );
}

/** Tell the camera rig how much of the viewport the panels cover, so the focus is never hidden behind one. */
function useSafeArea() {
  useEffect(() => {
    const id = setInterval(() => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      let left = 0;
      let right = 0;
      let bottom = 0;
      let top = 70;
      document.querySelectorAll<HTMLElement>('[data-inset]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const side = el.dataset.inset;
        if (side === 'left') left = Math.max(left, r.right + 8);
        if (side === 'right') right = Math.max(right, W - r.left + 8);
        if (side === 'bottom') bottom = Math.max(bottom, H - r.top + 4);
        if (side === 'top') top = Math.max(top, r.bottom + 6);
      });
      const cur = useView.getState().insets;
      const next = { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom) };
      if (Math.abs(cur.left - next.left) > 3 || Math.abs(cur.right - next.right) > 3 || Math.abs(cur.bottom - next.bottom) > 3 || Math.abs(cur.top - next.top) > 3) useView.getState().setInsets(next);
    }, 180);
    return () => clearInterval(id);
  }, []);
}

export function Shell() {
  const phase = useWorld((s) => s.phase);
  const err = useWorld((s) => s.error);
  const tab = useUi((s) => s.tab);
  const setPalette = useUi((s) => s.setPalette);
  useKeyboard();
  useSafeArea();
  useAutoCollapse();
  useReducedMotion();

  if (phase !== 'ready')
    return (
      <div className="boot">
        <div className="boot__ring" />
        <div className="boot__t">{phase === 'error' ? 'Cannot reach the plant' : 'Loading the facility…'}</div>
        <div className="boot__s">{phase === 'error' ? err : 'Topology → snapshot → live stream'}</div>
      </div>
    );

  return (
    <>
      <ZoneLabels />
      <LabelLayer />
      <TopBar onPalette={() => setPalette(true)} />
      <ConnectionBanner />
      <TabHost />
      <NoticeToast />
      {tab === 'dashboard' && <Hint />}
      <CommandPalette />
      <GlobalScenarioLauncher />
    </>
  );
}
