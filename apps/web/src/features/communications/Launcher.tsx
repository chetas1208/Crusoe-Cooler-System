import { MessageSquare } from 'lucide-react';
import { useCommunications } from './communicationStore';
import { useCommunicationsIngest } from './useRunCommunications';

let lastOpener: HTMLElement | null = null;
/** ESC / close returns focus to whatever opened the panel */
export function restoreFocus() {
  // the panel may have opened by default (desktop), so there may be no recorded opener: fall back to the visible launcher
  const el = lastOpener?.isConnected ? lastOpener : document.querySelector<HTMLElement>('button.cm-launcher');
  el?.focus();
}

/**
 * Persistent entry point: always rendered (header chip + Execution). It also owns ingestion, so messages keep arriving, and the
 * unread count keeps counting, while the panel is closed.
 */
export function CommunicationsLauncher({ variant = 'chip' }: { variant?: 'chip' | 'button' }) {
  useCommunicationsIngest();
  const open = useCommunications((s) => s.open);
  const unread = useCommunications((s) => s.unread);
  const conn = useCommunications((s) => s.conn);
  const setOpen = useCommunications((s) => s.setOpen);
  return (
    <button
      type="button"
      className={variant === 'chip' ? 'cm-launcher cm-launcher--chip' : 'cm-launcher'}
      aria-pressed={open}
      aria-controls="lk-comms-panel"
      aria-label={`Communications${unread ? `, ${unread} unread` : ''}, ${open ? 'open' : 'closed'}`}
      title="Agent communications (what the agents and robots actually reported)"
      data-conn={conn}
      onClick={(e) => {
        lastOpener = e.currentTarget;
        setOpen(!open, !open);
      }}
    >
      <MessageSquare size={14} aria-hidden />
      <span>Comms</span>
      {unread > 0 && <span className="cm-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
