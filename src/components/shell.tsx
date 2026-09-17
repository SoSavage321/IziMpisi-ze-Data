/**
 * Application shell.
 *
 * A navy rail against the light working area: the chrome stays constant in
 * both themes so the product has one identity, and the content area carries
 * the theme. On a phone the rail becomes a drawer and the alarm count stays in
 * the top bar, because the one thing an operator must never hunt for is
 * whether something is wrong.
 */

import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Activity, BellRing, ClipboardList, Droplets, FileText, FlaskConical, Gauge,
  History, LayoutGrid, LogOut, Menu, Moon, Package, PlayCircle,
  Settings as SettingsIcon, Sun, X,
} from 'lucide-react';
import { useAuth } from '../hooks/auth.tsx';
import { useAlarms, useFleet, useLiveUpdates } from '../hooks/data.ts';
import { isDemo } from '../lib/supabase.ts';
import { Badge, cn, useToast } from './ui.tsx';

const NAV: Array<{
  section: string;
  items: Array<{ to: string; label: string; icon: typeof LayoutGrid; end?: boolean; adminOnly?: boolean }>;
}> = [
  {
    section: 'Operations',
    items: [
      { to: '/', label: 'Fleet', icon: LayoutGrid, end: true },
      { to: '/alarms', label: 'Alarms', icon: BellRing },
      { to: '/batches', label: 'Batches', icon: Droplets },
      { to: '/logbook', label: 'Shift log', icon: ClipboardList },
    ],
  },
  {
    section: 'Insight',
    items: [
      { to: '/analytics', label: 'Analytics', icon: Activity },
      { to: '/reports', label: 'Compliance', icon: FileText },
    ],
  },
  {
    section: 'Upkeep',
    items: [
      { to: '/maintenance', label: 'Maintenance', icon: FlaskConical },
      { to: '/inventory', label: 'Inventory', icon: Package },
    ],
  },
  {
    section: 'Learn',
    items: [
      { to: '/simulation', label: 'Simulation', icon: PlayCircle },
      { to: '/about', label: 'How it works', icon: Gauge },
    ],
  },
  {
    section: 'Admin',
    items: [
      { to: '/settings', label: 'Settings', icon: SettingsIcon, adminOnly: true },
      { to: '/audit', label: 'Audit log', icon: History, adminOnly: true },
    ],
  },
];

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(
    () => {
      try { return (localStorage.getItem('waterguard.theme') as 'light' | 'dark' | 'system') ?? 'system'; }
      catch { return 'system'; }
    },
  );
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('waterguard.theme', theme); } catch { /* private window */ }
  }, [theme]);
  return { theme, setTheme };
}

/** Raise a toast the first time we see a new critical alarm. */
function useAlarmToasts() {
  const { data: alarms } = useAlarms({ activeOnly: true });
  const { push } = useToast();
  const [seen, setSeen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!alarms) return;
    const fresh = alarms.filter((a) => !seen.has(a.id) && a.severity !== 'info');
    if (!fresh.length) return;
    // On first load, prime the set quietly rather than firing a dozen toasts.
    if (seen.size === 0) { setSeen(new Set(alarms.map((a) => a.id))); return; }
    for (const a of fresh) {
      push({
        tone: a.severity === 'critical' ? 'crit' : 'warn',
        title: a.message,
        body: `${a.site_name ?? ''} · ${a.device_name ?? ''}`.trim(),
        sound: a.severity === 'critical',
      });
    }
    setSeen(new Set(alarms.map((a) => a.id)));
  }, [alarms, push, seen]);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useLiveUpdates();
  useAlarmToasts();
  const { session, signOut, role } = useAuth();
  const { theme, setTheme } = useTheme();
  const { data: alarms } = useAlarms({ activeOnly: true });
  const { data: fleet } = useFleet();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => { setOpen(false); }, [location.pathname]);

  const critical = alarms?.filter((a) => a.severity === 'critical').length ?? 0;
  const active = alarms?.filter((a) => a.severity !== 'info').length ?? 0;
  const offline = fleet?.filter((f) => f.offline).length ?? 0;

  return (
    <div className="flex min-h-full">
      {/* ------------------------------------------------- desktop rail --- */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-nav lg:flex">
        <Rail
          role={role}
          fleet={fleet}
          onSignOut={signOut}
          userName={session?.profile.full_name}
        />
      </aside>

      {/* ------------------------------------------------- mobile drawer --- */}
      {open ? (
        <div className="fixed inset-0 z-50 bg-primary/60 lg:hidden" onClick={() => setOpen(false)}>
          <aside
            className="flex h-full w-72 max-w-[85vw] flex-col bg-nav shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <Rail
              role={role}
              fleet={fleet}
              onSignOut={signOut}
              userName={session?.profile.full_name}
              onClose={() => setOpen(false)}
            />
          </aside>
        </div>
      ) : null}

      {/* ------------------------------------------------------- content --- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-line-soft bg-bg/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:px-6">
            <button
              className="-ml-1 rounded-lg p-2 text-ink-2 hover:bg-raised lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            <Link to="/" className="flex items-center gap-2 lg:hidden">
              <Logo className="h-6 w-6" />
              <span className="text-[15px] font-semibold tracking-tight text-ink">WaterGuard</span>
            </Link>

            {isDemo ? (
              <span className="hidden rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-muted sm:inline">
                Demo data
              </span>
            ) : null}

            <div className="ml-auto flex items-center gap-1.5">
              {offline > 0 ? (
                <Link to="/" className="hidden sm:block">
                  <Badge tone="crit">{offline} offline</Badge>
                </Link>
              ) : null}

              <Link
                to="/alarms"
                className="relative rounded-lg p-2 text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                aria-label={`${active} active alarms`}
              >
                <BellRing className={cn('h-5 w-5', critical > 0 && 'animate-pulseDot text-crit')} />
                {active > 0 ? (
                  <span className={cn(
                    'absolute right-0.5 top-0.5 min-w-[17px] rounded-full px-1 text-center text-[10px] font-semibold leading-[17px] text-white',
                    critical > 0 ? 'bg-crit' : 'bg-warn',
                  )}>
                    {active}
                  </span>
                ) : null}
              </Link>

              <button
                className="rounded-lg p-2 text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label="Switch between light and dark"
              >
                {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>

              <div className="ml-1.5 hidden items-center gap-2.5 border-l border-line pl-3 sm:flex">
                <Avatar name={session?.profile.full_name ?? '?'} />
                <div className="leading-tight">
                  <p className="text-[13px] font-medium text-ink">{session?.profile.full_name}</p>
                  <p className="text-[11px] capitalize text-muted">{role}</p>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 pb-16 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function Rail({ role, fleet, onSignOut, userName, onClose }: {
  role: string | null;
  fleet: ReturnType<typeof useFleet>['data'];
  onSignOut: () => void;
  userName?: string;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex h-14 items-center gap-2.5 px-5">
        <Logo className="h-7 w-7" />
        <span className="text-[15px] font-semibold tracking-tight text-nav-ink">WaterGuard</span>
        {onClose ? (
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-nav-muted hover:bg-nav-2" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Sections">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.adminOnly || role === 'admin');
          if (!items.length) return null;
          return (
            <div key={group.section} className="mb-5">
              <p className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-nav-muted/70">
                {group.section}
              </p>
              <div className="space-y-0.5">
                {items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) => cn(
                      'relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors',
                      isActive
                        ? 'bg-accent/15 font-medium text-nav-ink'
                        : 'text-nav-muted hover:bg-nav-2 hover:text-nav-ink',
                    )}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? (
                          <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-accent" aria-hidden />
                        ) : null}
                        <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                        {label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}

        <div className="mb-2 border-t border-nav-line pt-4">
          <p className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-nav-muted/70">
            Devices
          </p>
          <div className="space-y-0.5">
            {fleet?.map((f) => (
              <NavLink
                key={f.device_id}
                to={`/device/${f.device_id}`}
                className={({ isActive }) => cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                  isActive ? 'bg-nav-2 font-medium text-nav-ink' : 'text-nav-muted hover:bg-nav-2 hover:text-nav-ink',
                )}
              >
                <span className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  f.offline || f.critical_alarms > 0 ? 'bg-crit'
                    : f.active_alarms > 0 ? 'bg-warn' : 'bg-good',
                )} />
                <span className="truncate">{f.device_name}</span>
              </NavLink>
            ))}
            {!fleet?.length ? <p className="px-3 text-[13px] text-nav-muted">No devices yet</p> : null}
          </div>
        </div>
      </nav>

      <div className="border-t border-nav-line p-3">
        <button
          onClick={onSignOut}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-nav-muted transition-colors hover:bg-nav-2 hover:text-nav-ink"
        >
          <LogOut className="h-[18px] w-[18px]" aria-hidden />
          <span className="truncate">Sign out{userName ? ` · ${userName}` : ''}</span>
        </button>
      </div>
    </>
  );
}

/** A drop over a band — the mark for a system that decides what may pass. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path
        d="M16 6.5c3.6 4.2 5.6 7.2 5.6 9.8a5.6 5.6 0 1 1-11.2 0c0-2.6 2-5.6 5.6-9.8Z"
        className="fill-white/95"
      />
      <rect x="7" y="22" width="18" height="2.4" rx="1.2" className="fill-white/55" />
    </svg>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary/12 text-[11.5px] font-semibold text-secondary">
      {initials}
    </span>
  );
}
