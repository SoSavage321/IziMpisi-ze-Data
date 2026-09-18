/**
 * Cloud Functions — the parts of the system that must run whether or not
 * anybody has the dashboard open.
 *
 * The device data path does NOT go through here. A controller writes its own
 * telemetry straight to the Realtime Database under rules that scope it to its
 * own node, which keeps the whole live path on the free Spark plan and keeps
 * the ESP32 client to a single authenticated REST call.
 *
 * What these add:
 *   onLiveWrite      evaluate the alarm rules server-side on every device
 *                    report, so an alarm is raised with nobody watching
 *   escalateAlarms   escalate unacknowledged criticals after ten minutes
 *   sweepCommands    expire commands the device never picked up
 *   setUserRole      set the org/role custom claims the rules read
 *   registerDevice   create a device's own auth account and document
 *
 * Deploying needs the Blaze plan, because Functions build through Cloud Build.
 * Everything else in the project runs without them.
 */

import { onValueWritten } from 'firebase-functions/v2/database';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';

import {
  evaluateAlarms, reconcile, shouldEscalate,
  type AlarmContext, type ExistingAlarm,
} from './shared/alarms';
import { DEFAULT_CONFIG, type ControllerConfig, type TelemetrySample } from './shared/types';
import { sendEmail, sendSms, sendWhatsApp, type Notification } from './notify';

initializeApp();
// europe-west1 matches the Realtime Database instance, so a trigger does not
// cross a region to read the data that fired it.
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const db = getFirestore();
const rtdb = getDatabase();
const auth = getAuth();

// ============================================================ alarms ========

/**
 * Runs on every `live/{deviceId}` write — once every five seconds per device.
 *
 * The engine is a reconciler: it reports which conditions are true now, and
 * this raises what is newly true and clears what is no longer true. That gives
 * duplicate suppression for free, so an alarm stays one document from the
 * moment it is raised until the condition goes away.
 */
export const onLiveWrite = onValueWritten(
  { ref: '/live/{deviceId}', instance: process.env.RTDB_INSTANCE },
  async (event) => {
    const deviceId = event.params.deviceId;
    const latest = event.data.after.val() as TelemetrySample | null;
    if (!latest) return;

    const deviceSnap = await db.collection('devices').doc(deviceId).get();
    if (!deviceSnap.exists) return;
    const device = deviceSnap.data() as Record<string, any>;
    const now = Date.now();

    const config = await loadConfig(deviceId);

    // A five-minute window for the stuck-probe rule.
    const windowSnap = await rtdb.ref(`telemetry/${deviceId}`)
      .orderByChild('ts')
      .startAt(new Date(now - 5 * 60_000).toISOString())
      .get();
    const window = Object.values((windowSnap.val() ?? {}) as Record<string, TelemetrySample>)
      .sort((a, b) => a.ts.localeCompare(b.ts));

    const batchSnap = await db.collection('batches')
      .where('deviceId', '==', deviceId)
      .orderBy('startedAt', 'desc').limit(20).get();

    const cycleSnap = await db.collection('cycles')
      .where('deviceId', '==', deviceId)
      .orderBy('startedAt', 'desc').limit(1).get();
    const lastCycle = cycleSnap.docs[0]?.data();

    const overdueSnap = await db.collection('maintenanceItems')
      .where('deviceId', '==', deviceId)
      .where('nextDueAt', '<', Timestamp.fromMillis(now))
      .orderBy('nextDueAt').limit(1).get();
    const overdue = overdueSnap.docs[0]?.data();

    const ctx: AlarmContext = {
      now,
      device: {
        id: deviceId,
        name: device.name ?? 'Controller',
        last_seen: latest.ts,
        flow_sensor: Boolean(device.flowSensor),
      },
      config,
      latest,
      window,
      recentBatches: batchSnap.docs.map((d) => ({
        result: d.data().result,
        started_at: toIso(d.data().startedAt),
      })),
      heldSince: latest.state === 'HOLD' ? await heldSince(deviceId, now) : null,
      calibrationOverdue: overdue
        ? { component: overdue.component, next_due_at: toIso(overdue.nextDueAt) }
        : null,
      lastCycle: lastCycle
        ? { end_tds: lastCycle.endTds ?? null, released_at: lastCycle.releasedAt ? toIso(lastCycle.releasedAt) : null }
        : null,
      siteStock: await siteStock(device.siteId),
    };

    const active = evaluateAlarms(ctx);

    const openSnap = await db.collection('alarms')
      .where('deviceId', '==', deviceId)
      .where('clearedAt', '==', null)
      .get();
    const open: ExistingAlarm[] = openSnap.docs
      .map((d) => ({
        id: d.id,
        type: d.data().type,
        severity: d.data().severity,
        raised_at: toIso(d.data().raisedAt),
        acknowledged_at: d.data().acknowledgedAt ? toIso(d.data().acknowledgedAt) : null,
        escalated: Boolean(d.data().escalated),
      }))
      .filter((a) => a.severity !== 'info');

    const { toRaise, toClear } = reconcile(active, open);

    const batch = db.batch();
    for (const a of toClear) {
      batch.update(db.collection('alarms').doc(a.id), { clearedAt: FieldValue.serverTimestamp() });
    }
    for (const a of toRaise) {
      batch.set(db.collection('alarms').doc(), {
        orgId: device.orgId,
        deviceId,
        type: a.type,
        severity: a.severity,
        message: a.message,
        details: a.details,
        raisedAt: FieldValue.serverTimestamp(),
        acknowledgedBy: null,
        acknowledgedAt: null,
        ackNote: null,
        clearedAt: null,
        escalated: false,
      });
    }
    await batch.commit();

    for (const a of toRaise) {
      await notifySite(device.orgId, device.siteId, {
        severity: a.severity,
        site: await siteName(device.siteId),
        device: device.name ?? 'Controller',
        title: a.message,
        body: `${a.message}\n\nRaised ${new Date(now).toISOString()}.`,
        url: process.env.PUBLIC_APP_URL ? `${process.env.PUBLIC_APP_URL}/alarms` : undefined,
      });
    }
  },
);

/** An unacknowledged critical goes up to the site's admins after ten minutes. */
export const escalateAlarms = onSchedule('every 5 minutes', async () => {
  const now = Date.now();
  const snap = await db.collection('alarms')
    .where('clearedAt', '==', null)
    .where('severity', '==', 'critical')
    .where('escalated', '==', false)
    .get();

  for (const d of snap.docs) {
    const a = d.data();
    const alarm: ExistingAlarm = {
      id: d.id, type: a.type, severity: a.severity,
      raised_at: toIso(a.raisedAt),
      acknowledged_at: a.acknowledgedAt ? toIso(a.acknowledgedAt) : null,
      escalated: false,
    };
    if (!shouldEscalate(alarm, now)) continue;

    const device = (await db.collection('devices').doc(a.deviceId).get()).data();
    const minutes = Math.round((now - Date.parse(alarm.raised_at)) / 60000);

    await notifySite(a.orgId, device?.siteId, {
      severity: 'critical',
      site: await siteName(device?.siteId),
      device: device?.name ?? 'Controller',
      title: `ESCALATED after ${minutes} min unacknowledged: ${a.message}`,
      body:
        `This critical alarm has been open for ${minutes} minutes with no acknowledgement.\n\n` +
        `${a.message}\n\n` +
        'The plant is still enforcing its interlocks, but nobody has taken ownership of this fault.',
      url: process.env.PUBLIC_APP_URL ? `${process.env.PUBLIC_APP_URL}/alarms` : undefined,
    });

    await d.ref.update({ escalated: true, escalatedAt: FieldValue.serverTimestamp() });
  }
});

/**
 * Expire commands the device never picked up. A controller returning from an
 * outage must not execute an emergency instruction issued ten minutes ago and
 * since overtaken.
 */
export const sweepCommands = onSchedule('every 1 minutes', async () => {
  const now = new Date().toISOString();
  const all = await rtdb.ref('commands').get();
  const updates: Record<string, unknown> = {};

  for (const [deviceId, commands] of Object.entries((all.val() ?? {}) as Record<string, Record<string, any>>)) {
    for (const [id, c] of Object.entries(commands)) {
      if (c.status === 'pending' && c.expiresAt && c.expiresAt < now) {
        updates[`commands/${deviceId}/${id}/status`] = 'expired';
        updates[`commands/${deviceId}/${id}/reason`] = 'No acknowledgement from the device within 30 s';
        updates[`commands/${deviceId}/${id}/resolvedAt`] = now;
      }
    }
  }
  if (Object.keys(updates).length) await rtdb.ref().update(updates);
});

// ======================================================= admin callables ====

/** Set the org and role claims the security rules read. Admins only. */
export const setUserRole = onCall(async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in first');
  if (caller.token.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only');

  const { userId, role } = request.data as { userId: string; role: string };
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    throw new HttpsError('invalid-argument', `Unknown role "${role}"`);
  }

  const orgId = caller.token.orgId as string;
  const profile = await db.collection('profiles').doc(userId).get();
  if (profile.data()?.orgId !== orgId) {
    throw new HttpsError('permission-denied', 'That user is not in your organisation');
  }

  await auth.setCustomUserClaims(userId, { orgId, role });
  await profile.ref.update({ role });
  await db.collection('auditLog').add({
    orgId, actor: caller.uid, action: 'SET_ROLE',
    targetTable: 'profiles', targetId: userId,
    before: { role: profile.data()?.role }, after: { role },
    ts: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/**
 * Create a controller: its own auth account, its device document, and its
 * first configuration. The device id IS the account uid, which is what lets
 * the database rule `auth.uid == $deviceId` scope a device to its own node.
 */
export const registerDevice = onCall(async (request) => {
  const caller = request.auth;
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in first');
  if (caller.token.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only');

  const { siteId, name, flowSensor } = request.data as
    { siteId: string; name: string; flowSensor?: boolean };
  const orgId = caller.token.orgId as string;

  const site = await db.collection('sites').doc(siteId).get();
  if (!site.exists || site.data()?.orgId !== orgId) {
    throw new HttpsError('permission-denied', 'That site is not in your organisation');
  }

  const email = `device-${Date.now().toString(36)}@${process.env.GCLOUD_PROJECT}.iam`;
  const password = randomSecret();
  const user = await auth.createUser({ email, password, displayName: name });
  await auth.setCustomUserClaims(user.uid, { orgId, role: 'device', deviceId: user.uid });

  await db.collection('devices').doc(user.uid).set({
    orgId, siteId, name, flowSensor: Boolean(flowSensor),
    firmwareVersion: null, status: 'never_seen', lastSeen: null,
    configVersion: 1, authEmail: email,
  });

  await db.collection('deviceConfig').add({
    orgId, deviceId: user.uid, version: 1, ...toFirestoreConfig(DEFAULT_CONFIG),
    reason: 'Initial configuration at registration',
    createdBy: caller.uid, createdAt: FieldValue.serverTimestamp(), appliedAt: null,
  });

  await db.collection('auditLog').add({
    orgId, actor: caller.uid, action: 'REGISTER_DEVICE',
    targetTable: 'devices', targetId: user.uid,
    before: null, after: { siteId, name }, ts: FieldValue.serverTimestamp(),
  });

  // Shown once. It cannot be recovered, only rotated.
  return { deviceId: user.uid, email, password };
});

// ============================================================ helpers =======

function toIso(v: any): string {
  if (!v) return new Date(0).toISOString();
  if (typeof v === 'string') return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  return v.toDate ? v.toDate().toISOString() : new Date(v).toISOString();
}

function toFirestoreConfig(c: ControllerConfig) {
  return {
    phMin: c.phMin, phMax: c.phMax, tdsMax: c.tdsMax,
    treatTargetPh: c.treatTargetPh, testWindowS: c.testWindowS,
    stableWindowS: c.stableWindowS, batchL: c.batchL, tankCapL: c.tankCapL,
    phWarnMax: c.phWarnMax, neutraliserLowPct: c.neutraliserLowPct,
  };
}

async function loadConfig(deviceId: string): Promise<ControllerConfig> {
  const snap = await db.collection('deviceConfig')
    .where('deviceId', '==', deviceId)
    .orderBy('version', 'desc').limit(1).get();
  const d = snap.docs[0]?.data();
  if (!d) return DEFAULT_CONFIG;
  return {
    version: d.version,
    phMin: Number(d.phMin), phMax: Number(d.phMax), tdsMax: Number(d.tdsMax),
    treatTargetPh: Number(d.treatTargetPh),
    testWindowS: Number(d.testWindowS), stableWindowS: Number(d.stableWindowS),
    batchL: Number(d.batchL), tankCapL: Number(d.tankCapL),
    phWarnMax: Number(d.phWarnMax), neutraliserLowPct: Number(d.neutraliserLowPct),
  };
}

/** When the current HOLD started, from the device's own event log. */
async function heldSince(deviceId: string, now: number): Promise<string | null> {
  const snap = await db.collection('events')
    .where('deviceId', '==', deviceId)
    .where('type', '==', 'STATE_CHANGE')
    .orderBy('ts', 'desc').limit(50).get();

  for (const d of snap.docs) {
    const to = d.data().details?.to;
    if (to === 'HOLD') return toIso(d.data().ts);
    if (to && to !== 'HOLD') return null;
  }
  void now;
  return null;
}

/**
 * Neutraliser held in the store for a site. The drum on the plant and the
 * store behind it are different things: the drum can read full while there is
 * nothing left to refill it with, so the alarm engine is told both.
 */
async function siteStock(siteId?: string) {
  if (!siteId) return null;
  const snap = await db.collection('inventory')
    .where('siteId', '==', siteId)
    .get();
  const doc = snap.docs.find((d) => String(d.data().item ?? '').includes('neutraliser'));
  if (!doc) return null;
  const d = doc.data();
  return {
    item: String(d.item),
    stock: Number(d.stock ?? 0),
    reorder_level: Number(d.reorderLevel ?? 0),
    unit: String(d.unit ?? 'L'),
  };
}

async function siteName(siteId?: string): Promise<string> {
  if (!siteId) return 'Site';
  const s = await db.collection('sites').doc(siteId).get();
  return s.data()?.name ?? 'Site';
}

/** Who should hear about this, and how they asked to hear it. */
async function notifySite(orgId: string, siteId: string | undefined, n: Notification) {
  if (!siteId) return;
  try {
    const prefs = await db.collection('notificationPrefs')
      .where('orgId', '==', orgId)
      .where('siteId', '==', siteId)
      .get();

    const rank: Record<string, number> = { info: 0, warning: 1, critical: 2 };

    for (const p of prefs.docs) {
      const pref = p.data();
      if (rank[n.severity] < rank[pref.minSeverity ?? 'warning']) continue;

      const profile = await db.collection('profiles').doc(pref.userId).get();
      const email = profile.data()?.email;
      const phone = profile.data()?.phone;

      if (pref.email && email) await sendEmail(email, n);
      if (pref.sms && phone) await sendSms(phone, n);
      if (pref.whatsapp && phone) await sendWhatsApp(phone, n);
    }
  } catch (e) {
    // A notification that cannot be sent must never take down the alarm engine.
    console.error('notification dispatch failed', e);
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
