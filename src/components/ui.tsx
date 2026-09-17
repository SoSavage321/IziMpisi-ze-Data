/**
 * UI primitives.
 *
 * Two rules run through all of these:
 *  - Status is never colour alone. Every severity or state carries an icon and
 *    a word as well, because this is read on a phone in sunlight by people who
 *    may be colour blind.
 *  - Touch targets stay large. An operator wearing gloves should not have to
 *    aim.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  AlertTriangle, CheckCircle2, CircleAlert, Info, Loader2, OctagonX, X,
} from 'lucide-react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ------------------------------------------------------------------ card ---

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      {...rest}
      className={cn('rounded-xl border border-line bg-surface p-4 sm:p-5 min-w-0', className)}
    >
      {children}
    </section>
  );
}

export function CardHead({ title, hint, right }: { title: string; hint?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="mb-4 flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-[12px] font-semibold uppercase tracking-[0.13em] text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {right}
    </header>
  );
}

// ---------------------------------------------------------------- button ---

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export function Button({ variant = 'default', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'px-3 py-1.5 text-xs',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'lg' && 'px-5 py-3 text-base',
        variant === 'default' && 'border-line bg-raised text-ink hover:border-accent',
        variant === 'primary' && 'border-accent bg-accent text-white hover:opacity-90',
        variant === 'danger' && 'border-crit bg-crit text-white hover:opacity-90',
        variant === 'ghost' && 'border-transparent bg-transparent text-ink-2 hover:bg-raised',
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ----------------------------------------------------------------- state ---

export type Tone = 'good' | 'warn' | 'serious' | 'crit' | 'info' | 'neutral';

const TONE_STYLE: Record<Tone, string> = {
  good: 'border-good/50 text-good',
  warn: 'border-warn/60 text-warn',
  serious: 'border-serious/60 text-serious',
  crit: 'border-crit/60 text-crit',
  info: 'border-info/50 text-info',
  neutral: 'border-line text-ink-2',
};

const TONE_ICON: Record<Tone, React.ComponentType<{ className?: string }>> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  serious: AlertTriangle,
  crit: OctagonX,
  info: Info,
  neutral: CircleAlert,
};

export function Badge({ tone = 'neutral', children, icon = true, className }: {
  tone?: Tone; children: React.ReactNode; icon?: boolean; className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 text-xs font-medium',
      TONE_STYLE[tone], className,
    )}>
      {icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function severityTone(severity: string): Tone {
  if (severity === 'critical') return 'crit';
  if (severity === 'warning') return 'warn';
  if (severity === 'info') return 'info';
  return 'neutral';
}

/** Plant state -> a tone plus a plain-language label. */
export function stateTone(state: string | null | undefined, offline?: boolean): { tone: Tone; label: string } {
  if (offline) return { tone: 'crit', label: 'Offline' };
  switch (state) {
    case 'DISCHARGE': return { tone: 'good', label: 'Discharging to river' };
    case 'RELEASE': return { tone: 'good', label: 'Releasing treated water' };
    case 'FILL': return { tone: 'neutral', label: 'Filling' };
    case 'TEST': return { tone: 'info', label: 'Testing batch' };
    case 'DIVERT': return { tone: 'warn', label: 'Diverting to tank' };
    case 'TREAT': return { tone: 'info', label: 'Treating' };
    case 'CONFIRM': return { tone: 'info', label: 'Confirming' };
    case 'HOLD': return { tone: 'warn', label: 'Batch held' };
    case 'LOCKOUT': return { tone: 'crit', label: 'Locked out' };
    case 'ESTOP': return { tone: 'crit', label: 'Emergency stop' };
    case 'MAINTENANCE': return { tone: 'neutral', label: 'Maintenance' };
    default: return { tone: 'neutral', label: state ?? 'Unknown' };
  }
}

// ----------------------------------------------------------------- forms ---

export function Field({ label, hint, htmlFor, children, error }: {
  label: string; hint?: string; htmlFor?: string; children: React.ReactNode; error?: string | null;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-crit">{error}</span> : null}
      {hint && !error ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  'w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} {...rest} className={cn(controlClass, className)} />;
  },
);

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cn(controlClass, className)}>{children}</select>;
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(controlClass, 'min-h-[88px] resize-y', className)} />;
}

// ---------------------------------------------------------------- dialog ---

export function Dialog({ open, onClose, title, description, children, footer }: {
  open: boolean; onClose: () => void; title: string;
  description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-line bg-surface p-5 sm:rounded-xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-raised">
            <X className="h-5 w-5" />
          </button>
        </div>
        {description ? <div className="mb-4 text-sm text-ink-2">{description}</div> : null}
        {children}
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- table ---

export function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-line px-3 py-2 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty ? <p className="px-3 py-8 text-center text-sm text-muted">Nothing here yet.</p> : null}
    </div>
  );
}

export function Td({ className, children, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={cn('border-b border-line px-3 py-2 text-ink-2', className)}>{children}</td>;
}

// -------------------------------------------------------------- feedback ---

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-8 text-center">
      <p className="font-medium text-ink">{title}</p>
      {body ? <p className="mt-1 text-sm text-muted">{body}</p> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-xl border border-crit/50 bg-crit/5 p-4 text-sm text-ink">
      <p className="font-medium text-crit">Could not load this</p>
      <p className="mt-1 text-ink-2">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------- toasts ---

export interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  /** Critical alarms also make a sound; everything else is silent. */
  sound?: boolean;
}

const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    if (t.sound) beep();
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.tone === 'crit' ? 12000 : 6000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="assertive">
        {toasts.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div key={t.id} className={cn(
              'pointer-events-auto w-full max-w-sm rounded-xl border bg-surface p-3 shadow-lg',
              TONE_STYLE[t.tone],
            )}>
              <div className="flex gap-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{t.title}</p>
                  {t.body ? <p className="mt-0.5 break-words text-xs text-ink-2">{t.body}</p> : null}
                </div>
                <button
                  className="ml-auto shrink-0 text-muted hover:text-ink"
                  onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  aria-label="Dismiss"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/** A short two-tone alert for critical alarms. Silent if the browser blocks it. */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.08, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur);
    };
    play(880, 0, 0.18);
    play(660, 0.22, 0.24);
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* sound is a courtesy, never a requirement */
  }
}
