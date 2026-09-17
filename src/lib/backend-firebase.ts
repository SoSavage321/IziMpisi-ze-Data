/**
 * Firebase implementation of the data layer.
 *
 * Exposes exactly the surface `api.ts` defines, so every page works unchanged
 * whether it is talking to the in-browser demo, Supabase, or this.
 *
 * Live state (device status, telemetry, the command queue) comes from the
 * Realtime Database; records come from Firestore. `subscribeLive` watches both
 * and tells TanStack Query to refetch.
 */

import {
  signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged, type User,
} from 'firebase/auth';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, query, where,
  orderBy, limit as fsLimit, onSnapshot, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { ref, get, set, push, onValue, query as rtQuery, orderByChild, startAt } from 'firebase/database';

import { COL, RTDB, fbAuth, fbRtdb, fbStore } from './firebase.ts';
import type {
  Alarm, AuditRow, Batch, Command, DeviceConfig, DeviceEventRow, DutyCounters,
  FleetRow, InventoryItem, InventoryMovement, MaintenanceItem, MaintenanceLog,
  Profile, Role, ShiftLog, Site, Telemetry, TreatmentCycle,
} from './types.ts';
import type { Session } from './api.ts';

// --------------------------------------------------------------- helpers ---

/** Firestore timestamps and ISO strings both become an ISO string. */
function iso(v: unknown): string {
  if (!v) return new Date(0).toISOString();
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  const maybe = v as { toDate?: () => Date };
  return maybe.toDate ? maybe.toDate().toISOString() : new Date(0).toISOString();
}

function rows<T>(snap: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }, map: (id: string, d: any) => T): T[] {
  return snap.docs.map((d) => map(d.id, d.data()));
}

async function orgId(): Promise<string> {
  const user = fbAuth().currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdTokenResult();
  const org = token.claims.orgId as string | undefined;
  if (!org) {
    throw new Error(
      'This account has no organisation claim yet. An admin must run the seed or the setRole tool for it.',
    );
  }
  return org;
}

async function uid(): Promise<string> {
  const user = fbAuth().currentUser;
  if (!user) throw new Error('Not signed in');
  return user.uid;
}

function nowIso() { return new Date().toISOString(); }

// ------------------------------------------------------------------ auth ---

export const firebaseAuthApi = {
  /** Resolves once Firebase has restored (or failed to restore) the session. */
  async current(): Promise<Session | null> {
    const auth = fbAuth();
    const user: User | null = await new Promise((resolve) => {
      const stop = onAuthStateChanged(auth, (u) => { stop(); resolve(u); });
    });
    if (!user) return null;

    const token = await user.getIdTokenResult();
    const snap = await getDoc(doc(fbStore(), COL.profiles, user.uid));
    const data = snap.data() ?? {};

    return {
      user_id: user.uid,
      email: user.email ?? '',
      profile: {
        user_id: user.uid,
        org_id: (token.claims.orgId as string) ?? (data.orgId as string) ?? '',
        full_name: (data.fullName as string) ?? user.displayName ?? user.email ?? 'Operator',
        phone: (data.phone as string) ?? null,
        role: ((token.claims.role as Role) ?? (data.role as Role) ?? 'viewer'),
        email: user.email,
      },
    };
  },

  async signIn(email: string, password: string): Promise<Session> {
    try {
      await signInWithEmailAndPassword(fbAuth(), email.trim(), password);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
        throw new Error('That email and password do not match an account.');
      }
      if (code.includes('operation-not-allowed')) {
        throw new Error(
          'Email sign-in is not switched on for this Firebase project yet. ' +
          'Enable it under Authentication in the Firebase console.',
        );
      }
      throw new Error((e as Error).message);
    }
    const session = await firebaseAuthApi.current();
    if (!session) throw new Error('Signed in, but no profile was found for this account.');
    return session;
  },

  async signOut() { await fbSignOut(fbAuth()); },
};

// ------------------------------------------------------------------ data ---

export const firebaseApi = {
  async sites(): Promise<Site[]> {
    const org = await orgId();
    const snap = await getDocs(query(collection(fbStore(), COL.sites), where('orgId', '==', org)));
    return rows(snap, (id, d) => ({
      id, org_id: d.orgId, name: d.name, location: d.location ?? null,
      latitude: d.latitude ?? null, longitude: d.longitude ?? null,
      mine_owner: d.mineOwner ?? null, timezone: d.timezone ?? 'Africa/Johannesburg',
    })).sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Devices and sites come from Firestore; the live half of each row comes
   * from the Realtime Database, where the device writes every five seconds.
   */
  async fleet(): Promise<FleetRow[]> {
    const org = await orgId();
    const store = fbStore();

    const [deviceSnap, siteSnap] = await Promise.all([
      getDocs(query(collection(store, COL.devices), where('orgId', '==', org))),
      getDocs(query(collection(store, COL.sites), where('orgId', '==', org))),
    ]);

    const sites = new Map(siteSnap.docs.map((d) => [d.id, d.data()]));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);

    const out: FleetRow[] = [];
    for (const d of deviceSnap.docs) {
      const dev = d.data();
      const site = sites.get(dev.siteId) ?? {};

      const [liveSnap, batchSnap, alarmSnap] = await Promise.all([
        get(ref(fbRtdb(), RTDB.live(d.id))),
        getDocs(query(
          collection(store, COL.batches),
          where('deviceId', '==', d.id),
          where('startedAt', '>=', Timestamp.fromDate(midnight)),
        )),
        getDocs(query(
          collection(store, COL.alarms),
          where('deviceId', '==', d.id),
          where('clearedAt', '==', null),
        )),
      ]);

      const live = (liveSnap.val() ?? {}) as Partial<Telemetry> & { ts?: string };
      const lastSeen = live.ts ?? (dev.lastSeen ? iso(dev.lastSeen) : null);
      const offline = !lastSeen || Date.now() - Date.parse(lastSeen) > 60_000;

      const todays = batchSnap.docs.map((b) => b.data());
      const alarms = alarmSnap.docs.map((a) => a.data()).filter((a) => a.severity !== 'info');

      out.push({
        device_id: d.id,
        device_name: dev.name,
        site_id: dev.siteId,
        site_name: (site as { name?: string }).name ?? 'Site',
        location: (site as { location?: string }).location ?? null,
        latitude: (site as { latitude?: number }).latitude ?? null,
        longitude: (site as { longitude?: number }).longitude ?? null,
        timezone: (site as { timezone?: string }).timezone ?? 'Africa/Johannesburg',
        last_seen: lastSeen,
        firmware_version: dev.firmwareVersion ?? null,
        flow_sensor: Boolean(dev.flowSensor),
        config_version: dev.configVersion ?? 1,
        offline,
        state: offline ? null : live.state ?? null,
        mode: live.mode ?? 'AUTO',
        estop: Boolean(live.estop),
        ph: live.ph ?? null,
        tds: live.tds ?? null,
        neutraliser_pct: live.neutraliser_pct ?? null,
        tank_l: live.tank_l ?? null,
        tank_cap_l: live.tank_cap_l ?? 300,
        v1: Boolean(live.v1), v2: Boolean(live.v2), v3: Boolean(live.v3),
        siren: Boolean(live.siren),
        led: live.led ?? 'off',
        active_alarms: alarms.length,
        critical_alarms: alarms.filter((a) => a.severity === 'critical').length,
        batches_today: todays.length,
        passed_today: todays.filter((b) => b.result === 'PASS').length,
        litres_to_river_today: todays.filter((b) => b.destination === 'RIVER')
          .reduce((s, b) => s + Number(b.volumeL ?? 0), 0),
        litres_blocked_today: todays.filter((b) => b.destination !== 'RIVER')
          .reduce((s, b) => s + Number(b.volumeL ?? 0), 0),
      });
    }
    return out.sort((a, b) => a.site_name.localeCompare(b.site_name));
  },

  async device(deviceId: string): Promise<FleetRow | null> {
    const all = await firebaseApi.fleet();
    return all.find((f) => f.device_id === deviceId) ?? null;
  },

  async telemetry(deviceId: string, minutes = 30): Promise<Telemetry[]> {
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
    const snap = await get(rtQuery(
      ref(fbRtdb(), RTDB.telemetry(deviceId)), orderByChild('ts'), startAt(cutoff),
    ));
    const val = (snap.val() ?? {}) as Record<string, Telemetry>;
    return Object.values(val).sort((a, b) => a.ts.localeCompare(b.ts));
  },

  async v3Lock(deviceId: string): Promise<string | null> {
    const snap = await get(ref(fbRtdb(), `${RTDB.live(deviceId)}/v3_lock_reason`));
    return (snap.val() as string | null) ?? null;
  },

  async batches(opts: { deviceId?: string; from?: string; to?: string; limit?: number; result?: string } = {}): Promise<Batch[]> {
    const org = await orgId();
    const clauses = [opts.deviceId ? where('deviceId', '==', opts.deviceId) : where('orgId', '==', org)];
    if (opts.result) clauses.push(where('result', '==', opts.result));
    if (opts.from) clauses.push(where('startedAt', '>=', Timestamp.fromDate(new Date(opts.from))));
    if (opts.to) clauses.push(where('startedAt', '<=', Timestamp.fromDate(new Date(opts.to))));

    const snap = await getDocs(query(
      collection(fbStore(), COL.batches), ...clauses,
      orderBy('startedAt', 'desc'), fsLimit(opts.limit ?? 500),
    ));

    return rows(snap, (id, d) => ({
      id, device_id: d.deviceId, batch_no: d.batchNo,
      started_at: iso(d.startedAt), ended_at: d.endedAt ? iso(d.endedAt) : null,
      avg_ph: d.avgPh ?? null, avg_tds: d.avgTds ?? null,
      result: d.result, destination: d.destination,
      volume_l: Number(d.volumeL ?? 100), fail_reason: d.failReason ?? null,
    }));
  },

  async cycles(opts: { deviceId?: string; from?: string; to?: string } = {}): Promise<TreatmentCycle[]> {
    const org = await orgId();
    const clauses = [opts.deviceId ? where('deviceId', '==', opts.deviceId) : where('orgId', '==', org)];
    if (opts.from) clauses.push(where('startedAt', '>=', Timestamp.fromDate(new Date(opts.from))));
    if (opts.to) clauses.push(where('startedAt', '<=', Timestamp.fromDate(new Date(opts.to))));

    const snap = await getDocs(query(
      collection(fbStore(), COL.cycles), ...clauses, orderBy('startedAt', 'desc'), fsLimit(500),
    ));
    return rows(snap, (id, d) => ({
      id, device_id: d.deviceId, cycle_no: d.cycleNo,
      started_at: iso(d.startedAt), released_at: d.releasedAt ? iso(d.releasedAt) : null,
      start_ph: d.startPh ?? null, end_ph: d.endPh ?? null, end_tds: d.endTds ?? null,
      neutraliser_used_pct: d.neutraliserUsedPct ?? null,
      volume_released_l: d.volumeReleasedL ?? null,
    }));
  },

  async alarms(opts: { deviceId?: string; activeOnly?: boolean; severity?: string; from?: string } = {}): Promise<Alarm[]> {
    const org = await orgId();
    const clauses = [opts.deviceId ? where('deviceId', '==', opts.deviceId) : where('orgId', '==', org)];
    if (opts.activeOnly) clauses.push(where('clearedAt', '==', null));
    if (opts.severity) clauses.push(where('severity', '==', opts.severity));
    if (opts.from) clauses.push(where('raisedAt', '>=', Timestamp.fromDate(new Date(opts.from))));

    const snap = await getDocs(query(
      collection(fbStore(), COL.alarms), ...clauses, orderBy('raisedAt', 'desc'), fsLimit(400),
    ));
    const fleet = await firebaseApi.fleet();

    return rows(snap, (id, d) => {
      const dev = fleet.find((f) => f.device_id === d.deviceId);
      return {
        id, device_id: d.deviceId, type: d.type, severity: d.severity,
        message: d.message, details: d.details ?? {},
        raised_at: iso(d.raisedAt),
        acknowledged_by: d.acknowledgedBy ?? null,
        acknowledged_at: d.acknowledgedAt ? iso(d.acknowledgedAt) : null,
        ack_note: d.ackNote ?? null,
        cleared_at: d.clearedAt ? iso(d.clearedAt) : null,
        escalated: Boolean(d.escalated),
        device_name: dev?.device_name, site_name: dev?.site_name,
      };
    });
  },

  async ackAlarm(id: string, note: string, userId: string): Promise<void> {
    await updateDoc(doc(fbStore(), COL.alarms, id), {
      acknowledgedBy: userId,
      acknowledgedAt: serverTimestamp(),
      ackNote: note || null,
    });
  },

  async events(deviceId: string, limitCount = 100): Promise<DeviceEventRow[]> {
    const snap = await getDocs(query(
      collection(fbStore(), COL.events),
      where('deviceId', '==', deviceId),
      orderBy('ts', 'desc'), fsLimit(limitCount),
    ));
    return rows(snap, (id, d) => ({
      id, device_id: d.deviceId, ts: iso(d.ts), type: d.type, details: d.details ?? {},
    }));
  },

  // ------------------------------------------------------------ commands ---

  /**
   * Commands live in the Realtime Database because the device polls them every
   * two seconds and writes its verdict straight back onto the same node.
   */
  async commands(deviceId: string, limitCount = 25): Promise<Command[]> {
    const snap = await get(ref(fbRtdb(), RTDB.commands(deviceId)));
    const val = (snap.val() ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(val)
      .map(([id, c]) => ({
        id,
        device_id: deviceId,
        requested_by: (c.requestedBy as string) ?? null,
        requested_by_name: (c.requestedByName as string) ?? undefined,
        type: c.type as string,
        payload: (c.payload as Record<string, unknown>) ?? {},
        status: (c.status as Command['status']) ?? 'pending',
        reason: (c.reason as string) ?? null,
        created_at: (c.createdAt as string) ?? nowIso(),
        expires_at: (c.expiresAt as string) ?? nowIso(),
        resolved_at: (c.resolvedAt as string) ?? null,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limitCount);
  },

  async sendCommand(deviceId: string, type: string, payload: Record<string, unknown>, userId: string): Promise<Command> {
    const session = await firebaseAuthApi.current();
    const node = push(ref(fbRtdb(), RTDB.commands(deviceId)));
    const row = {
      type,
      payload,
      status: 'pending' as const,
      requestedBy: userId,
      requestedByName: session?.profile.full_name ?? 'operator',
      createdAt: nowIso(),
      // The device refuses anything older than this, and so does the dashboard.
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      reason: null,
      resolvedAt: null,
    };
    await set(node, row);
    return {
      id: node.key as string, device_id: deviceId,
      requested_by: userId, requested_by_name: row.requestedByName,
      type, payload, status: 'pending', reason: null,
      created_at: row.createdAt, expires_at: row.expiresAt, resolved_at: null,
    };
  },

  // -------------------------------------------------------------- config ---

  async configs(deviceId: string): Promise<DeviceConfig[]> {
    const snap = await getDocs(query(
      collection(fbStore(), COL.deviceConfig),
      where('deviceId', '==', deviceId),
      orderBy('version', 'desc'),
    ));
    return rows(snap, (id, d) => ({
      id, device_id: d.deviceId, version: d.version,
      ph_min: Number(d.phMin), ph_max: Number(d.phMax), tds_max: Number(d.tdsMax),
      treat_target_ph: Number(d.treatTargetPh),
      test_window_s: Number(d.testWindowS), stable_window_s: Number(d.stableWindowS),
      batch_l: Number(d.batchL), tank_cap_l: Number(d.tankCapL),
      ph_warn_max: Number(d.phWarnMax), neutraliser_low_pct: Number(d.neutraliserLowPct),
      reason: d.reason ?? null, created_by: d.createdBy ?? null,
      created_by_name: d.createdByName ?? undefined,
      created_at: iso(d.createdAt), applied_at: d.appliedAt ? iso(d.appliedAt) : null,
    }));
  },

  async createConfig(deviceId: string, values: Partial<DeviceConfig>, reason: string, userId: string): Promise<DeviceConfig> {
    const org = await orgId();
    const session = await firebaseAuthApi.current();
    const existing = await firebaseApi.configs(deviceId);
    const version = (existing[0]?.version ?? 0) + 1;

    const payload = {
      deviceId, orgId: org, version,
      phMin: values.ph_min, phMax: values.ph_max, tdsMax: values.tds_max,
      treatTargetPh: values.treat_target_ph,
      testWindowS: values.test_window_s, stableWindowS: values.stable_window_s,
      batchL: values.batch_l, tankCapL: values.tank_cap_l,
      phWarnMax: values.ph_warn_max, neutraliserLowPct: values.neutraliser_low_pct,
      reason, createdBy: userId, createdByName: session?.profile.full_name ?? null,
      createdAt: serverTimestamp(), appliedAt: null,
    };
    const created = await addDoc(collection(fbStore(), COL.deviceConfig), payload);

    // Publish it where the device will see it on its next poll.
    await set(ref(fbRtdb(), RTDB.config(deviceId)), {
      version,
      ph_min: values.ph_min, ph_max: values.ph_max, tds_max: values.tds_max,
      treat_target_ph: values.treat_target_ph,
      test_window_s: values.test_window_s, stable_window_s: values.stable_window_s,
      batch_l: values.batch_l, tank_cap_l: values.tank_cap_l,
      ph_warn_max: values.ph_warn_max, neutraliser_low_pct: values.neutraliser_low_pct,
    });

    return { ...(values as DeviceConfig), id: created.id, device_id: deviceId, version, reason, created_by: userId, created_at: nowIso(), applied_at: null };
  },

  // --------------------------------------------------------- maintenance ---

  async maintenance(deviceId?: string): Promise<MaintenanceItem[]> {
    const org = await orgId();
    const clause = deviceId ? where('deviceId', '==', deviceId) : where('orgId', '==', org);
    const snap = await getDocs(query(collection(fbStore(), COL.maintenanceItems), clause));
    return rows(snap, (id, d) => ({
      id, device_id: d.deviceId, component: d.component, task: d.task,
      interval_days: d.intervalDays ?? null,
      last_done_at: d.lastDoneAt ? iso(d.lastDoneAt) : null,
      next_due_at: d.nextDueAt ? iso(d.nextDueAt) : null,
    })).sort((a, b) => (a.next_due_at ?? '').localeCompare(b.next_due_at ?? ''));
  },

  async maintenanceLogs(deviceId?: string): Promise<MaintenanceLog[]> {
    const org = await orgId();
    const clause = deviceId ? where('deviceId', '==', deviceId) : where('orgId', '==', org);
    const snap = await getDocs(query(
      collection(fbStore(), COL.maintenanceLogs), clause, orderBy('performedAt', 'desc'), fsLimit(100),
    ));
    return rows(snap, (id, d) => ({
      id, item_id: d.itemId ?? null, device_id: d.deviceId,
      performed_by: d.performedBy ?? null, performed_by_name: d.performedByName ?? undefined,
      performed_at: iso(d.performedAt), notes: d.notes ?? null,
      before_values: d.beforeValues ?? {}, after_values: d.afterValues ?? {},
    }));
  },

  async logMaintenance(input: {
    itemId: string | null; deviceId: string; notes: string;
    before: Record<string, unknown>; after: Record<string, unknown>; userId: string;
  }): Promise<void> {
    const org = await orgId();
    const session = await firebaseAuthApi.current();
    await addDoc(collection(fbStore(), COL.maintenanceLogs), {
      orgId: org, itemId: input.itemId, deviceId: input.deviceId,
      performedBy: input.userId, performedByName: session?.profile.full_name ?? null,
      performedAt: serverTimestamp(), notes: input.notes,
      beforeValues: input.before, afterValues: input.after,
    });

    if (input.itemId) {
      const itemRef = doc(fbStore(), COL.maintenanceItems, input.itemId);
      const item = await getDoc(itemRef);
      const days = Number(item.data()?.intervalDays ?? 30);
      await updateDoc(itemRef, {
        lastDoneAt: serverTimestamp(),
        nextDueAt: Timestamp.fromDate(new Date(Date.now() + days * 86400_000)),
      });
    }
  },

  /** Derived from telemetry, exactly as the SQL view does. */
  async duty(deviceId: string): Promise<DutyCounters> {
    const samples = await firebaseApi.telemetry(deviceId, 24 * 60);
    let sump = 0, dosing = 0, v1 = 0, v2 = 0, v3 = 0;
    for (let n = 1; n < samples.length; n++) {
      const dt = Math.min((Date.parse(samples[n].ts) - Date.parse(samples[n - 1].ts)) / 1000, 30);
      if (samples[n].sump_pump) sump += dt;
      if (samples[n].dosing_pump) dosing += dt;
      if (samples[n].v1 && !samples[n - 1].v1) v1 += 1;
      if (samples[n].v2 && !samples[n - 1].v2) v2 += 1;
      if (samples[n].v3 && !samples[n - 1].v3) v3 += 1;
    }
    return {
      sump_run_hours: Math.round((sump / 3600) * 100) / 100,
      dosing_run_hours: Math.round((dosing / 3600) * 100) / 100,
      v1_cycles: v1, v2_cycles: v2, v3_cycles: v3,
    };
  },

  // ----------------------------------------------------------- inventory ---

  async inventory(): Promise<InventoryItem[]> {
    const org = await orgId();
    const snap = await getDocs(query(collection(fbStore(), COL.inventory), where('orgId', '==', org)));
    return rows(snap, (id, d) => ({
      id, site_id: d.siteId, item: d.item, unit: d.unit ?? 'L',
      stock: Number(d.stock ?? 0), reorder_level: Number(d.reorderLevel ?? 0),
      supplier: d.supplier ?? null, cost_per_unit: d.costPerUnit ?? null,
      updated_at: iso(d.updatedAt),
    }));
  },

  async movements(inventoryId?: string): Promise<InventoryMovement[]> {
    const org = await orgId();
    const clause = inventoryId ? where('inventoryId', '==', inventoryId) : where('orgId', '==', org);
    const snap = await getDocs(query(
      collection(fbStore(), COL.inventoryMovements), clause, orderBy('createdAt', 'desc'), fsLimit(100),
    ));
    return rows(snap, (id, d) => ({
      id, inventory_id: d.inventoryId, delta: Number(d.delta), kind: d.kind,
      note: d.note ?? null, created_by: d.createdBy ?? null,
      created_by_name: d.createdByName ?? undefined, created_at: iso(d.createdAt),
    }));
  },

  async addMovement(inventoryId: string, delta: number, kind: string, note: string, userId: string): Promise<void> {
    const org = await orgId();
    const session = await firebaseAuthApi.current();
    await addDoc(collection(fbStore(), COL.inventoryMovements), {
      orgId: org, inventoryId, delta, kind, note,
      createdBy: userId, createdByName: session?.profile.full_name ?? null,
      createdAt: serverTimestamp(),
    });
    const itemRef = doc(fbStore(), COL.inventory, inventoryId);
    const item = await getDoc(itemRef);
    const stock = Number(item.data()?.stock ?? 0);
    await updateDoc(itemRef, { stock: Math.max(0, stock + delta), updatedAt: serverTimestamp() });
  },

  // ---------------------------------------------------------- shift logs ---

  async shifts(siteId?: string): Promise<ShiftLog[]> {
    const org = await orgId();
    const clause = siteId ? where('siteId', '==', siteId) : where('orgId', '==', org);
    const snap = await getDocs(query(
      collection(fbStore(), COL.shiftLogs), clause, orderBy('shiftStart', 'desc'), fsLimit(50),
    ));
    return rows(snap, (id, d) => ({
      id, site_id: d.siteId, author: d.author ?? null, author_name: d.authorName ?? undefined,
      shift_start: iso(d.shiftStart), shift_end: d.shiftEnd ? iso(d.shiftEnd) : null,
      notes: d.notes ?? null, handover_to: d.handoverTo ?? null,
      handover_to_name: d.handoverToName ?? undefined, created_at: iso(d.createdAt),
    }));
  },

  async addShift(input: { siteId: string; notes: string; shiftStart: string; handoverTo: string | null; userId: string }): Promise<void> {
    const org = await orgId();
    const session = await firebaseAuthApi.current();
    const people = await firebaseApi.profiles();
    await addDoc(collection(fbStore(), COL.shiftLogs), {
      orgId: org, siteId: input.siteId,
      author: input.userId, authorName: session?.profile.full_name ?? null,
      shiftStart: Timestamp.fromDate(new Date(input.shiftStart)),
      shiftEnd: serverTimestamp(), notes: input.notes,
      handoverTo: input.handoverTo,
      handoverToName: people.find((p) => p.user_id === input.handoverTo)?.full_name ?? null,
      createdAt: serverTimestamp(),
    });
  },

  // -------------------------------------------------------- people, audit ---

  async profiles(): Promise<Profile[]> {
    const org = await orgId();
    const snap = await getDocs(query(collection(fbStore(), COL.profiles), where('orgId', '==', org)));
    return rows(snap, (id, d) => ({
      user_id: id, org_id: d.orgId, full_name: d.fullName,
      phone: d.phone ?? null, role: d.role ?? 'viewer', email: d.email ?? null,
    })).sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  async audit(opts: { table?: string; actor?: string; limit?: number } = {}): Promise<AuditRow[]> {
    const org = await orgId();
    const clauses = [where('orgId', '==', org)];
    if (opts.table) clauses.push(where('targetTable', '==', opts.table));
    if (opts.actor) clauses.push(where('actor', '==', opts.actor));
    const snap = await getDocs(query(
      collection(fbStore(), COL.auditLog), ...clauses, orderBy('ts', 'desc'), fsLimit(opts.limit ?? 200),
    ));
    return rows(snap, (id, d) => ({
      id, actor: d.actor ?? null, actor_name: d.actorName ?? undefined,
      action: d.action, target_table: d.targetTable, target_id: d.targetId ?? null,
      before: d.before ?? null, after: d.after ?? null, ts: iso(d.ts),
    }));
  },
};

/**
 * Live updates. The Realtime Database carries everything that changes by the
 * second, so one listener on `live/` covers the whole fleet; Firestore covers
 * records, which change once a batch.
 */
export function firebaseSubscribeLive(onChange: () => void): () => void {
  const stopLive = onValue(ref(fbRtdb(), 'live'), () => onChange());
  const stopCommands = onValue(ref(fbRtdb(), 'commands'), () => onChange());

  let stopAlarms = () => {};
  let stopBatches = () => {};

  orgId()
    .then((org) => {
      stopAlarms = onSnapshot(
        query(collection(fbStore(), COL.alarms), where('orgId', '==', org),
          orderBy('raisedAt', 'desc'), fsLimit(20)),
        () => onChange(),
        () => {/* a permissions blip must not kill the live view */},
      );
      stopBatches = onSnapshot(
        query(collection(fbStore(), COL.batches), where('orgId', '==', org),
          orderBy('startedAt', 'desc'), fsLimit(5)),
        () => onChange(),
        () => {},
      );
    })
    .catch(() => {/* not signed in yet */});

  return () => { stopLive(); stopCommands(); stopAlarms(); stopBatches(); };
}
