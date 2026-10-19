import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return <div role="alert" className="banner banner-error">{msg}</div>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn' }) {
  return <div role="status" className={`banner banner-${tone}`}>{children}</div>;
}

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Loading({ what }: { what: string }) {
  return <p role="status" className="muted">Loading {what}…</p>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="page-header"><h1>{title}</h1><div className="page-actions">{children}</div></div>;
}
