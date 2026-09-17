/**
 * Admin settings.
 *
 * The threshold form is the sharpest tool in the whole dashboard: loosening a
 * discharge limit is an environmental decision, not a configuration change. So
 * it validates against the same rules the firmware enforces, it says out loud
 * what a looser limit means for the river, it demands a reason, it creates a
 * new version rather than editing the old one, and the device has to confirm
 * that it applied it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react';
import { validateConfig } from '@shared/controller.ts';
import { useConfigs, useFleet, useProfiles, useSites } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { isDemo } from '../lib/supabase.ts';
import { ago, siteDateTime } from '../lib/format.ts';
import {
  Badge, Button, Card, CardHead, Dialog, Field, Input, Select, Spinner,
  Table, Td, Textarea, useToast,
} from '../components/ui.tsx';

type Form = {
  ph_min: string; ph_max: string; tds_max: string; treat_target_ph: string;
  test_window_s: string; stable_window_s: string; batch_l: string;
  tank_cap_l: string; ph_warn_max: string; neutraliser_low_pct: string;
};

export default function Settings() {
  const { data: fleet } = useFleet();
  const { data: sites } = useSites();
  const { data: profiles } = useProfiles();
  const [deviceId, setDeviceId] = useState('');
  const active = deviceId || fleet?.[0]?.device_id;
  const { data: configs, isLoading } = useConfigs(active);
  const { session } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const current = configs?.[0];
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current) return;
    setForm({
      ph_min: String(current.ph_min), ph_max: String(current.ph_max),
      tds_max: String(current.tds_max), treat_target_ph: String(current.treat_target_ph),
      test_window_s: String(current.test_window_s), stable_window_s: String(current.stable_window_s),
      batch_l: String(current.batch_l), tank_cap_l: String(current.tank_cap_l),
      ph_warn_max: String(current.ph_warn_max), neutraliser_low_pct: String(current.neutraliser_low_pct),
    });
  }, [current?.id]);

  const validation = useMemo(() => {
    if (!form) return null;
    return validateConfig({
      version: (current?.version ?? 0) + 1,
      phMin: Number(form.ph_min), phMax: Number(form.ph_max), tdsMax: Number(form.tds_max),
      treatTargetPh: Number(form.treat_target_ph),
      testWindowS: Number(form.test_window_s), stableWindowS: Number(form.stable_window_s),
      batchL: Number(form.batch_l), tankCapL: Number(form.tank_cap_l),
      phWarnMax: Number(form.ph_warn_max), neutraliserLowPct: Number(form.neutraliser_low_pct),
    });
  }, [form, current]);

  /** Plain language about what this change means for the river. */
  const impact = useMemo(() => {
    if (!form || !current) return [];
    const out: Array<{ text: string; severe: boolean }> = [];
    if (Number(form.ph_min) < Number(current.ph_min)) {
      out.push({ text: `More acidic water will be allowed into the river: the floor drops from pH ${current.ph_min} to ${form.ph_min}.`, severe: true });
    }
    if (Number(form.ph_max) > Number(current.ph_max)) {
      out.push({ text: `More alkaline water will be allowed into the river: the ceiling rises from pH ${current.ph_max} to ${form.ph_max}.`, severe: true });
    }
    if (Number(form.tds_max) > Number(current.tds_max)) {
      out.push({ text: `Saltier water will be allowed into the river: the limit rises from ${current.tds_max} to ${form.tds_max} mg/L.`, severe: true });
    }
    if (Number(form.test_window_s) < Number(current.test_window_s)) {
      out.push({ text: `Each batch will be measured for less time (${form.test_window_s} s instead of ${current.test_window_s} s), so a noisy probe has more influence on the decision.`, severe: false });
    }
    if (Number(form.stable_window_s) < Number(current.stable_window_s)) {
      out.push({ text: `Treated water will be released after a shorter stable period (${form.stable_window_s} s instead of ${current.stable_window_s} s).`, severe: false });
    }
    if (Number(form.ph_min) > Number(current.ph_min) || Number(form.ph_max) < Number(current.ph_max) || Number(form.tds_max) < Number(current.tds_max)) {
      out.push({ text: 'These limits are tighter than the current ones. More batches will be diverted for treatment.', severe: false });
    }
    return out;
  }, [form, current]);

  const dirty = useMemo(() => {
    if (!form || !current) return false;
    return (Object.keys(form) as Array<keyof Form>).some(
      (k) => String((current as unknown as Record<string, unknown>)[k]) !== form[k],
    );
  }, [form, current]);

  async function apply() {
    if (!form || !session || !active) return;
    setBusy(true);
    try {
      await api.createConfig(active, {
        ph_min: Number(form.ph_min), ph_max: Number(form.ph_max), tds_max: Number(form.tds_max),
        treat_target_ph: Number(form.treat_target_ph),
        test_window_s: Number(form.test_window_s), stable_window_s: Number(form.stable_window_s),
        batch_l: Number(form.batch_l), tank_cap_l: Number(form.tank_cap_l),
        ph_warn_max: Number(form.ph_warn_max), neutraliser_low_pct: Number(form.neutraliser_low_pct),
      }, reason, session.user_id);
      push({
        tone: 'good',
        title: 'New configuration version created',
        body: 'The device applies it on its next poll and confirms back here.',
      });
      qc.invalidateQueries({ queryKey: ['configs'] });
      setConfirming(false);
      setReason('');
    } catch (e) {
      push({ tone: 'crit', title: 'Could not save it', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || !form) return <Spinner label="Loading settings" />;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Settings</h1>
          <p className="text-sm text-muted">Discharge limits, devices, people</p>
        </div>
        <Field label="Device">
          <Select value={active} onChange={(e) => setDeviceId(e.target.value)} className="min-w-[14rem]">
            {fleet?.map((f) => <option key={f.device_id} value={f.device_id}>{f.device_name}</option>)}
          </Select>
        </Field>
      </header>

      <Card>
        <CardHead
          title="Discharge limits"
          hint={`Version ${current?.version ?? 1}${current?.applied_at ? ' — confirmed by the device' : ' — waiting for the device to confirm'}`}
          right={current?.applied_at
            ? <Badge tone="good"><CheckCircle2 className="h-3.5 w-3.5" />applied</Badge>
            : <Badge tone="warn"><Clock className="h-3.5 w-3.5" />pending</Badge>}
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="pH floor" hint="Must be 6.0–7.0. Below this a batch is acidic and is diverted.">
            <Input inputMode="decimal" value={form.ph_min} onChange={set('ph_min')} />
          </Field>
          <Field label="pH ceiling" hint="Must be 8.0–9.5. Above this a batch is alkaline and is diverted.">
            <Input inputMode="decimal" value={form.ph_max} onChange={set('ph_max')} />
          </Field>
          <Field label="TDS limit (mg/L)" hint="500–2000. The tank cannot fix this, only divert it.">
            <Input inputMode="numeric" value={form.tds_max} onChange={set('tds_max')} />
          </Field>
          <Field label="Treatment target pH" hint="Dosing aims here — keep it away from both edges">
            <Input inputMode="decimal" value={form.treat_target_ph} onChange={set('treat_target_ph')} />
          </Field>
          <Field label="Test window (s)" hint="How long the probes are averaged before deciding">
            <Input inputMode="numeric" value={form.test_window_s} onChange={set('test_window_s')} />
          </Field>
          <Field label="Stable window (s)" hint="How long the tank must hold the band before V3 opens">
            <Input inputMode="numeric" value={form.stable_window_s} onChange={set('stable_window_s')} />
          </Field>
          <Field label="Batch volume (L)">
            <Input inputMode="numeric" value={form.batch_l} onChange={set('batch_l')} />
          </Field>
          <Field label="Tank capacity (L)">
            <Input inputMode="numeric" value={form.tank_cap_l} onChange={set('tank_cap_l')} />
          </Field>
          <Field label="pH warning threshold" hint="The dashboard warns above this even when the plant is coping">
            <Input inputMode="decimal" value={form.ph_warn_max} onChange={set('ph_warn_max')} />
          </Field>
          <Field label="Neutraliser reorder level (%)">
            <Input inputMode="numeric" value={form.neutraliser_low_pct} onChange={set('neutraliser_low_pct')} />
          </Field>
        </div>

        {validation ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-crit/50 bg-crit/5 p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-crit-ink" aria-hidden />
            <p className="text-sm text-ink">{validation}</p>
          </div>
        ) : null}

        {impact.length ? (
          <div className={`mt-4 rounded-lg border p-3 ${
            impact.some((i) => i.severe) ? 'border-warn/60 bg-warn/5' : 'border-line bg-raised'}`}>
            <p className="mb-1.5 flex items-center gap-2 text-sm font-medium text-ink">
              <ShieldAlert className="h-4 w-4 text-warn" aria-hidden />
              What this change means
            </p>
            <ul className="space-y-1 text-sm text-ink-2">
              {impact.map((i) => <li key={i.text}>• {i.text}</li>)}
            </ul>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!dirty || Boolean(validation)}
            onClick={() => setConfirming(true)}
          >
            Create a new version
          </Button>
          {dirty ? (
            <Button onClick={() => current && setForm({
              ph_min: String(current.ph_min), ph_max: String(current.ph_max),
              tds_max: String(current.tds_max), treat_target_ph: String(current.treat_target_ph),
              test_window_s: String(current.test_window_s), stable_window_s: String(current.stable_window_s),
              batch_l: String(current.batch_l), tank_cap_l: String(current.tank_cap_l),
              ph_warn_max: String(current.ph_warn_max), neutraliser_low_pct: String(current.neutraliser_low_pct),
            })}>
              Discard changes
            </Button>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHead title="Configuration history" hint="Versions are never edited, only superseded" />
        <Table head={['Version', 'pH band', 'TDS', 'Created', 'By', 'Reason', 'Applied']}>
          {(configs ?? []).map((c) => (
            <tr key={c.id} className="hover:bg-raised">
              <Td className="font-mono tabular text-ink">v{c.version}</Td>
              <Td className="font-mono tabular">{c.ph_min}–{c.ph_max}</Td>
              <Td className="font-mono tabular">{c.tds_max}</Td>
              <Td className="font-mono text-xs">{siteDateTime(c.created_at)}</Td>
              <Td className="text-xs">{c.created_by_name ?? '—'}</Td>
              <Td className="max-w-[18rem] text-xs">{c.reason ?? '—'}</Td>
              <Td>{c.applied_at ? <Badge tone="good">{ago(c.applied_at)}</Badge> : <Badge tone="warn">pending</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Devices" hint="An API key is shown once, at registration, and never again" />
          <Table head={['Device', 'Site', 'Firmware', 'Flow meter', 'Last seen']}>
            {fleet?.map((f) => (
              <tr key={f.device_id} className="hover:bg-raised">
                <Td className="text-ink">{f.device_name}</Td>
                <Td className="text-xs">{f.site_name}</Td>
                <Td className="font-mono text-xs">{f.firmware_version ?? '—'}</Td>
                <Td>{f.flow_sensor ? <Badge tone="good">fitted</Badge> : <Badge tone="neutral">estimated</Badge>}</Td>
                <Td className="text-xs">{ago(f.last_seen)}</Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 rounded-lg border border-line bg-raised p-3 text-xs text-ink-2">
            <p className="mb-1 flex items-center gap-2 font-medium text-ink">
              <KeyRound className="h-4 w-4" aria-hidden /> Registering a device
            </p>
            {isDemo ? (
              <p>
                Device registration mints a real API key, so it needs the backend. Configure Supabase and
                the button appears here; the key is returned once by the <span className="font-mono">register-device</span> edge
                function and only its SHA-256 hash is stored.
              </p>
            ) : (
              <p>
                Call the <span className="font-mono">register-device</span> function from here to mint a key.
                Copy it into the firmware immediately — it cannot be recovered, only rotated.
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="People" hint="Roles decide what each person can do" />
          <Table head={['Name', 'Role', 'Phone']}>
            {profiles?.map((p) => (
              <tr key={p.user_id} className="hover:bg-raised">
                <Td className="text-ink">{p.full_name}</Td>
                <Td>
                  <Badge tone={p.role === 'admin' ? 'info' : p.role === 'operator' ? 'good' : 'neutral'}>{p.role}</Badge>
                </Td>
                <Td className="font-mono text-xs">{p.phone ?? '—'}</Td>
              </tr>
            ))}
          </Table>
          <dl className="mt-3 space-y-1.5 text-xs text-ink-2">
            <div><dt className="inline font-medium text-ink">Viewer:</dt> <dd className="inline">reads everything, changes nothing.</dd></div>
            <div><dt className="inline font-medium text-ink">Operator:</dt> <dd className="inline">acknowledges alarms, sends commands, writes logs and records stock.</dd></div>
            <div><dt className="inline font-medium text-ink">Admin:</dt> <dd className="inline">everything, plus devices, people and discharge limits.</dd></div>
          </dl>
        </Card>
      </div>

      <Card>
        <CardHead title="Sites" />
        <Table head={['Site', 'Location', 'Owner', 'Timezone']}>
          {sites?.map((s) => (
            <tr key={s.id} className="hover:bg-raised">
              <Td className="text-ink">{s.name}</Td>
              <Td className="text-xs">{s.location ?? '—'}</Td>
              <Td className="text-xs">{s.mine_owner ?? '—'}</Td>
              <Td className="font-mono text-xs">{s.timezone}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Create a new configuration version"
        description={
          <div className="space-y-2">
            <p>
              This creates version {(current?.version ?? 0) + 1}. The current version is kept, unchanged, in the
              history, and the change is written to the audit log against your name.
            </p>
            {impact.some((i) => i.severe) ? (
              <p className="rounded-lg border border-warn/60 bg-warn/10 p-2 font-medium text-ink">
                You are loosening a discharge limit. More contaminated water will be allowed into the river.
              </p>
            ) : null}
          </div>
        }
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant={impact.some((i) => i.severe) ? 'danger' : 'primary'}
              loading={busy} disabled={reason.trim().length < 10} onClick={apply}>
              Create version {(current?.version ?? 0) + 1}
            </Button>
          </>
        }
      >
        <Field
          label="Reason for this change"
          hint="Required, at least ten characters. This goes into the compliance report."
        >
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Tightened the reorder level to 25% after the drum ran dry on the night shift" />
        </Field>
      </Dialog>
    </div>
  );
}
