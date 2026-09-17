#!/usr/bin/env tsx
/**
 * Seed the Firebase project.
 *
 *   npm run seed:firebase
 *
 * Needs a service account key, because creating users and setting the custom
 * claims that the security rules read is an admin operation:
 *
 *   Firebase console -> Project settings -> Service accounts
 *   -> Generate new private key  -> save it somewhere outside the repo
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json     (Windows)
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json    (macOS/Linux)
 *
 * Creates one organisation, two sites, three devices, three users covering all
 * three roles, and seven days of batches, cycles and alarms so the dashboard is
 * full the first time somebody opens it.
 *
 * Safe to re-run: it deletes the demo organisation's data first.
 *
 * Device accounts: each controller gets its own Firebase Auth account, and the
 * device document id IS that account's uid. The Realtime Database rules then
 * read `auth.uid == $deviceId`, so a device can only ever write its own node.
 * Its email and password go into the firmware's secrets.h.
 */

import { cert, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { readFileSync } from 'node:fs';

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'izimpisi-ze-data';
const DB_URL = process.env.FIREBASE_DATABASE_URL
  ?? `https://${PROJECT}-default-rtdb.europe-west1.firebasedatabase.app`;
const KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!KEY) {
  console.error(
    'Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file first.\n' +
    'Firebase console -> Project settings -> Service accounts -> Generate new private key.',
  );
  process.exit(1);
}

initializeApp({
  credential: KEY ? cert(JSON.parse(readFileSync(KEY, 'utf8'))) : applicationDefault(),
  databaseURL: DB_URL,
  projectId: PROJECT,
});

const auth = getAuth();
const db = getFirestore();
const rtdb = getDatabase();

const PASSWORD = 'demo1234';
const ORG_ID = 'izimpisi-demo';

const USERS = [
  { email: 'admin@waterguard.demo', name: 'Thandi Mokoena', role: 'admin', phone: '+27 82 000 0001' },
  { email: 'operator@waterguard.demo', name: 'Sipho Dlamini', role: 'operator', phone: '+27 82 000 0002' },
  { email: 'viewer@waterguard.demo', name: 'Elmarie van Wyk', role: 'viewer', phone: '+27 82 000 0003' },
];

const ts = (ms: number) => Timestamp.fromDate(new Date(ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delete every document in a collection that belongs to the demo org. */
async function wipe(name: string) {
  const snap = await db.collection(name).where('orgId', '==', ORG_ID).get();
  let batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

/** Write documents in chunks of 400 — Firestore caps a batch at 500 writes. */
async function writeAll(name: string, docs: Array<Record<string, unknown>>) {
  let batch = db.batch();
  let n = 0;
  for (const data of docs) {
    batch.set(db.collection(name).doc(), data);
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

async function main() {
  const now = Date.now();
  const rand = rng(20260917);

  console.log(`Seeding ${PROJECT}\n`);

  console.log('Clearing previous demo data…');
  for (const c of ['sites', 'devices', 'deviceConfig', 'batches', 'cycles', 'alarms',
                   'events', 'maintenanceItems', 'maintenanceLogs', 'inventory',
                   'inventoryMovements', 'shiftLogs', 'auditLog', 'profiles']) {
    const removed = await wipe(c);
    if (removed) console.log(`  ${c}: removed ${removed}`);
  }

  await db.collection('orgs').doc(ORG_ID).set({
    orgId: ORG_ID, name: 'IziMpisi ze-Data — demo', createdAt: FieldValue.serverTimestamp(),
  });

  // ------------------------------------------------------------- people ---
  const userIds: Record<string, string> = {};
  for (const u of USERS) {
    let uid: string;
    try {
      const existing = await auth.getUserByEmail(u.email);
      uid = existing.uid;
      await auth.updateUser(uid, { password: PASSWORD, displayName: u.name });
    } catch {
      const created = await auth.createUser({
        email: u.email, password: PASSWORD, displayName: u.name, emailVerified: true,
      });
      uid = created.uid;
    }
    // The rules read these claims. Without them a user sees nothing at all.
    await auth.setCustomUserClaims(uid, { orgId: ORG_ID, role: u.role });
    await db.collection('profiles').doc(uid).set({
      orgId: ORG_ID, fullName: u.name, phone: u.phone, role: u.role, email: u.email,
    });
    userIds[u.role] = uid;
    console.log(`user ${u.email} (${u.role}) — password ${PASSWORD}`);
  }

  // -------------------------------------------------------------- sites ---
  const siteSpecs = [
    { id: 'site-kusile', name: 'Kusile — sump 3', location: 'Wilge outfall, Mpumalanga',
      latitude: -25.9861, longitude: 29.0919, mineOwner: 'Eskom / Kusile Power Station' },
    { id: 'site-phola', name: 'Phola colliery — north pit', location: 'Ogies, Mpumalanga',
      latitude: -26.0516, longitude: 29.0722, mineOwner: 'Phola Coal' },
  ];
  for (const s of siteSpecs) {
    await db.collection('sites').doc(s.id).set({
      ...s, orgId: ORG_ID, timezone: 'Africa/Johannesburg',
    });
  }
  console.log(`sites: ${siteSpecs.map((s) => s.name).join(', ')}`);

  // ------------------------------------------------------------ devices ---
  // One Firebase Auth account per controller; the device id IS its uid.
  const deviceSpecs = [
    { site: 'site-kusile', name: 'WG-01 sump 3 controller', flow: false, dirty: 0.28 },
    { site: 'site-kusile', name: 'WG-02 settling pond', flow: true, dirty: 0.45 },
    { site: 'site-phola', name: 'WG-03 north pit', flow: false, dirty: 0.22 },
  ];

  const devices: Array<{ id: string; name: string; dirty: number; email: string; password: string }> = [];

  for (const [n, spec] of deviceSpecs.entries()) {
    const email = `device-wg0${n + 1}@${PROJECT}.iam`;
    const password = `dev-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

    let uid: string;
    try {
      const existing = await auth.getUserByEmail(email);
      uid = existing.uid;
      await auth.updateUser(uid, { password });
    } catch {
      const created = await auth.createUser({ email, password, displayName: spec.name });
      uid = created.uid;
    }
    await auth.setCustomUserClaims(uid, { orgId: ORG_ID, role: 'device', deviceId: uid });

    await db.collection('devices').doc(uid).set({
      orgId: ORG_ID, siteId: spec.site, name: spec.name,
      firmwareVersion: '1.0.0', flowSensor: spec.flow,
      status: 'online', lastSeen: ts(now - 4000), configVersion: 1,
      authEmail: email,
    });

    await db.collection('deviceConfig').add({
      orgId: ORG_ID, deviceId: uid, version: 1,
      phMin: 6.5, phMax: 8.5, tdsMax: 1200, treatTargetPh: 6.8,
      testWindowS: 3, stableWindowS: 3, batchL: 100, tankCapL: 300,
      phWarnMax: 8.5, neutraliserLowPct: 20,
      reason: 'Initial configuration at registration',
      createdBy: userIds.admin, createdByName: 'Thandi Mokoena',
      createdAt: ts(now - 7 * 86400_000), appliedAt: ts(now - 7 * 86400_000 + 60_000),
    });

    await rtdb.ref(`deviceConfig/${uid}`).set({
      version: 1, ph_min: 6.5, ph_max: 8.5, tds_max: 1200, treat_target_ph: 6.8,
      test_window_s: 3, stable_window_s: 3, batch_l: 100, tank_cap_l: 300,
      ph_warn_max: 8.5, neutraliser_low_pct: 20,
    });

    await writeAll('maintenanceItems', [
      { orgId: ORG_ID, deviceId: uid, component: 'pH probe', task: 'calibrate', intervalDays: 30,
        lastDoneAt: ts(now - (n === 1 ? 41 : 9) * 86400_000),
        nextDueAt: ts(now - (n === 1 ? 11 : -21) * 86400_000) },
      { orgId: ORG_ID, deviceId: uid, component: 'TDS probe', task: 'calibrate', intervalDays: 90,
        lastDoneAt: ts(now - 20 * 86400_000), nextDueAt: ts(now + 70 * 86400_000) },
      { orgId: ORG_ID, deviceId: uid, component: 'Dosing pump', task: 'service', intervalDays: 180,
        lastDoneAt: ts(now - 60 * 86400_000), nextDueAt: ts(now + 120 * 86400_000) },
    ]);

    devices.push({ id: uid, name: spec.name, dirty: spec.dirty, email, password });
  }

  // -------------------------------------------------- seven days of work ---
  console.log('\nGenerating seven days of batches…');
  for (const device of devices) {
    const batches: Array<Record<string, unknown>> = [];
    const cycles: Array<Record<string, unknown>> = [];
    let batchNo = 0;
    let cycleNo = 0;

    for (let t = now - 7 * 86400_000; t < now - 120_000; t += 6 * 60_000) {
      batchNo += 1;
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
        orgId: ORG_ID, deviceId: device.id, batchNo,
        startedAt: ts(t), endedAt: ts(t + 190_000),
        avgPh: round2(avgPh), avgTds: Math.round(avgTds),
        result: pass ? 'PASS' : 'FAIL',
        destination: pass ? 'RIVER' : 'TANK',
        volumeL: 100, failReason: reason,
      });

      if (!pass) {
        cycleNo += 1;
        cycles.push({
          orgId: ORG_ID, deviceId: device.id, cycleNo,
          startedAt: ts(t + 200_000),
          releasedAt: ts(t + 200_000 + Math.round((160 + rand() * 220) * 1000)),
          startPh: round2(avgPh), endPh: round2(6.85 + rand() * 0.5),
          endTds: Math.round(reason === 'TDS' ? avgTds * 0.95 : avgTds),
          neutraliserUsedPct: round2(0.4 + rand() * 1.6),
          volumeReleasedL: 100,
        });
      }
    }

    await writeAll('batches', batches);
    await writeAll('cycles', cycles);
    console.log(`  ${device.name}: ${batches.length} batches, ${cycles.length} cycles`);

    // Live state and twenty minutes of telemetry, so the charts have a trace.
    const telemetry: Record<string, unknown> = {};
    let latest: Record<string, unknown> = {};
    for (let n = 240; n >= 0; n--) {
      const at = now - n * 5000;
      const ph = 6.9 + Math.sin(n / 9) * 0.5 + (rand() - 0.5) * 0.08;
      const sample = {
        ts: new Date(at).toISOString(),
        state: n % 40 < 24 ? 'FILL' : n % 40 < 30 ? 'TEST' : 'DISCHARGE',
        mode: 'AUTO', estop: false,
        ph: round2(ph), tds: Math.round(430 + Math.sin(n / 14) * 90),
        chamber_l: round2((n % 40) * 4), tank_l: 0, tank_cap_l: 300,
        tank_ph: 7.0, tank_tds: 400, neutraliser_pct: 84,
        v1: n % 40 >= 30, v2: false, v3: false,
        sump_pump: n % 40 < 24, dosing_pump: false, siren: false,
        led: n % 40 >= 30 ? 'green' : n % 40 < 24 ? 'off' : 'yellow',
        wifi_rssi: -58, uptime_s: 86400 + n,
      };
      telemetry[`s${String(at)}`] = sample;
      latest = sample;
    }
    await rtdb.ref(`telemetry/${device.id}`).set(telemetry);
    await rtdb.ref(`live/${device.id}`).set({ ...latest, v3_lock_reason: null });
  }

  // -------------------------------------------------------------- alarms ---
  const first = devices[0];
  const second = devices[1];
  await writeAll('alarms', [
    { orgId: ORG_ID, deviceId: first.id, type: 'neutraliser_low', severity: 'warning',
      message: 'Neutraliser down to 18% — below the 20% reorder level', details: {},
      raisedAt: ts(now - 5.4 * 86400_000), acknowledgedBy: userIds.operator,
      acknowledgedAt: ts(now - 5.4 * 86400_000 + 240_000), ackNote: 'Seen, monitoring',
      clearedAt: ts(now - 5.4 * 86400_000 + 2760_000), escalated: false },
    { orgId: ORG_ID, deviceId: first.id, type: 'neutraliser_empty', severity: 'critical',
      message: 'Neutraliser reservoir is empty — V3 is locked and the siren is sounding', details: {},
      raisedAt: ts(now - 2.8 * 86400_000), acknowledgedBy: userIds.operator,
      acknowledgedAt: ts(now - 2.8 * 86400_000 + 240_000),
      ackNote: 'Refilled the drum from the store, 20 L',
      clearedAt: ts(now - 2.8 * 86400_000 + 2760_000), escalated: false },
    // still open, so the alarms page has work on it
    { orgId: ORG_ID, deviceId: second.id, type: 'calibration_overdue', severity: 'warning',
      message: 'pH probe calibration is 11 days overdue — readings may be drifting',
      details: { component: 'pH probe', daysOverdue: 11 },
      raisedAt: ts(now - 40 * 60_000), acknowledgedBy: null, acknowledgedAt: null,
      ackNote: null, clearedAt: null, escalated: false },
  ]);

  // ----------------------------------------------------- stock and logbook ---
  const invRef = await db.collection('inventory').add({
    orgId: ORG_ID, siteId: 'site-kusile', item: 'neutraliser (hydrated lime slurry)',
    unit: 'L', stock: 340, reorderLevel: 120,
    supplier: 'Mpumalanga Chemical Supplies', costPerUnit: 48,
    updatedAt: ts(now - 86400_000),
  });
  await db.collection('inventory').add({
    orgId: ORG_ID, siteId: 'site-phola', item: 'neutraliser (hydrated lime slurry)',
    unit: 'L', stock: 85, reorderLevel: 120,
    supplier: 'Mpumalanga Chemical Supplies', costPerUnit: 48,
    updatedAt: ts(now - 3 * 86400_000),
  });
  await writeAll('inventoryMovements', [
    { orgId: ORG_ID, inventoryId: invRef.id, delta: 200, kind: 'delivery',
      note: 'PO 4471, delivered to the store', createdBy: userIds.operator,
      createdByName: 'Sipho Dlamini', createdAt: ts(now - 4 * 86400_000) },
    { orgId: ORG_ID, inventoryId: invRef.id, delta: -20, kind: 'usage',
      note: 'Drum refill at WG-01', createdBy: userIds.operator,
      createdByName: 'Sipho Dlamini', createdAt: ts(now - 2 * 86400_000) },
  ]);

  await writeAll('shiftLogs', [{
    orgId: ORG_ID, siteId: 'site-kusile',
    author: userIds.operator, authorName: 'Sipho Dlamini',
    shiftStart: ts(now - 14 * 3600_000), shiftEnd: ts(now - 6 * 3600_000),
    notes: 'Night shift. Inflow turned acid around 01:00, twelve batches diverted in a row. ' +
           'Tank kept up. Refilled the neutraliser drum at 03:20 — about half a drum left in the store.',
    handoverTo: userIds.admin, handoverToName: 'Thandi Mokoena',
    createdAt: ts(now - 6 * 3600_000),
  }]);

  await writeAll('maintenanceLogs', [{
    orgId: ORG_ID, deviceId: first.id, itemId: null,
    performedBy: userIds.operator, performedByName: 'Sipho Dlamini',
    performedAt: ts(now - 9 * 86400_000),
    notes: 'Two-point calibration with pH 4.01 and pH 7.00 buffers. Probe cleaned, membrane intact.',
    beforeValues: { point_1: 4.18, point_2: 7.14 },
    afterValues: { point_1: 4.01, point_2: 7.0 },
  }]);

  await writeAll('auditLog', [{
    orgId: ORG_ID, actor: userIds.admin, actorName: 'Thandi Mokoena', action: 'INSERT',
    targetTable: 'deviceConfig', targetId: first.id,
    before: null, after: { version: 1, phMin: 6.5, phMax: 8.5 },
    ts: ts(now - 7 * 86400_000),
  }]);

  // ---------------------------------------------------------------- done ---
  console.log('\n--- device accounts, for firmware/secrets.h ---');
  for (const d of devices) {
    console.log(`${d.name}`);
    console.log(`  DEVICE_ID       ${d.id}`);
    console.log(`  DEVICE_EMAIL    ${d.email}`);
    console.log(`  DEVICE_PASSWORD ${d.password}\n`);
  }
  console.log(`Sign in at https://${PROJECT}.web.app with ${USERS[0].email} / ${PASSWORD}`);
  console.log('\nIf sign-in fails with "operation not allowed", switch on Email/Password under');
  console.log('Authentication -> Sign-in method in the Firebase console.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeeding failed:', e?.message ?? e);
    process.exit(1);
  });
