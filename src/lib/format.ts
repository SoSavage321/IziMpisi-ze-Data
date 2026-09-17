import { formatInTimeZone } from 'date-fns-tz';

export const DEFAULT_TZ = 'Africa/Johannesburg';

/** Timestamps are always shown in the site's own timezone, with the zone named. */
export function siteTime(ts: string | Date | null | undefined, tz = DEFAULT_TZ, pattern = 'HH:mm:ss'): string {
  if (!ts) return '—';
  try {
    return formatInTimeZone(new Date(ts), tz, pattern);
  } catch {
    return '—';
  }
}

export function siteDateTime(ts: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  return siteTime(ts, tz, 'dd MMM yyyy HH:mm');
}

export function siteDate(ts: string | Date | null | undefined, tz = DEFAULT_TZ): string {
  return siteTime(ts, tz, 'dd MMM yyyy');
}

export function zoneLabel(tz = DEFAULT_TZ): string {
  return tz.split('/').pop()?.replace('_', ' ') ?? tz;
}

/** Relative age, for "last seen" style fields. */
export function ago(ts: string | Date | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const nf = new Intl.NumberFormat('en-ZA');

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return nf.format(Number(n.toFixed(digits)));
}

/** Units are never implied. A bare number on a control screen is a hazard. */
export function litres(n: number | null | undefined, estimated = true): string {
  if (n === null || n === undefined) return '—';
  return `${num(n)} L${estimated ? '*' : ''}`;
}

export function ph(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(2);
}

export function tds(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${num(n)} mg/L`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? '—' : `${n.toFixed(digits)}%`;
}

export function duration(seconds: number | null | undefined): string {
  if (!seconds && seconds !== 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
