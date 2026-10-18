import { MessageSquare } from 'lucide-react';
import { useCommunications } from './communicationStore';
import { useCommunicationsIngest } from './useRunCommunications';
import { togglePanel } from '../responsive/panels';

let lastOpener: HTMLElement | null = null;
/** ESC / close returns focus to whatever opened the panel */
export function restoreFocus() {
  // the panel may have opened by default (desktop), so there may be no recorded opener: fall back to the visible launcher
  const el = lastOpener?.isConnected && lastOpener.offsetParent !== null ? lastOpener : [...document.querySelectorAll<HTMLElement>('button.cm-launcher')].find((b) => b.offsetParent !== null);
  el?.focus();
}

const STATE_TEXT: Record<string, string> = { LIVE: 'Live', RECONNECTING: 'Reconnecting', CONNECTING: 'Connecting', OFFLINE: 'Offline', ERROR: 'Error', STALE: 'Stale', REPLAY: 'Replay' };

/**
 * Persistent entry point, rendered by the top bar (regular chrome) and the tab bar (compact chrome) on every tab and orientation.
 * It also owns ingestion, so messages keep arriving, and the unread count keeps counting, while the panel is closed.
 * The dot and the word carry the connection state (LIVE / RECONNECTING / OFFLINE ...), not only the colour.
 */
export function CommunicationsLauncher({ variant = 'chip' }: { variant?: 'chip' | 'button' | 'tab' }) {
  useCommunicationsIngest();
  const open = useCommunications((s) => s.open);
  const unread = useCommunications((s) => s.unread);
  const conn = useCommunications((s) => s.conn);
  const state = STATE_TEXT[conn] ?? conn;
  return (
    <button
      type="button"
      className={variant === 'chip' ? 'cm-launcher cm-launcher--chip' : variant === 'tab' ? 'seg__item cm-launcher cm-launcher--tab' : 'cm-launcher'}
      data-testid={variant === 'tab' ? 'comms-tab' : undefined}
      aria-pressed={open}
      aria-controls="lk-comms-panel"
      aria-label={`Communications, ${state}${unread ? `, ${unread} unread` : ''}, ${open ? 'open' : 'closed'}`}
      title={`Agent communications: ${state} (what the agents and robots actually reported)`}
      data-conn={conn}
      onClick={(e) => {
        lastOpener = e.currentTarget;
        togglePanel('comms', true, e.currentTarget);
      }}
    >
      <MessageSquare size={14} aria-hidden />
      <span className="cm-launcher__label">Comms</span>
      <i className="cm-launcher__dot" aria-hidden />
      {/* the word is always in the accessibility tree; it is only drawn on wide bars */}
      <span className="cm-launcher__state">{state}</span>
      {unread > 0 && <span className="cm-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
