import { LayoutDashboard, Map as MapIcon, Bot, PlayCircle, ClipboardCheck } from 'lucide-react';
import { TABS, type TabId } from '../../tabs/types';
import { useUi } from '../../ui/store';
import { CommunicationsLauncher } from '../communications/Launcher';
import { closePanel, openPanel, usePanelOpen } from './panels';
import { IconButton } from '../../ui/kit/index';

const ICON: Record<TabId, typeof LayoutDashboard> = { dashboard: LayoutDashboard, map: MapIcon, agents: Bot, execution: PlayCircle };

/** Bottom tab bar for phones: the same four tabs as the desktop segmented control, 56 px targets, safe-area aware. */
export function MobileTabBar() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const open = usePanelOpen();
  const detail = open.dod || open.team || open.scorecard;
  return (
    <nav className="mtabs" aria-label="Main">
      <div className="mtabs__row" role="tablist">
        {TABS.map((t) => {
          const Icon = ICON[t.id];
          return (
            <button key={t.id} className="mtabs__item" role="tab" aria-selected={tab === t.id} data-testid={`mtab-${t.id}`} onClick={() => setTab(t.id)}>
              <Icon size={20} aria-hidden />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mtabs__comms">
        <CommunicationsLauncher variant="chip" />
        <IconButton
          className="mtabs__panels"
          data-testid="mtab-panels"
          pressed={detail}
          aria-label="Done, Team and Scorecard panels"
          tip="Definition of Done, Team, Scorecard"
          onClick={(e) => (detail ? closePanel(open.dod ? 'dod' : open.team ? 'team' : 'scorecard') : openPanel('dod', true, e.currentTarget))}
          icon={<ClipboardCheck size={18} />}
        />
      </div>
    </nav>
  );
}
