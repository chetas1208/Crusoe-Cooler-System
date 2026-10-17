import { useState, useSyncExternalStore } from 'react';
import { isAuthRequired, setAuthToken, subscribeAuth } from '@loopkeeper/core/client';
import { LogoMark } from './kit';

/** Asks for the API access token when the backend answers 401. The token stays in this browser only. */
export function AuthGate() {
  const required = useSyncExternalStore(subscribeAuth, isAuthRequired, () => false);
  const [value, setValue] = useState('');
  if (!required) return null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setAuthToken(value);
    location.reload();
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="auth-title" style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', background: 'rgba(6,10,17,.82)' }}>
      <form className="panel" onSubmit={submit} style={{ width: 'min(420px, calc(100vw - 32px))', padding: 20, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LogoMark />
          <b id="auth-title" style={{ fontSize: 15 }}>Access token required</b>
        </div>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.45 }}>
          This backend only answers authenticated requests. Paste the access token once; it is kept in this browser and sent with every request.
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access token"
          aria-label="Access token"
          style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line, #2a3446)', background: 'var(--bg-1, #0d1522)', color: 'inherit', font: 'inherit' }}
        />
        <button className="btn" type="submit" disabled={!value.trim()}>
          Connect
        </button>
      </form>
    </div>
  );
}
