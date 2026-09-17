import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, ChevronUp } from 'lucide-react';
import { useAlarms, useFleet } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { ago, siteDateTime } from '../lib/format.ts';
import {
  Badge, Button, Card, Dialog, Empty, Field, Select, Spinner,
  Textarea, cn, severityTone, useToast,
} from '../components/ui.tsx';
import type { Alarm } from '../lib/types.ts';

export default function Alarms() {
  const [severity, setSeverity] = useState('');
  const [site, setSite] = useState('');
  const [showCleared, setShowCleared] = useState(false);
  const { data: fleet } = useFleet();
  const { data, isLoading } = useAlarms({ severity: severity || undefined });
  const { session, can } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const [acking, setAcking] = useState<Alarm | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    let out = data ?? [];
    if (!showCleared) out = out.filter((a) => !a.cleared_at);
    if (site) {
      const ids = new Set((fleet ?? []).filter((f) => f.site_id === site).map((f) => f.device_id));
      out = out.filter((a) => ids.has(a.device_id));
    }
    return out;
  }, [data, showCleared, site, fleet]);

  const active = rows.filter((a) => !a.cleared_at && a.severity !== 'info');
  const unacked = active.filter((a) => !a.acknowledged_at);

  async function acknowledge() {
    if (!acking || !session) return;
    setBusy(true);
    try {
      await api.ackAlarm(acking.id, note, session.user_id);
      push({ tone: 'good', title: 'Alarm acknowledged', body: 'It stays open until the cause clears.' });
      qc.invalidateQueries({ queryKey: ['live', 'alarms'] });
      setAcking(null);
      setNote('');
    } catch (e) {
      push({ tone: 'crit', title: 'Could not acknowledge', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Spinner label="Loading alarms" />;

  const sites = [...new Map((fleet ?? []).map((f) => [f.site_id, f.site_name])).entries()];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Alarms</h1>
          <p className="text-sm text-muted">
            {active.length} active · {unacked.length} not yet acknowledged
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="min-w-[8rem]">
              <option value="">All</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </Select>
          </Field>
          <Field label="Site">
            <Select value={site} onChange={(e) => setSite(e.target.value)} className="min-w-[10rem]">
              <option value="">All sites</option>
              {sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </Field>
          <Button onClick={() => setShowCleared((v) => !v)} aria-pressed={showCleared}>
            {showCleared ? 'Hide cleared' : 'Show history'}
          </Button>
        </div>
      </header>

      {unacked.some((a) => a.severity === 'critical') ? (
        <div className="flex items-start gap-3 rounded-xl border border-crit bg-crit/10 p-4">
          <BellRing className="mt-0.5 h-5 w-5 shrink-0 animate-pulseDot text-crit-ink" aria-hidden />
          <div>
            <p className="font-medium text-crit-ink">
              {unacked.filter((a) => a.severity === 'critical').length} critical alarm(s) need acknowledgement
            </p>
            <p className="mt-0.5 text-sm text-ink-2">
              An unacknowledged critical alarm escalates to site administrators after ten minutes.
            </p>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty title="Nothing to answer for" body="No alarms match this filter." />
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <AlarmRow key={a.id} a={a} canAck={can('operate')} onAck={() => { setAcking(a); setNote(''); }} />
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(acking)}
        onClose={() => setAcking(null)}
        title="Acknowledge this alarm"
        description={
          <div className="space-y-2">
            <p className="font-medium text-ink">{acking?.message}</p>
            <p>
              Acknowledging records that you have seen it and taken ownership. It does not clear the alarm —
              that happens on its own when the condition goes away.
            </p>
          </div>
        }
        footer={
          <>
            <Button onClick={() => setAcking(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={acknowledge}>
              <Check className="h-4 w-4" /> Acknowledge
            </Button>
          </>
        }
      >
        <Field label="What did you do about it?" hint="Optional, but it is what the next shift will read">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Refilled the neutraliser drum, 20 L from the store" />
        </Field>
      </Dialog>
    </div>
  );
}

function AlarmRow({ a, canAck, onAck }: { a: Alarm; canAck: boolean; onAck: () => void }) {
  const tone = severityTone(a.severity);
  const cleared = Boolean(a.cleared_at);

  return (
    <Card className={cn(
      'border-l-4',
      cleared && 'opacity-60',
      a.severity === 'critical' ? 'border-l-crit' : a.severity === 'warning' ? 'border-l-warn' : 'border-l-info',
    )}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{a.severity}</Badge>
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{a.type}</span>
            {a.escalated ? <Badge tone="crit"><ChevronUp className="h-3.5 w-3.5" />escalated</Badge> : null}
            {cleared ? <Badge tone="good">cleared</Badge> : null}
          </div>
          <p className="text-sm font-medium text-ink">{a.message}</p>
          <p className="mt-1 text-xs text-muted">
            <Link to={`/device/${a.device_id}`} className="hover:text-accent">{a.device_name}</Link>
            {' · '}{a.site_name} · raised {ago(a.raised_at)} ({siteDateTime(a.raised_at)})
          </p>
          {a.acknowledged_at ? (
            <p className="mt-1.5 rounded-lg bg-raised p-2 text-xs text-ink-2">
              Acknowledged {ago(a.acknowledged_at)}
              {a.ack_note ? <> — &ldquo;{a.ack_note}&rdquo;</> : null}
            </p>
          ) : null}
        </div>
        {!a.acknowledged_at && !cleared && a.severity !== 'info' ? (
          <Button size="sm" variant="primary" disabled={!canAck} onClick={onAck}>Acknowledge</Button>
        ) : null}
      </div>
    </Card>
  );
}
