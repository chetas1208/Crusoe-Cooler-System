import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, Check, ChevronUp, CircleAlert, History, Network, Pause, Play, Radio, ShieldCheck, TriangleAlert, WifiOff, X } from 'lucide-react';
import { enterReplay, exitReplay, playReplay, replayFrames, seekReplay, useReplay, useWorld, type FeedItem } from '@loopkeeper/core/store';
import { formatSimClock } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { Chip, Dot, Eyebrow, useTick } from './kit';
import { useUi } from './store';

const ICON: Record<FeedItem['kind'], typeof Bot> = { incident: TriangleAlert, mission: Bot, verify: ShieldCheck, approval: CircleAlert, agent: Network, system: Radio };

function FeedIcon({ item }: { item: FeedItem }) {
  const Icon = item.severity === 'ok' ? Check : ICON[item.kind];
  const tone = item.severity === 'ok' ? 'nominal' : item.severity === 'info' ? (item.kind === 'mission' ? 'inpipe' : 'accent') : item.severity;
  return <span className={`feed__icon tone-${tone}`}><Icon size={13} strokeWidth={2.2} /></span>;
}

function useAgentActivity() {
  return useWorld(
    useShallow((s) => {
      const out = { sentinel: 0, inpipe: 0, outrig: 0 };
      for (const t of Object.values(s.tasks)) if (t.status === 'working') out[t.role]++;
      return out;
    }),
  );
}

export function Ribbon() {
  const feed = useWorld((s) => s.feed);
  const drawer = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
  const act = useAgentActivity();
  const replay = useReplay((s) => s.active);
  const latest = feed[0];
  const focusIncident = useView((s) => s.focusIncident);
  const pin = useUi((s) => s.pin);
  const busy = useWorld((s) => s.simStatus);
  useTick(5000);

  const go = (it: FeedItem) => {
    if (it.incidentId) {
      pin(it.incidentId);
      focusIncident(it.incidentId);
    } else if (it.assetId) useView.getState().focusEntity(it.assetId);
  };

  return (
    <div className="ribbon-wrap">
      <div className="sr-only" role="status" aria-live="polite">{latest?.text ?? ''}</div>
      <ReplayBar />
      <AnimatePresence>
        {drawer && (
          <motion.div className="drawer panel" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
            <div className="drawer__head">
              <Eyebrow>Activity · latest first</Eyebrow>
              <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setDrawer(false)} aria-label="Close history"><X size={14} /></button>
            </div>
            <div className="drawer__list scroll">
              {feed.length === 0 && <div className="empty__s" style={{ padding: 16 }}>Nothing yet — the plant is running quietly.</div>}
              {feed.slice(0, 60).map((it) => (
                <button key={it.id} className="feed" onClick={() => go(it)}>
                  <FeedIcon item={it} />
                  <span className="feed__text">{it.text}</span>
                  <span className="feed__time mono">{formatSimClock(it.simTimeS).slice(3)}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="ribbon panel">
        <button className="ribbon__live" data-replay={replay} onClick={() => (replay ? void exitReplay() : enterReplay())} title={replay ? 'Return to live' : 'Replay recent history'}>
          {replay ? <History size={13} /> : <Dot tone={busy === 'paused' ? 'watch' : 'nominal'} pulse={busy !== 'paused'} />}
          {replay ? 'REPLAY' : busy === 'paused' ? 'PAUSED' : 'LIVE'}
        </button>
        <div className="ribbon__main" onClick={() => latest && go(latest)}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={latest?.id ?? 'none'} className="ribbon__item" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
              {latest ? (
                <>
                  <FeedIcon item={latest} />
                  <span className="ribbon__text">{latest.text}</span>
                </>
              ) : (
                <>
                  <span className="feed__icon tone-nominal"><Radio size={13} /></span>
                  <span className="ribbon__text" style={{ color: 'var(--t2)' }}>Plant running · SENTINEL is watching every sensor</span>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="agents">
          {(['sentinel', 'inpipe', 'outrig'] as const).map((r) => (
            <span key={r} className={`agent tone-${r}`} data-on={act[r] > 0} title={`${r.toUpperCase()} · ${act[r]} task${act[r] === 1 ? '' : 's'} working`}>
              <i />
              {r === 'sentinel' ? 'SEN' : r === 'inpipe' ? 'INP' : 'OUT'}
              {act[r] > 0 && <b>{act[r]}</b>}
            </span>
          ))}
        </div>
        <button className="icon-btn" style={{ width: 28, height: 28 }} data-active={drawer} onClick={() => setDrawer(!drawer)} aria-label="Toggle activity history" aria-pressed={drawer}>
          <ChevronUp size={16} style={{ transform: drawer ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
        </button>
      </div>
    </div>
  );
}

/* ───────────── replay scrubber ───────────── */

function ReplayBar() {
  const { active, index, playing, rate, count } = useReplay();
  const frames = replayFrames();
  const markers = useMemo(() => {
    const out: Array<{ i: number; tone: string; label: string }> = [];
    const seen = new Set<string>();
    frames.forEach((f, i) => {
      for (const inc of Object.values(f.incidents)) {
        if (!seen.has(inc.id)) {
          seen.add(inc.id);
          out.push({ i, tone: inc.severity === 'critical' ? 'critical' : inc.severity === 'warning' ? 'warning' : 'watch', label: `${inc.id} opened` });
        }
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, active]);
  const f = frames[index];
  const now = frames[frames.length - 1];
  return (
    <AnimatePresence>
      {active && f && (
        <motion.div className="replay panel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
          <button className="icon-btn" onClick={() => playReplay(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <div className="replay__track">
            <input type="range" min={0} max={Math.max(frames.length - 1, 1)} value={index} onChange={(e) => (playReplay(false), seekReplay(Number(e.target.value)))} aria-label="Replay position" />
            <div className="replay__marks">
              {markers.map((m) => (
                <i key={m.label} className={`tone-${m.tone}`} style={{ left: `${(m.i / Math.max(frames.length - 1, 1)) * 100}%` }} title={m.label} />
              ))}
            </div>
          </div>
          <div className="replay__time mono">
            <b>T+{formatSimClock(f.simTimeS)}</b>
            <span>{now ? `−${Math.max(0, Math.round((now.wall - f.wall) / 1000))} s` : ''}</span>
          </div>
          <button className="btn btn--sm" onClick={() => playReplay(playing, rate === 1 ? 4 : 1)}>
            ×{rate}
          </button>
          <button className="btn btn--sm btn--primary" onClick={() => void exitReplay()}>
            Return to live
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ───────────── notices & connection ───────────── */

export function NoticeToast() {
  const notice = useView((s) => s.notice);
  const [shown, setShown] = useState<typeof notice>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!notice) return;
    setShown(notice);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(null), 4200);
  }, [notice]);
  return (
    <AnimatePresence>
      {shown && (
        <motion.div key={shown.id} className="toast panel" data-tone={shown.tone} initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} role="status">
          <CircleAlert size={14} className={shown.tone === 'warn' ? 'tone-warning' : 'tone-accent'} />
          {shown.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ConnectionBanner() {
  const connection = useWorld((s) => s.connection);
  const stale = useWorld((s) => s.stale);
  const last = useWorld((s) => s.lastEventAt);
  useTick(1000);
  const bad = connection !== 'live' || stale;
  const secs = last ? Math.round((Date.now() - last) / 1000) : 0;
  return (
    <AnimatePresence>
      {bad && (
        <motion.div className="banner panel" data-tone={connection === 'offline' ? 'critical' : 'warning'} initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
          <WifiOff size={14} />
          <b>{connection === 'offline' ? 'OFFLINE' : connection === 'live' ? 'STALE' : 'RECONNECTING'}</b>
          <span>Showing the last valid snapshot{last ? ` · ${secs} s old` : ''}. Nothing here is being invented.</span>
          <Chip sm tone="warning">
            <span className="spinner" style={{ width: 9, height: 9 }} /> retrying
          </Chip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
