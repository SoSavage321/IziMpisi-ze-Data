/**
 * POST /ingest — the device's only write endpoint.
 *
 * The ESP32 buffers everything it produces in a ring buffer while it is
 * offline and posts the backlog when WiFi returns, so this endpoint must be
 * idempotent: telemetry upserts on (device_id, ts), batches on
 * (device_id, batch_no), cycles on (device_id, cycle_no). Replaying the same
 * backlog twice must not double-count a single litre.
 *
 * After storing, it runs the alarm rules over the new state and reconciles
 * them against what is already open, then notifies anyone who asked to hear
 * about it. A notification failure never fails the ingest.
 */

import { admin, authenticateDevice, fail, json, loadConfig, CORS } from '../_shared/device-auth.ts';
import { notify } from '../_shared/notify.ts';
import {
  evaluateAlarms,
  reconcile,
  batchInfoAlarm,
  cycleInfoAlarm,
  AlarmCandidate,
  AlarmContext,
  ExistingAlarm,
} from '../_shared/lib/alarms.ts';
import { DEFAULT_CONFIG, IngestPayload, TelemetrySample } from '../_shared/lib/types.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('POST only', 405);

  const db = admin();
  const device = await authenticateDevice(req, db);
  if (!device) return fail('Unknown or missing device key', 401);

  let payload: IngestPayload;
  try {
    payload = await req.json();
  } catch {
    return fail('Body is not valid JSON', 400);
  }

  const now = Date.now();
  const stored = { telemetry: 0, batches: 0, cycles: 0, events: 0, acks: 0 };

  // ------------------------------------------------------------ telemetry ---
  const samples = (payload.telemetry ?? []).filter(isPlausible);
  if (samples.length) {
    const rows = samples.map((s) => ({ device_id: device.id, ...s }));
    const { error } = await db.from('telemetry').upsert(rows, {
      onConflict: 'device_id,ts',
      ignoreDuplicates: true,
    });
    if (error) return fail(`Could not store telemetry: ${error.message}`, 500);
    stored.telemetry = rows.length;
  }

  // -------------------------------------------------------------- batches ---
  if (payload.batches?.length) {
    const rows = payload.batches.map((b) => ({ device_id: device.id, ...b }));
    const { error } = await db.from('batches').upsert(rows, { onConflict: 'device_id,batch_no' });
    if (error) return fail(`Could not store batches: ${error.message}`, 500);
    stored.batches = rows.length;
  }

  if (payload.cycles?.length) {
    const rows = payload.cycles.map((c) => ({ device_id: device.id, ...c }));
    const { error } = await db.from('treatment_cycles').upsert(rows, { onConflict: 'device_id,cycle_no' });
    if (error) return fail(`Could not store treatment cycles: ${error.message}`, 500);
    stored.cycles = rows.length;
  }

  // --------------------------------------------------------------- events ---
  if (payload.events?.length) {
    const rows = payload.events.map((e) => ({ device_id: device.id, ts: e.ts, type: e.type, details: e.details }));
    const { error } = await db.from('events').insert(rows);
    if (!error) stored.events = rows.length;
  }

  // --------------------------------------------------------- command acks ---
  // The device may also ack through /commands/ack; accepting them here lets a
  // device that was offline flush everything in one request.
  for (const ack of payload.command_acks ?? []) {
    const { error } = await db
      .from('commands')
      .update({
        status: ack.accepted ? 'accepted' : 'rejected',
        reason: ack.reason,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', ack.id)
      .eq('device_id', device.id)
      .eq('status', 'pending');
    if (!error) stored.acks += 1;
  }

  // ------------------------------------------------------- device heartbeat ---
  const latest = newest(samples);
  const patch: Record<string, unknown> = {
    last_seen: new Date().toISOString(),
    status: 'online',
  };
  if (payload.firmware_version) patch.firmware_version = payload.firmware_version;
  if (typeof payload.flow_sensor === 'boolean') patch.flow_sensor = payload.flow_sensor;
  await db.from('devices').update(patch).eq('id', device.id);

  // A device reporting the version it is actually running confirms the apply.
  if (payload.config_version) {
    await db
      .from('device_config')
      .update({ applied_at: new Date().toISOString() })
      .eq('device_id', device.id)
      .eq('version', payload.config_version)
      .is('applied_at', null);
  }

  // ---------------------------------------------------------------- alarms ---
  let raised: AlarmCandidate[] = [];
  let cleared = 0;
  try {
    const result = await runAlarmEngine(db, device, latest, payload, now);
    raised = result.raised;
    cleared = result.cleared;
  } catch (e) {
    // Never fail an ingest because the alarm engine had a bad day — the
    // telemetry is already safe and the next sample re-evaluates everything.
    console.error('alarm engine error', e);
  }

  return json({
    ok: true,
    stored,
    alarms_raised: raised.map((a) => ({ type: a.type, severity: a.severity })),
    alarms_cleared: cleared,
    config_version: device.config_version,
  });
});

/** Reject obvious nonsense before it reaches the database. */
function isPlausible(s: TelemetrySample): boolean {
  if (!s || typeof s.ts !== 'string' || Number.isNaN(Date.parse(s.ts))) return false;
  // A sample dated more than a day in the future is a clock fault, not data.
  if (Date.parse(s.ts) > Date.now() + 86_400_000) return false;
  return true;
}

function newest(samples: TelemetrySample[]): TelemetrySample | null {
  if (!samples.length) return null;
  return samples.reduce((a, b) => (Date.parse(a.ts) >= Date.parse(b.ts) ? a : b));
}

async function runAlarmEngine(
  db: ReturnType<typeof admin>,
  device: { id: string; name: string; site_id: string; flow_sensor: boolean },
  latest: TelemetrySample | null,
  payload: IngestPayload,
  now: number,
) {
  const config = (await loadConfig(db, device.id)) ?? DEFAULT_CONFIG;

  // A five-minute window for the stuck-probe rule.
  const { data: window } = await db
    .from('telemetry')
    .select('*')
    .eq('device_id', device.id)
    .gte('ts', new Date(now - 5 * 60_000).toISOString())
    .order('ts', { ascending: true });

  const { data: recentBatches } = await db
    .from('batches')
    .select('result, started_at')
    .eq('device_id', device.id)
    .order('started_at', { ascending: false })
    .limit(20);

  const { data: lastCycle } = await db
    .from('treatment_cycles')
    .select('end_tds, released_at')
    .eq('device_id', device.id)
    .not('released_at', 'is', null)
    .order('released_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: overdue } = await db
    .from('maintenance_items')
    .select('component, next_due_at')
    .eq('device_id', device.id)
    .lt('next_due_at', new Date(now).toISOString())
    .order('next_due_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  // How long the plant has been holding a batch, from its own state history.
  const heldSince = latest?.state === 'HOLD' ? await heldSinceFor(db, device.id, now) : null;

  const interlock = (payload.events ?? []).find((e) => e.type === 'INTERLOCK_BLOCK');

  const ctx: AlarmContext = {
    now,
    device: { id: device.id, name: device.name, last_seen: new Date().toISOString(), flow_sensor: device.flow_sensor },
    config,
    latest,
    window: (window ?? []) as unknown as TelemetrySample[],
    recentBatches: recentBatches ?? [],
    heldSince,
    interlockViolation: interlock ? { reason: String(interlock.details?.reason ?? 'unspecified') } : null,
    calibrationOverdue: overdue ? { component: overdue.component, next_due_at: overdue.next_due_at } : null,
    lastCycle: lastCycle ?? null,
  };

  const active = evaluateAlarms(ctx);

  const { data: open } = await db
    .from('alarms')
    .select('id, type, severity, raised_at, acknowledged_at, escalated')
    .eq('device_id', device.id)
    .is('cleared_at', null)
    .neq('severity', 'info');

  const { toRaise, toClear } = reconcile(active, (open ?? []) as ExistingAlarm[]);

  // Conditions that have gone away
  if (toClear.length) {
    await db
      .from('alarms')
      .update({ cleared_at: new Date().toISOString() })
      .in('id', toClear.map((a) => a.id));
  }

  // New conditions. The partial unique index is the real guard against
  // duplicates, so a lost race here resolves as a conflict, not a double row.
  for (const a of toRaise) {
    await db.from('alarms').insert({
      device_id: device.id,
      type: a.type,
      severity: a.severity,
      message: a.message,
      details: a.details,
    });
  }

  // Info notifications from the records themselves.
  const info: AlarmCandidate[] = [];
  for (const b of payload.batches ?? []) {
    const a = batchInfoAlarm(b as any);
    if (a) info.push(a);
  }
  for (const c of payload.cycles ?? []) {
    if (c.released_at) info.push(cycleInfoAlarm(c as any));
  }
  if (info.length) {
    await db.from('alarms').insert(
      info.map((a) => ({
        device_id: device.id,
        type: a.type,
        severity: a.severity,
        message: a.message,
        details: a.details,
        cleared_at: new Date().toISOString(),   // a record of something done, not an open condition
      })),
    );
  }

  // Tell people about the new ones.
  const appUrl = Deno.env.get('PUBLIC_APP_URL') ?? '';
  const { data: site } = await db.from('sites').select('name').eq('id', device.site_id).maybeSingle();
  for (const a of toRaise) {
    if (a.severity === 'info') continue;
    await notify(db, device.site_id, {
      severity: a.severity,
      site: site?.name ?? 'Site',
      device: device.name,
      title: a.message,
      body: `${a.message}\n\nRaised ${new Date(now).toISOString()}.`,
      url: appUrl ? `${appUrl}/alarms` : undefined,
    });
  }

  return { raised: toRaise, cleared: toClear.length };
}

/** When the current HOLD started, from the state-change event log. */
async function heldSinceFor(db: ReturnType<typeof admin>, deviceId: string, now: number): Promise<string | null> {
  const { data } = await db
    .from('events')
    .select('ts, details')
    .eq('device_id', deviceId)
    .eq('type', 'STATE_CHANGE')
    .gte('ts', new Date(now - 24 * 3600_000).toISOString())
    .order('ts', { ascending: false })
    .limit(50);

  if (!data?.length) return null;
  // Walk back to the transition INTO hold that has not been left since.
  for (const row of data) {
    const to = (row.details as Record<string, unknown>)?.to;
    if (to === 'HOLD') return row.ts as string;
    if (to && to !== 'HOLD') return null;
  }
  return null;
}
