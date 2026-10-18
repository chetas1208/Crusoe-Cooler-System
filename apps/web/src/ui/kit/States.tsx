import type { CSSProperties, ReactNode } from 'react';
import { Inbox, OctagonAlert } from 'lucide-react';
import { Button } from './Button';
import { cx } from './tone';

export function EmptyState({ icon, title, children, action, compact }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('lk-state', compact && 'lk-state--compact')} data-kind="empty">
      <span className="lk-state__icon" aria-hidden="true">{icon ?? <Inbox size={20} />}</span>
      <div className="lk-state__title">{title}</div>
      {children && <div className="lk-state__body">{children}</div>}
      {action && <div className="lk-state__actions">{action}</div>}
    </div>
  );
}

/** Says what failed and how to recover; never apologises. role=alert. */
export function ErrorState({ title, children, onRetry, retryLabel = 'Try again', detail, compact }: { title: string; children?: ReactNode; onRetry?: () => void; retryLabel?: string; /** raw error text, shown mono */ detail?: string; compact?: boolean }) {
  return (
    <div className={cx('lk-state', compact && 'lk-state--compact')} data-kind="error" role="alert">
      <span className="lk-state__icon" aria-hidden="true"><OctagonAlert size={20} /></span>
      <div className="lk-state__title">{title}</div>
      {children && <div className="lk-state__body">{children}</div>}
      {detail && <code className="lk-state__detail">{detail}</code>}
      {onRetry && <div className="lk-state__actions"><Button size="sm" onClick={onRetry}>{retryLabel}</Button></div>}
    </div>
  );
}

export function Skeleton({ w, h = 12, r, style }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties }) {
  return <span className="lk-skel" aria-hidden="true" style={{ width: w ?? '100%', height: h, borderRadius: r, ...style }} />;
}

/** busy region placeholder: announces once, shimmer is static under reduced motion. */
export function LoadingSkeleton({ lines = 3, label = 'Loading', avatar }: { lines?: number; label?: string; avatar?: boolean }) {
  return (
    <div className="lk-loading" role="status" aria-busy="true" aria-label={label}>
      {avatar && <Skeleton w={36} h={36} r="50%" />}
      <div className="lk-loading__lines">
        {Array.from({ length: lines }, (_, i) => <Skeleton key={i} w={i === lines - 1 ? '62%' : '100%'} />)}
      </div>
    </div>
  );
}
