import { useState, useSyncExternalStore } from 'react';
import { isAuthRequired, setAuthToken, subscribeAuth } from '@loopkeeper/core/client';
import { LogoMark } from './kit';
import { Button, Dialog, Field, Input } from './kit/index';

/** Asks for the API access token when the backend answers 401. The token stays in this browser only. */
export function AuthGate() {
  const required = useSyncExternalStore(subscribeAuth, isAuthRequired, () => false);
  const [value, setValue] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setAuthToken(value);
    location.reload();
  };
  return (
    <Dialog
      open={required}
      onClose={() => undefined}
      dismissible={false}
      size="sm"
      panelId="auth-gate"
      title="Access token required"
      description="This backend only answers authenticated requests. Paste the access token once; it is kept in this browser and sent with every request."
      footer={
        <Button type="submit" form="auth-gate-form" variant="primary" disabled={!value.trim()} icon={<LogoMark size={16} />}>
          Connect
        </Button>
      }
    >
      <form id="auth-gate-form" onSubmit={submit}>
        <Field label="Access token">
          <Input type="password" data-autofocus autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste token" />
        </Field>
      </form>
    </Dialog>
  );
}
