#!/usr/bin/env tsx
/**
 * Seed a Supabase project with a demo organisation.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed
 *
 * Creates one organisation, two sites, three devices (printing each device's
 * API key once — copy them into the firmware), three users covering all three
 * roles, and seven days of batches, treatment cycles, alarms and telemetry so
 * the dashboard is full the first time somebody opens it.
 *
 * Safe to re-run: it deletes the demo organisation first.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.\n' +
    'Both are in your Supabase project under Settings -> API.\n' +
    'The service role key bypasses RLS: never put it in the frontend or in git.',
  );
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const ORG_NAME = 'WaterGuard demo — Mpumalanga';
const PASSWORD = 'demo1234';

const USERS = [
  { email: 'admin@waterguard.demo', name: 'Thandi Mokoena', role: 'admin', phone: '+27 82 000 0001' },
  { email: 'operator@waterguard.demo', name: 'Sipho Dlamini', role: 'operator', phone: '+27 82 000 0002' },
  { email: 'viewer@waterguard.demo', name: 'Elmarie van Wyk', role: 'viewer', phone: '+27 82 000 0003' },
];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deterministic RNG so a reseed tells the same story. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const now = Date.now();
  const rand = rng(20260917);

  console.log('Clearing any previous demo organisation…');
  const { data: existing } = await db.from('organisations').select('id').eq('name', ORG_NAME);
  for (const org of existing ?? []) {
    await db.from('organisations').delete().eq('id', org.id);   // cascades
  }

  // ------------------------------------------------------------- tenancy ---
  const { data: org, error: orgErr } = await db
    .from('organisations').insert({ name: ORG_NAME }).select('id').single();
  if (orgErr || !org) throw orgErr ?? new Error('could not create the organisation');
  console.log(`organisation ${org.id}`);

  const { data: sites, error: siteErr } = await db.from('sites').insert([
    {
      org_id: org.id, name: 'Kusile — sump 3', location: 'Wilge outfall, Mpumalanga',
      latitude: -25.9861, longitude: 29.0919, mine_owner: 'Eskom / Kusile Power Station',
      timezone: 'Africa/Johannesburg',
    },
    {
      org_id: org.id, name: 'Phola colliery — north pit', location: 'Ogies, Mpumalanga',
      latitude: -26.0516, longitude: 29.0722, mine_owner: 'Phola Coal',
      timezone: 'Africa/Johannesburg',
    },
  ]).select('id, name');
  if (siteErr || !sites) throw siteErr ?? new Error('could not create sites');
  console.log(`sites: ${sites.map((s) => s.name).join(', ')}`);

  // --------------------------------------------------------------- people ---
  const userIds: Record<string, string> = {};
  for (const u of USERS) {
    // Remove any previous demo account so the script is re-runnable.
    const { data: list } = await db.auth.admin.listUsers();
    const prior = list?.users.find((x) => x.email === u.email);
    if (prior) await db.auth.admin.deleteUser(prior.id);

    const { data, error } = await db.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: u.name, phone: u.phone, role: u.role, org_id: org.id },
    });
    if (error || !data.user) throw error ?? new Error(`could not create ${u.email}`);
    userIds[u.role] = data.user.id;

    // The auth trigger writes the profile; make sure the role stuck even if
    // the trigger is not installed.
    await db.from('profiles').upsert({
      user_id: data.user.id, org_id: org.id, full_name: u.name, phone: u.phone, role: u.role,
    });

    // Everyone hears about critical alarms at both sites by default.
    for (const site of sites) {
      await db.from('notification_prefs').upsert({
        user_id: data.user.id, site_id: site.id,
        email: true, sms: false, whatsapp: false,
        min_severity: u.role === 'viewer' ? 'critical' : 'warning',
      });
    }
    console.log(`user ${u.email} (${u.role}) — password ${PASSWORD}`);
  }

  // -------------------------------------------------------------- devices ---
  const deviceSpecs = [
    { site: sites[0].id, name: 'WG-01 sump 3 controller', flow: false, dirty: 0.28 },
    { site: sites[0].id, name: 'WG-02 settling pond', flow: true, dirty: 0.45 },
    { site: sites[1].id, name: 'WG-03 north pit', flow: false, dirty: 0.22 },
  ];

  const keys: Array<[string, string]> = [];
  const devices: Array<{ id: string; name: string; dirty: number }> = [];

  for (const spec of deviceSpecs) {
    const key = `wg_live_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const { data: device, error } = await db.from('devices').insert({
      site_id: spec.site, name: spec.name, api_key_hash: sha256(key),
      firmware_version: '1.0.0', flow_sensor: spec.flow, status: 'online',
      last_seen: iso(now - 4000),
    }).select('id, name').single();
    if (error || !device) throw error ?? new Error('could not create a device');

    keys.push([spec.name, key]);
    devices.push({ id: device.id, name: device.name, dirty: spec.dirty });

    await db.from('device_config').insert({
      device_id: device.id, version: 1,
      reason: 'Initial configuration at registration', created_by: userIds.admin,
      applied_at: iso(now - 7 * 86400_000 + 60_000),
    });

    await db.from('maintenance_items').insert([
      { device_id: device.id, component: 'pH probe', task: 'calibrate', interval_days: 30,
        last_done_at: iso(now - (spec.name.includes('WG-02') ? 41 : 9) * 86400_000) },
      { device_id: device.id, component: 'TDS probe', task: 'calibrate', interval_days: 90,
        last_done_at: iso(now - 20 * 86400_000) },
      { device_id: device.id, component: 'Dosing pump', task: 'service', interval_days: 180,
        last_done_at: iso(now - 60 * 86400_000) },
    ]);
  }

  // One configuration change in the period, so the compliance report has
  // something real to show under "limits changed".
  await db.from('device_config').insert({
    device_id: devices[0].id, version: 2,
    ph_min: 6.5, ph_max: 8.5, tds_max: 1200, treat_target_ph: 6.8,
    test_window_s: 3, stable_window_s: 3, batch_l: 100, tank_cap_l: 300,
    ph_warn_max: 8.5, neutraliser_low_pct: 25,
    reason: 'Raised the neutraliser reorder level to 25% after the drum ran dry on the night shift',
    created_by: userIds.admin,
    created_at: iso(now - 3 * 86400_000),
    applied_at: iso(now - 3 * 86400_000 + 120_000),
  });

  // ----------------------------------------------------- seven days of work ---
  console.log('Generating seven days of batches…');
  for (const device of devices) {
    const batches: Record<string, unknown>[] = [];
    const cycles: Record<string, unknown>[] = [];
    let batchNo = 0;
    let cycleNo = 0;

    for (let t = now - 7 * 86400_000; t < now - 120_000; t += 6 * 60_000) {
      batchNo += 1;
      // The night shift runs dirtier than the day shift, which is a real
      // pattern on site and makes the analytics page say something true.
      const hour = new Date(t).getUTCHours();
      const dirty = device.dirty * (hour >= 22 || hour <= 4 ? 1.7 : 1);

      let avgPh = 6.7 + rand() * 1.4;
      let avgTds = 380 + rand() * 420;
      let reason: string | null = null;

      if (rand() < dirty) {
        const kind = rand();
        if (kind < 0.55) { avgPh = 3.2 + rand() * 3.1; reason = 'ACID'; }
        else if (kind < 0.8) { avgPh = 8.6 + rand() * 1.1; reason = 'ALKALINE'; }
        else { avgTds = 1250 + rand() * 700; reason = 'TDS'; }
      }

      const pass = reason === null;
      batches.push({
        device_id: device.id, batch_no: batchNo,
        started_at: iso(t), ended_at: iso(t + 190_000),
        avg_ph: round2(avgPh), avg_tds: Math.round(avgTds),
        result: pass ? 'PASS' : 'FAIL',
        destination: pass ? 'RIVER' : 'TANK',
        volume_l: 100, fail_reason: reason,
      });

      if (!pass) {
        cycleNo += 1;
        cycles.push({
          device_id: device.id, cycle_no: cycleNo,
          started_at: iso(t + 200_000),
          released_at: iso(t + 200_000 + Math.round((160 + rand() * 220) * 1000)),
          start_ph: round2(avgPh), end_ph: round2(6.85 + rand() * 0.5),
          end_tds: Math.round(reason === 'TDS' ? avgTds * 0.95 : avgTds),
          neutraliser_used_pct: round2(0.4 + rand() * 1.6),
          volume_released_l: 100,
        });
      }
    }

    // Insert in chunks; a week of six-minute batches is ~1,680 rows per device.
    for (let n = 0; n < batches.length; n += 500) {
      const { error } = await db.from('batches').insert(batches.slice(n, n + 500));
      if (error) throw error;
    }
    for (let n = 0; n < cycles.length; n += 500) {
      const { error } = await db.from('treatment_cycles').insert(cycles.slice(n, n + 500));
      if (error) throw error;
    }
    console.log(`  ${device.name}: ${batches.length} batches, ${cycles.length} treatment cycles`);

    // Twenty minutes of recent telemetry so the live charts have a trace.
    const telemetry: Record<string, unknown>[] = [];
    for (let n = 240; n >= 0; n--) {
      const ts = now - n * 5000;
      const ph = 6.9 + Math.sin(n / 9) * 0.5 + (rand() - 0.5) * 0.08;
      telemetry.push({
        device_id: device.id, ts: iso(ts),
        state: n % 40 < 24 ? 'FILL' : n % 40 < 30 ? 'TEST' : 'DISCHARGE',
        mode: 'AUTO', estop: false,
        ph: round2(ph), tds: Math.round(430 + Math.sin(n / 14) * 90),
        chamber_l: round2((n % 40) * 4), tank_l: 0, tank_cap_l: 300,
        tank_ph: 7.0, tank_tds: 400, neutraliser_pct: 84,
        v1: n % 40 >= 30, v2: false, v3: false,
        sump_pump: n % 40 < 24, dosing_pump: false, siren: false,
        led: n % 40 >= 30 ? 'green' : n % 40 < 24 ? 'off' : 'yellow',
        wifi_rssi: -58, uptime_s: 86400 + n,
      });
    }
    const { error: telErr } = await db.from('telemetry').insert(telemetry);
    if (telErr) throw telErr;
  }

  // -------------------------------------------------------------- alarms ---
  const incidents = [
    ['neutraliser_low', 'warning', 'Neutraliser down to 18% — below the 20% reorder level', 5.4, true],
    ['ph_high_chamber', 'warning', 'Chamber pH 9.05 is above the 8.5 alkaline limit — check for over-dosing upstream', 3.2, true],
    ['neutraliser_empty', 'critical', 'Neutraliser reservoir is empty — V3 is locked and the siren is sounding', 2.8, true],
  ] as const;

  for (const [type, severity, message, daysAgo, cleared] of incidents) {
    const raised = now - daysAgo * 86400_000;
    await db.from('alarms').insert({
      device_id: devices[0].id, type, severity, message,
      raised_at: iso(raised),
      acknowledged_by: userIds.operator, acknowledged_at: iso(raised + 4 * 60_000),
      ack_note: type === 'neutraliser_empty' ? 'Refilled the drum from the store, 20 L' : 'Seen, monitoring',
      cleared_at: cleared ? iso(raised + 46 * 60_000) : null,
    });
  }

  // One that is still open and unacknowledged, so the alarms page has work on it.
  await db.from('alarms').insert({
    device_id: devices[1].id, type: 'calibration_overdue', severity: 'warning',
    message: 'pH probe calibration is 11 days overdue — readings may be drifting',
    details: { component: 'pH probe', days_overdue: 11 },
    raised_at: iso(now - 40 * 60_000),
  });

  // ----------------------------------------------------- stock and logbook ---
  const { data: inv } = await db.from('inventory').insert([
    { site_id: sites[0].id, item: 'neutraliser (hydrated lime slurry)', unit: 'L',
      stock: 340, reorder_level: 120, supplier: 'Mpumalanga Chemical Supplies', cost_per_unit: 48 },
    { site_id: sites[1].id, item: 'neutraliser (hydrated lime slurry)', unit: 'L',
      stock: 85, reorder_level: 120, supplier: 'Mpumalanga Chemical Supplies', cost_per_unit: 48 },
  ]).select('id, site_id');

  if (inv?.length) {
    await db.from('inventory_movements').insert([
      { inventory_id: inv[0].id, delta: 200, kind: 'delivery',
        note: 'PO 4471, delivered to the store', created_by: userIds.operator,
        created_at: iso(now - 4 * 86400_000) },
      { inventory_id: inv[0].id, delta: -20, kind: 'usage',
        note: 'Drum refill at WG-01', created_by: userIds.operator,
        created_at: iso(now - 2 * 86400_000) },
    ]);
  }

  await db.from('shift_logs').insert({
    site_id: sites[0].id, author: userIds.operator,
    shift_start: iso(now - 14 * 3600_000), shift_end: iso(now - 6 * 3600_000),
    notes:
      'Night shift. Inflow turned acid around 01:00, twelve batches diverted in a row. Tank kept up. ' +
      'Refilled the neutraliser drum at 03:20 — about half a drum left in the store.',
    handover_to: userIds.admin,
  });

  await db.from('maintenance_logs').insert({
    device_id: devices[0].id, performed_by: userIds.operator,
    performed_at: iso(now - 9 * 86400_000),
    notes: 'Two-point calibration with pH 4.01 and pH 7.00 buffers. Probe cleaned, membrane intact.',
    before_values: { point_1: 4.18, point_2: 7.14 },
    after_values: { point_1: 4.01, point_2: 7.0 },
  });

  // ------------------------------------------------------------------ done ---
  console.log('\n--- device API keys, shown once ---');
  for (const [name, key] of keys) console.log(`${name}\n  ${key}\n`);
  console.log('Put one of these in firmware/waterguard_esp32/secrets.h, or run the simulator:');
  console.log(`  npm run sim -- --key ${keys[0][1]} --api ${url}/functions/v1\n`);
  console.log(`Sign in at the dashboard with ${USERS[0].email} / ${PASSWORD}`);
}

main().catch((e) => {
  console.error('\nSeeding failed:', e.message ?? e);
  process.exit(1);
});
