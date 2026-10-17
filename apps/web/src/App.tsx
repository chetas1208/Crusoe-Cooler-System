import { Suspense, lazy, useEffect, useState } from 'react';
import { startWorld, useWorld } from '@loopkeeper/core/store';
import { createTransport } from './lib/transport';
import { ViewerHost } from './features/visualization/ViewerHost';
import { Shell } from './ui/Shell';
import { AuthGate } from './ui/AuthGate';
import { PhoneChrome } from './features/responsive/PhoneChrome';
import { benchEnabled } from './bench/flag';
import { useInterest } from './lib/useInterest';
import { WifiOff, Cpu } from 'lucide-react';

const BenchPanel = lazy(() => import('./bench').then((m) => ({ default: m.BenchPanel })));

export function App() {
  useInterest();
  const phase = useWorld((s) => s.phase);
  const error = useWorld((s) => s.error);
  const [customUrl, setCustomUrl] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    createTransport().then(async (t) => {
      if (cancelled) return;
      stop = await startWorld(t);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [retryKey]);

  const fallbackToEmbedded = () => {
    createTransport(true).then(async (t) => {
      await startWorld(t);
    });
  };

  const connectCustomUrl = (urlToUse?: string) => {
    const target = (urlToUse || customUrl).trim();
    if (!target) return;
    try {
      const u = new URL(target);
      localStorage.setItem('lk.api', u.origin);
      setRetryKey((k) => k + 1);
    } catch {
      alert('Invalid URL format. Please include https:// or http://');
    }
  };

  return (
    <div className="app">
      <div className="stage">
        {phase === 'ready' && <ViewerHost />}
        {phase === 'error' && (
          <div className="stage-error-overlay panel" style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: 480,
            padding: 24,
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid #ef4444',
            borderRadius: 12,
            color: '#f8fafc',
            textAlign: 'center',
            zIndex: 1000,
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)'
          }}>
            <WifiOff size={36} color="#ef4444" style={{ margin: '0 auto 12px' }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>Backend Connection Required</h3>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 16px', lineHeight: 1.5 }}>
              The 3D physical data center is waiting for a live backend connection ({error || 'Connection offline'}).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder="https://your-tunnel.trycloudflare.com"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  style={{
                    flex: 1,
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    padding: '8px 12px',
                    color: '#fff',
                    fontSize: 12
                  }}
                />
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => connectCustomUrl()}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Connect
                </button>
              </div>
              <div style={{ margin: '8px 0 4px', borderTop: '1px solid #334155' }} />
              <button
                className="btn btn--sm"
                onClick={fallbackToEmbedded}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: '#0284c7',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 500
                }}
              >
                <Cpu size={14} /> Launch Standalone Physics Simulator (No Server Needed)
              </button>
            </div>
          </div>
        )}
      </div>
      <Shell />
      <PhoneChrome />
      <AuthGate />
      {benchEnabled && (
        <Suspense fallback={null}>
          <BenchPanel />
        </Suspense>
      )}
    </div>
  );
}
