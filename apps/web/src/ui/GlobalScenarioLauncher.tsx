import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { useUi } from './store';
import { ScenarioComposer } from '../tabs/execution/ScenarioComposer';

export function GlobalScenarioLauncher() {
  const open = useUi((s) => s.launcher);
  const setLauncher = useUi((s) => s.setLauncher);
  const setTab = useUi((s) => s.setTab);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setLauncher(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, setLauncher]);

  if (!open) return null;

  return (
    <div
      className="global-scenario-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setLauncher(false);
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 720,
        }}
      >
        <button
          className="icon-btn"
          onClick={() => setLauncher(false)}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            zIndex: 10,
            width: 28,
            height: 28,
            background: 'rgba(255, 255, 255, 0.1)',
            borderRadius: 6,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
          }}
          title="Close (Esc)"
        >
          <X size={16} />
        </button>

        <ScenarioComposer
          onCompleted={(runId) => {
            setTab('execution');
            setLauncher(false);
          }}
        />
      </div>
    </div>
  );
}
