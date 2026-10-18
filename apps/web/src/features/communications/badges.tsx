import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Activity, Ban, Bot, BrainCircuit, Check, CheckCheck, CircleAlert, CircleCheck, CircleDashed, CircleX, ClipboardList, Copy, Cpu, Eye, Hand, HeartPulse, Info, Lightbulb, Link2, MessageSquare, OctagonX, Play, Radio,
  RefreshCw, ScrollText, SearchCheck, ShieldAlert, ShieldCheck, Terminal, ThumbsDown, ThumbsUp, TriangleAlert, Wrench, Zap,
} from 'lucide-react';
import { Badge, IconButton } from '../../ui/kit/index';
import type { Tone as KitTone } from '../../ui/kit/index';
import { eventKind, kindLabel, outcomeOf, type MsgChip, type Outcome, type Tone } from './format';
import type { CommunicationEventV1, Party } from './types';

const KT: Record<Tone, KitTone> = { bad: 'critical', good: 'nominal', warn: 'warning', info: 'info', mute: 'neutral' };
const CLASS_KT: Record<string, KitTone> = { sentinel: 'sentinel', inpipe: 'inpipe', outrig: 'outrig', operator: 'accent', verifier: 'nominal', provider: 'info', system: 'isolated' };

type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean; strokeWidth?: number }>;

/** Every envelope kind has its own glyph plus its text; colour only reinforces. Unknown kinds fall back to a generic message glyph. */
export const KIND_ICON: Record<string, { icon: Icon; tone: Tone }> = {
  TASK_ASSIGN: { icon: ClipboardList, tone: 'info' },
  ACK: { icon: CheckCheck, tone: 'mute' },
  OBSERVATION: { icon: Eye, tone: 'mute' },
  HYPOTHESIS: { icon: Lightbulb, tone: 'info' },
  REQUEST_TOOL: { icon: Wrench, tone: 'info' },
  TOOL_ACCEPTED: { icon: CircleCheck, tone: 'good' },
  TOOL_REJECTED: { icon: Ban, tone: 'bad' },
  PROPOSE_PLAN: { icon: ScrollText, tone: 'info' },
  PLAN_APPROVED: { icon: ThumbsUp, tone: 'good' },
  PLAN_REJECTED: { icon: ThumbsDown, tone: 'bad' },
  SAFETY_VETO: { icon: ShieldAlert, tone: 'bad' },
  PROGRESS: { icon: Activity, tone: 'mute' },
  REPLAN: { icon: RefreshCw, tone: 'warn' },
  VERIFICATION_REQUEST: { icon: SearchCheck, tone: 'info' },
  VERIFICATION_RESULT: { icon: ShieldCheck, tone: 'good' },
  ESCALATION: { icon: TriangleAlert, tone: 'warn' },
  STOP: { icon: OctagonX, tone: 'warn' },
  HEARTBEAT: { icon: HeartPulse, tone: 'mute' },
  MODEL_ERROR: { icon: BrainCircuit, tone: 'bad' },
  HUMAN_OVERRIDE: { icon: Hand, tone: 'warn' },
  // V10 message types, when no envelope kind came with them
  agent_message: { icon: MessageSquare, tone: 'mute' },
  task_transition: { icon: ClipboardList, tone: 'mute' },
  tool_event: { icon: Terminal, tone: 'info' },
  verification: { icon: ShieldCheck, tone: 'good' },
  safety: { icon: ShieldAlert, tone: 'warn' },
  operator: { icon: Hand, tone: 'info' },
  simulation: { icon: Play, tone: 'mute' },
  provider: { icon: Cpu, tone: 'mute' },
};
const FALLBACK = { icon: MessageSquare, tone: 'mute' as Tone };

export function KindPill({ e, iconOnly }: { e: Pick<CommunicationEventV1, 'kind' | 'message_type'>; iconOnly?: boolean }) {
  const k = eventKind(e);
  const m = KIND_ICON[k] ?? FALLBACK;
  const I = m.icon;
  const label = kindLabel(k);
  return (
    <Badge tone={KT[m.tone]} sm icon={<I size={12} aria-hidden strokeWidth={2.2} />} className={iconOnly ? 'cm-pill cm-iconly' : 'cm-pill'} title={iconOnly ? label : undefined}>
      {iconOnly ? <span className="cm-sr">{label}</span> : label}
    </Badge>
  );
}

const OUTCOME_ICON: Record<Outcome['id'], Icon> = { failed: CircleX, rejected: Ban, blocked: OctagonX, verified: ShieldCheck, accepted: CircleCheck, escalated: TriangleAlert, warning: CircleAlert, pending: CircleDashed, done: Check };
export function OutcomeMark({ e, iconOnly }: { e: CommunicationEventV1; iconOnly?: boolean }) {
  const o = outcomeOf(e);
  if (!o) return null;
  const I = OUTCOME_ICON[o.id];
  return (
    <Badge tone={KT[o.tone]} sm icon={<I size={12} aria-hidden strokeWidth={2.4} />} className={iconOnly ? 'cm-out cm-iconly' : 'cm-out'} variant={o.tone === 'mute' ? 'outline' : 'soft'} title={iconOnly ? o.label : undefined}>
      {iconOnly ? <span className="cm-sr">{o.label}</span> : o.label}
    </Badge>
  );
}

/** class colour + the exact instance id; the class is also in the tooltip so colour is never the only carrier */
export function PartyBadge({ p, role }: { p: Party; role: 'from' | 'to' }) {
  const c = p.class || 'system';
  const I = c === 'provider' ? Cpu : c === 'operator' ? Hand : c === 'system' ? Zap : p.kind === 'robot' ? Bot : Radio;
  return (
    <Badge tone={CLASS_KT[c] ?? 'isolated'} sm variant={role === 'from' ? 'soft' : 'outline'} icon={<I size={11} aria-hidden strokeWidth={2.2} />} className="cm-party" title={`${role === 'from' ? 'From' : 'To'} ${p.id} (${c})`}>
      {p.id}
    </Badge>
  );
}

const CHIP_ICON: Record<MsgChip['id'], Icon> = { tool: Wrench, model: Cpu, tokens: Cpu, evidence: Link2, robot: Bot, task: ClipboardList, asset: Info };
export function MsgChipEl({ c }: { c: MsgChip }) {
  const I = CHIP_ICON[c.id];
  return (
    <Badge tone={c.id === 'evidence' ? 'info' : 'neutral'} sm variant="outline" icon={<I size={11} aria-hidden strokeWidth={2} />} className="cm-mchip" title={c.title}>
      {c.text}
    </Badge>
  );
}

/** copy to clipboard with visible confirmation; works without the async clipboard API (older/insecure contexts) */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing else to try */
      }
      ta.remove();
    }
    setDone(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1400);
  };
  return <IconButton size="sm" className="cm-copy" aria-label={done ? `Copied ${label}` : `Copy ${label}`} tip={done ? 'Copied' : `Copy ${label}`} icon={done ? <Check size={13} /> : <Copy size={13} />} onClick={copy} />;
}
