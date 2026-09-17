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
      className={cn(
        'min-w-0 rounded-xl border border-line-soft bg-surface p-4 shadow-card sm:p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHead({ title, hint, right }: { title: string; hint?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
        {hint ? <p className="mt-1 text-[13px] leading-snug text-muted">{hint}</p> : null}
      </div>
      {right}
    </header>
  );
}

/** Page heading. One per screen, above the cards. */
export function PageHead({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight text-ink">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-ink-2">{sub}</p> : null}
      </div>
      {right}
    </header>
  );
}

// ---------------------------------------------------------------- button ---

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export function Button({ variant = 'default', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-lg border font-medium',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-150',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' && 'gap-1.5 px-3 py-1.5 text-[13px]',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'lg' && 'px-5 py-2.5 text-[15px]',
        variant === 'default' &&
          'border-line bg-surface text-ink shadow-xs hover:bg-raised',
        variant === 'primary' &&
          'border-transparent bg-accent text-white shadow-xs hover:bg-accent/90',
        variant === 'secondary' &&
          'border-transparent bg-secondary text-white shadow-xs hover:bg-secondary/90',
        variant === 'danger' &&
          'border-transparent bg-crit text-white shadow-xs hover:bg-crit/90',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-ink-2 hover:bg-raised hover:text-ink',
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

/** Soft tinted chips: the bright status colour as a wash, the dark step as text. */
const TONE_STYLE: Record<Tone, string> = {
  good:    'border-good/25 bg-good/10 text-good-ink',
  warn:    'border-warn/30 bg-warn/10 text-warn-ink',
  serious: 'border-warn/30 bg-warn/10 text-warn-ink',
  crit:    'border-crit/25 bg-crit/10 text-crit-ink',
  info:    'border-info/25 bg-info/10 text-info-ink',
  neutral: 'border-line bg-raised text-ink-2',
};

/** The same tones without a fill, for surfaces that supply their own. */
const TONE_BORDER: Record<Tone, string> = {
  good:    'border-good/30 text-good-ink',
  warn:    'border-warn/35 text-warn-ink',
  serious: 'border-warn/35 text-warn-ink',
  crit:    'border-crit/30 text-crit-ink',
  info:    'border-info/30 text-info-ink',
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
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium',
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
      <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-crit-ink">{error}</span> : null}
      {hint && !error ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink shadow-xs ' +
  'transition-colors placeholder:text-muted hover:border-muted/50';

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[92vh] w-full max-w-lg animate-fadeUp overflow-y-auto rounded-t-2xl border border-line-soft bg-surface p-5 shadow-lg sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
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
              <th key={h} className="border-b border-line bg-raised/60 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
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
  return <td {...rest} className={cn('border-b border-line-soft px-3 py-2.5 text-ink-2', className)}>{children}</td>;
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
    <div className="rounded-xl border border-dashed border-line bg-raised/40 p-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {body ? <p className="mt-1 text-sm text-muted">{body}</p> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-xl border border-crit/30 bg-crit/5 p-4 text-sm text-ink">
      <p className="font-medium text-crit-ink">Could not load this</p>
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
              'pointer-events-auto w-full max-w-sm animate-fadeUp rounded-xl border bg-surface p-3.5 shadow-lg',
              TONE_BORDER[t.tone],
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
