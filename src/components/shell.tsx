/**
 * Application shell: navigation, identity, theme, and the alarm bell.
 *
 * On a phone the navigation collapses into a sheet and the alarm count stays
 * visible in the header, because the one thing an operator must never have to
 * hunt for is whether something is wrong.
 */

import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Activity, BellRing, ClipboardList, Droplets, FileText, FlaskConical, Gauge,
  History, LayoutGrid, LogOut, Menu, Moon, Package, Settings as SettingsIcon,
  Sun, X,
} from 'lucide-react';
import { useAuth } from '../hooks/auth.tsx';
import { useAlarms, useFleet, useLiveUpdates } from '../hooks/data.ts';
import { isDemo } from '../lib/supabase.ts';
import { Badge, Button, cn, useToast } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Fleet', icon: LayoutGrid, end: true },
  { to: '/alarms', label: 'Alarms', icon: BellRing },
  { to: '/batches', label: 'Batches', icon: Droplets },
  { to: '/analytics', label: 'Analytics', icon: Activity },
  { to: '/reports', label: 'Compliance', icon: FileText },
  { to: '/maintenance', label: 'Maintenance', icon: FlaskConical },
  { to: '/inventory', label: 'Inventory', icon: Package },
  { to: '/logbook', label: 'Shift log', icon: ClipboardList },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, adminOnly: true },
  { to: '/audit', label: 'Audit', icon: History, adminOnly: true },
  { to: '/about', label: 'How it works', icon: Gauge },
];

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(
    () => (localStorage.getItem('waterguard.theme') as 'light' | 'dark' | 'system') ?? 'system',
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

  const items = NAV.filter((n) => !n.adminOnly || role === 'admin');

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2.5">
          <button
            className="rounded-lg p-2 text-ink-2 hover:bg-raised lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          <Link to="/" className="flex items-baseline gap-2 font-display text-[15px] font-bold uppercase tracking-[0.14em] text-ink">
            Water<span className="text-accent">·</span>Guard
          </Link>

          {isDemo ? (
            <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted sm:inline">
              demo data
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {offline > 0 ? <Badge tone="crit">{offline} offline</Badge> : null}
            <Link to="/alarms" className="relative rounded-lg p-2 text-ink-2 hover:bg-raised" aria-label={`${active} active alarms`}>
              <BellRing className={cn('h-5 w-5', critical > 0 && 'animate-pulseDot text-crit')} />
              {active > 0 ? (
                <span className={cn(
                  'absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full px-1 text-center font-mono text-[10px] font-medium text-white',
                  critical > 0 ? 'bg-crit' : 'bg-warn',
                )}>
                  {active}
                </span>
              ) : null}
            </Link>

            <button
              className="rounded-lg p-2 text-ink-2 hover:bg-raised"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Switch between light and dark"
            >
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>

            <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
              <div className="text-right leading-tight">
                <p className="text-xs font-medium text-ink">{session?.profile.full_name}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">{role}</p>
              </div>
              <button onClick={signOut} className="rounded-lg p-2 text-muted hover:bg-raised hover:text-ink" aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 gap-6 px-4 py-4">
        {/* desktop rail */}
        <nav className="hidden w-52 shrink-0 lg:block" aria-label="Sections">
          <NavList items={items} />
          <div className="mt-4 border-t border-line pt-4">
            <p className="px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Devices</p>
            <div className="mt-1 space-y-0.5">
              {fleet?.map((f) => (
                <NavLink key={f.device_id} to={`/device/${f.device_id}`}
                  className={({ isActive }) => cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                    isActive ? 'bg-raised font-medium text-ink' : 'text-ink-2 hover:bg-raised',
                  )}>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full',
                    f.offline ? 'bg-crit' : f.critical_alarms > 0 ? 'bg-crit' : f.active_alarms > 0 ? 'bg-warn' : 'bg-good')} />
                  <span className="truncate">{f.device_name}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </nav>

        {/* mobile sheet */}
        {open ? (
          <div className="fixed inset-0 z-50 bg-black/50 lg:hidden" onClick={() => setOpen(false)}>
            <nav className="h-full w-72 max-w-[85vw] overflow-y-auto bg-surface p-4" onClick={(e) => e.stopPropagation()} aria-label="Sections">
              <NavList items={items} />
              <div className="mt-4 border-t border-line pt-4">
                {fleet?.map((f) => (
                  <NavLink key={f.device_id} to={`/device/${f.device_id}`}
                    className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-ink-2 hover:bg-raised">
                    <span className={cn('h-2 w-2 rounded-full', f.offline ? 'bg-crit' : 'bg-good')} />
                    {f.device_name}
                  </NavLink>
                ))}
              </div>
              <Button variant="ghost" className="mt-4 w-full justify-start" onClick={signOut}>
                <LogOut className="h-4 w-4" /> Sign out · {session?.profile.full_name}
              </Button>
            </nav>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 pb-10">{children}</main>
      </div>
    </div>
  );
}

function NavList({ items }: { items: typeof NAV }) {
  return (
    <div className="space-y-0.5">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => cn(
            'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition',
            isActive ? 'bg-raised font-medium text-ink' : 'text-ink-2 hover:bg-raised',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          {label}
        </NavLink>
      ))}
    </div>
  );
}
