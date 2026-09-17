/**
 * The one data layer.
 *
 * Every page talks to this module and never to Supabase directly, so the same
 * UI runs against a live project or against the in-browser demo backend. The
 * shapes returned are identical in both.
 */

import { isDemo as supabaseUnconfigured, requireSupabase, supabase } from './supabase.ts';
import { isFirebase } from './firebase.ts';
import { firebaseApi, firebaseAuthApi, firebaseSubscribeLive } from './backend-firebase.ts';
import { DEMO_SITES, DEMO_USERS, demoStore } from './demo.ts';

/**
 * Which backend is in play.
 *
 * Firebase wins when it is configured, then Supabase, and demo mode is the
 * fallback so the dashboard always runs. Every page talks to `api` and never
 * knows which of the three answered.
 */
export const isDemo = supabaseUnconfigured && !isFirebase;
import type {
  Alarm, AuditRow, Batch, Command, DeviceConfig, DeviceEventRow, DutyCounters,
  FleetRow, InventoryItem, InventoryMovement, MaintenanceItem, MaintenanceLog,
  Profile, ShiftLog, Site, Telemetry, TreatmentCycle,
} from './types.ts';

const DEMO_SESSION_KEY = 'waterguard.demo.session';

function nowIso() { return new Date().toISOString(); }

// ============================================================ auth ==========

export interface Session {
  user_id: string;
  email: string;
  profile: Profile;
}

export const auth = {
  async current(): Promise<Session | null> {
    if (isFirebase) return firebaseAuthApi.current();
    if (isDemo) {
      try {
        const raw = localStorage.getItem(DEMO_SESSION_KEY);
        if (!raw) return null;
        const { user_id } = JSON.parse(raw);
        const u = DEMO_USERS.find((x) => x.user_id === user_id);
        return u ? { user_id: u.user_id, email: u.email!, profile: u } : null;
      } catch {
        return null;
      }
    }
    const db = requireSupabase();
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    const { data: profile } = await db.from('profiles').select('*').eq('user_id', data.user.id).maybeSingle();
    if (!profile) return null;
    return { user_id: data.user.id, email: data.user.email ?? '', profile: profile as Profile };
  },

  async signIn(email: string, password: string): Promise<Session> {
    if (isFirebase) return firebaseAuthApi.signIn(email, password);
    if (isDemo) {
      const u = DEMO_USERS.find((x) => x.email === email.trim().toLowerCase());
      if (!u || password !== u.password) throw new Error('That email and password do not match a demo account.');
      localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify({ user_id: u.user_id }));
      return { user_id: u.user_id, email: u.email!, profile: u };
    }
    const db = requireSupabase();
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const session = await auth.current();
    if (!session) throw new Error('Signed in, but this account has no profile. Ask an admin to add you.');
    return session;
  },

  async signOut() {
    if (isFirebase) return firebaseAuthApi.signOut();
    if (isDemo) { localStorage.removeItem(DEMO_SESSION_KEY); return; }
    await requireSupabase().auth.signOut();
  },
};

// ========================================================== reads ===========

export const api = {
  async sites(): Promise<Site[]> {
    if (isFirebase) return firebaseApi.sites();
    if (isDemo) return DEMO_SITES;
    const { data, error } = await requireSupabase().from('sites').select('*').order('name');
    if (error) throw error;
    return data as Site[];
  },

  async fleet(): Promise<FleetRow[]> {
    if (isFirebase) return firebaseApi.fleet();
    if (isDemo) return demoStore.fleet();
    const { data, error } = await requireSupabase().from('v_fleet').select('*').order('site_name');
    if (error) throw error;
    return data as FleetRow[];
  },

  async device(deviceId: string): Promise<FleetRow | null> {
    if (isFirebase) return firebaseApi.device(deviceId);
    const rows = await api.fleet();
    return rows.find((r) => r.device_id === deviceId) ?? null;
  },

  async telemetry(deviceId: string, minutes = 30): Promise<Telemetry[]> {
    if (isFirebase) return firebaseApi.telemetry(deviceId, minutes);
    if (isDemo) return demoStore.telemetryFor(deviceId, minutes);
    const { data, error } = await requireSupabase()
      .from('telemetry').select('*')
      .eq('device_id', deviceId)
      .gte('ts', new Date(Date.now() - minutes * 60_000).toISOString())
      .order('ts', { ascending: true });
    if (error) throw error;
    return data as Telemetry[];
  },

  /** Why V3 is refusing to open, in the firmware's words. */
  async v3Lock(deviceId: string): Promise<string | null> {
    if (isFirebase) return firebaseApi.v3Lock(deviceId);
    if (isDemo) return demoStore.v3Lock(deviceId);
    const { data } = await requireSupabase()
      .from('events').select('details')
      .eq('device_id', deviceId).eq('type', 'INTERLOCK_BLOCK')
      .order('ts', { ascending: false }).limit(1).maybeSingle();
    return (data?.details as Record<string, string>)?.reason ?? null;
  },

  async batches(opts: { deviceId?: string; from?: string; to?: string; limit?: number; result?: string } = {}): Promise<Batch[]> {
    if (isFirebase) return firebaseApi.batches(opts);
    if (isDemo) {
      let rows = demoStore.batches.slice();
      if (opts.deviceId) rows = rows.filter((b) => b.device_id === opts.deviceId);
      if (opts.from) rows = rows.filter((b) => b.started_at >= opts.from!);
      if (opts.to) rows = rows.filter((b) => b.started_at <= opts.to!);
      if (opts.result) rows = rows.filter((b) => b.result === opts.result);
      rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
      return rows.slice(0, opts.limit ?? 500);
    }
    let q = requireSupabase().from('batches').select('*').order('started_at', { ascending: false }).limit(opts.limit ?? 500);
    if (opts.deviceId) q = q.eq('device_id', opts.deviceId);
    if (opts.from) q = q.gte('started_at', opts.from);
    if (opts.to) q = q.lte('started_at', opts.to);
    if (opts.result) q = q.eq('result', opts.result);
    const { data, error } = await q;
    if (error) throw error;
    return data as Batch[];
  },

  async cycles(opts: { deviceId?: string; from?: string; to?: string } = {}): Promise<TreatmentCycle[]> {
    if (isFirebase) return firebaseApi.cycles(opts);
    if (isDemo) {
      let rows = demoStore.cycles.slice();
      if (opts.deviceId) rows = rows.filter((c) => c.device_id === opts.deviceId);
      if (opts.from) rows = rows.filter((c) => c.started_at >= opts.from!);
      if (opts.to) rows = rows.filter((c) => c.started_at <= opts.to!);
      return rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
    }
    let q = requireSupabase().from('treatment_cycles').select('*').order('started_at', { ascending: false }).limit(500);
    if (opts.deviceId) q = q.eq('device_id', opts.deviceId);
    if (opts.from) q = q.gte('started_at', opts.from);
    if (opts.to) q = q.lte('started_at', opts.to);
    const { data, error } = await q;
    if (error) throw error;
    return data as TreatmentCycle[];
  },

  async alarms(opts: { deviceId?: string; activeOnly?: boolean; severity?: string; from?: string } = {}): Promise<Alarm[]> {
    if (isFirebase) return firebaseApi.alarms(opts);
    const fleet = await api.fleet();
    const decorate = (a: Alarm): Alarm => {
      const d = fleet.find((f) => f.device_id === a.device_id);
      return { ...a, device_name: d?.device_name, site_name: d?.site_name };
    };

    if (isDemo) {
      let rows = demoStore.alarms.slice();
      if (opts.deviceId) rows = rows.filter((a) => a.device_id === opts.deviceId);
      if (opts.activeOnly) rows = rows.filter((a) => !a.cleared_at);
      if (opts.severity) rows = rows.filter((a) => a.severity === opts.severity);
      if (opts.from) rows = rows.filter((a) => a.raised_at >= opts.from!);
      return rows.sort((a, b) => b.raised_at.localeCompare(a.raised_at)).map(decorate);
    }

    let q = requireSupabase().from('alarms').select('*').order('raised_at', { ascending: false }).limit(400);
    if (opts.deviceId) q = q.eq('device_id', opts.deviceId);
    if (opts.activeOnly) q = q.is('cleared_at', null);
    if (opts.severity) q = q.eq('severity', opts.severity);
    if (opts.from) q = q.gte('raised_at', opts.from);
    const { data, error } = await q;
    if (error) throw error;
    return (data as Alarm[]).map(decorate);
  },

  async ackAlarm(id: string, note: string, userId: string): Promise<void> {
    if (isFirebase) return firebaseApi.ackAlarm(id, note, userId);
    if (isDemo) {
      const a = demoStore.alarms.find((x) => x.id === id);
      if (a) {
        a.acknowledged_at = nowIso();
        a.acknowledged_by = userId;
        a.ack_note = note || null;
        demoStore.audit.unshift({
          id: `au-${Date.now()}`, actor: userId,
          actor_name: DEMO_USERS.find((u) => u.user_id === userId)?.full_name,
          action: 'ACK', target_table: 'alarms', target_id: id,
          before: null, after: { note }, ts: nowIso(),
        });
      }
      return;
    }
    const { error } = await requireSupabase()
      .from('alarms')
      .update({ acknowledged_at: nowIso(), acknowledged_by: userId, ack_note: note || null })
      .eq('id', id);
    if (error) throw error;
  },

  async events(deviceId: string, limit = 100): Promise<DeviceEventRow[]> {
    if (isFirebase) return firebaseApi.events(deviceId, limit);
    if (isDemo) {
      return demoStore.events.filter((e) => e.device_id === deviceId)
        .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
    }
    const { data, error } = await requireSupabase()
      .from('events').select('*').eq('device_id', deviceId)
      .order('ts', { ascending: false }).limit(limit);
    if (error) throw error;
    return data as DeviceEventRow[];
  },

  // ------------------------------------------------------------ commands ---

  async commands(deviceId: string, limit = 25): Promise<Command[]> {
    if (isFirebase) return firebaseApi.commands(deviceId, limit);
    if (isDemo) {
      return demoStore.commands.filter((c) => c.device_id === deviceId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
    }
    const { data, error } = await requireSupabase()
      .from('commands').select('*').eq('device_id', deviceId)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data as Command[];
  },

  /**
   * Ask the device to do something. This only ever creates a request — the
   * firmware decides, and the answer comes back on the same row.
   */
  async sendCommand(deviceId: string, type: string, payload: Record<string, unknown>, userId: string): Promise<Command> {
    if (isFirebase) return firebaseApi.sendCommand(deviceId, type, payload, userId);
    const row: Command = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      device_id: deviceId, requested_by: userId,
      requested_by_name: DEMO_USERS.find((u) => u.user_id === userId)?.full_name,
      type, payload, status: 'pending', reason: null,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      resolved_at: null,
    };

    if (isDemo) { demoStore.commands.unshift(row); return row; }

    const { data, error } = await requireSupabase()
      .from('commands')
      .insert({ device_id: deviceId, type, payload, requested_by: userId, status: 'pending' })
      .select('*').single();
    if (error) throw error;
    return data as Command;
  },

  // -------------------------------------------------------------- config ---

  async configs(deviceId: string): Promise<DeviceConfig[]> {
    if (isFirebase) return firebaseApi.configs(deviceId);
    if (isDemo) {
      return demoStore.configs.filter((c) => c.device_id === deviceId)
        .sort((a, b) => b.version - a.version);
    }
    const { data, error } = await requireSupabase()
      .from('device_config').select('*').eq('device_id', deviceId)
      .order('version', { ascending: false });
    if (error) throw error;
    return data as DeviceConfig[];
  },

  async createConfig(deviceId: string, values: Partial<DeviceConfig>, reason: string, userId: string): Promise<DeviceConfig> {
    if (isFirebase) return firebaseApi.createConfig(deviceId, values, reason, userId);
    if (isDemo) {
      const latest = demoStore.configs.filter((c) => c.device_id === deviceId).sort((a, b) => b.version - a.version)[0];
      const row: DeviceConfig = {
        ...(latest as DeviceConfig), ...values,
        id: `cfg-${Date.now()}`, device_id: deviceId,
        version: (latest?.version ?? 0) + 1,
        reason, created_by: userId,
        created_by_name: DEMO_USERS.find((u) => u.user_id === userId)?.full_name,
        created_at: nowIso(), applied_at: null,
      };
      demoStore.configs.push(row);
      demoStore.audit.unshift({
        id: `au-${Date.now()}`, actor: userId,
        actor_name: row.created_by_name, action: 'INSERT',
        target_table: 'device_config', target_id: deviceId,
        before: latest ? { version: latest.version, ph_min: latest.ph_min, tds_max: latest.tds_max } : null,
        after: { version: row.version, ph_min: row.ph_min, tds_max: row.tds_max, reason },
        ts: nowIso(),
      });
      // the device confirms on its next poll
      setTimeout(() => { row.applied_at = nowIso(); }, 4000);
      return row;
    }

    const { data, error } = await requireSupabase()
      .from('device_config')
      .insert({ device_id: deviceId, ...values, reason, created_by: userId, version: 0 })
      .select('*').single();
    if (error) throw error;
    return data as DeviceConfig;
  },

  // --------------------------------------------------------- maintenance ---

  async maintenance(deviceId?: string): Promise<MaintenanceItem[]> {
    if (isFirebase) return firebaseApi.maintenance(deviceId);
    if (isDemo) {
      const rows = deviceId ? demoStore.maintenance.filter((m) => m.device_id === deviceId) : demoStore.maintenance;
      return rows.slice().sort((a, b) => (a.next_due_at ?? '').localeCompare(b.next_due_at ?? ''));
    }
    let q = requireSupabase().from('maintenance_items').select('*').order('next_due_at');
    if (deviceId) q = q.eq('device_id', deviceId);
    const { data, error } = await q;
    if (error) throw error;
    return data as MaintenanceItem[];
  },

  async maintenanceLogs(deviceId?: string): Promise<MaintenanceLog[]> {
    if (isFirebase) return firebaseApi.maintenanceLogs(deviceId);
    if (isDemo) {
      const rows = deviceId ? demoStore.maintenanceLogs.filter((m) => m.device_id === deviceId) : demoStore.maintenanceLogs;
      return rows.slice().sort((a, b) => b.performed_at.localeCompare(a.performed_at));
    }
    let q = requireSupabase().from('maintenance_logs').select('*').order('performed_at', { ascending: false }).limit(100);
    if (deviceId) q = q.eq('device_id', deviceId);
    const { data, error } = await q;
    if (error) throw error;
    return data as MaintenanceLog[];
  },

  async logMaintenance(input: {
    itemId: string | null; deviceId: string; notes: string;
    before: Record<string, unknown>; after: Record<string, unknown>; userId: string;
  }): Promise<void> {
    if (isFirebase) return firebaseApi.logMaintenance(input);
    if (isDemo) {
      demoStore.maintenanceLogs.unshift({
        id: `ml-${Date.now()}`, item_id: input.itemId, device_id: input.deviceId,
        performed_by: input.userId,
        performed_by_name: DEMO_USERS.find((u) => u.user_id === input.userId)?.full_name,
        performed_at: nowIso(), notes: input.notes,
        before_values: input.before, after_values: input.after,
      });
      const item = demoStore.maintenance.find((m) => m.id === input.itemId);
      if (item) {
        item.last_done_at = nowIso();
        item.next_due_at = new Date(Date.now() + (item.interval_days ?? 30) * 86400_000).toISOString();
      }
      return;
    }
    const { error } = await requireSupabase().from('maintenance_logs').insert({
      item_id: input.itemId, device_id: input.deviceId, performed_by: input.userId,
      notes: input.notes, before_values: input.before, after_values: input.after,
    });
    if (error) throw error;
  },

  async duty(deviceId: string): Promise<DutyCounters> {
    if (isFirebase) return firebaseApi.duty(deviceId);
    if (isDemo) {
      // Derived from telemetry in SQL; approximated here from what the demo has run.
      const t = demoStore.telemetryFor(deviceId, 24 * 60);
      let sump = 0, dosing = 0, v1 = 0, v2 = 0, v3 = 0;
      for (let n = 1; n < t.length; n++) {
        const dt = Math.min((Date.parse(t[n].ts) - Date.parse(t[n - 1].ts)) / 1000, 30);
        if (t[n].sump_pump) sump += dt;
        if (t[n].dosing_pump) dosing += dt;
        if (t[n].v1 && !t[n - 1].v1) v1 += 1;
        if (t[n].v2 && !t[n - 1].v2) v2 += 1;
        if (t[n].v3 && !t[n - 1].v3) v3 += 1;
      }
      const batches = demoStore.batches.filter((b) => b.device_id === deviceId).length;
      return {
        sump_run_hours: round2(sump / 3600 + batches * 0.0014),
        dosing_run_hours: round2(dosing / 3600 + batches * 0.0004),
        v1_cycles: v1 + demoStore.batches.filter((b) => b.device_id === deviceId && b.destination === 'RIVER').length,
        v2_cycles: v2 + demoStore.batches.filter((b) => b.device_id === deviceId && b.destination === 'TANK').length,
        v3_cycles: v3 + demoStore.cycles.filter((c) => c.device_id === deviceId && c.released_at).length,
      };
    }
    const { data, error } = await requireSupabase()
      .from('v_duty_counters').select('*').eq('device_id', deviceId).maybeSingle();
    if (error) throw error;
    return (data as DutyCounters) ?? { sump_run_hours: 0, dosing_run_hours: 0, v1_cycles: 0, v2_cycles: 0, v3_cycles: 0 };
  },

  // ----------------------------------------------------------- inventory ---

  async inventory(): Promise<InventoryItem[]> {
    if (isFirebase) return firebaseApi.inventory();
    if (isDemo) return demoStore.inventory;
    const { data, error } = await requireSupabase().from('inventory').select('*');
    if (error) throw error;
    return data as InventoryItem[];
  },

  async movements(inventoryId?: string): Promise<InventoryMovement[]> {
    if (isFirebase) return firebaseApi.movements(inventoryId);
    if (isDemo) {
      const rows = inventoryId ? demoStore.movements.filter((m) => m.inventory_id === inventoryId) : demoStore.movements;
      return rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    let q = requireSupabase().from('inventory_movements').select('*').order('created_at', { ascending: false }).limit(100);
    if (inventoryId) q = q.eq('inventory_id', inventoryId);
    const { data, error } = await q;
    if (error) throw error;
    return data as InventoryMovement[];
  },

  async addMovement(inventoryId: string, delta: number, kind: string, note: string, userId: string): Promise<void> {
    if (isFirebase) return firebaseApi.addMovement(inventoryId, delta, kind, note, userId);
    if (isDemo) {
      demoStore.movements.unshift({
        id: `mv-${Date.now()}`, inventory_id: inventoryId, delta, kind, note,
        created_by: userId, created_by_name: DEMO_USERS.find((u) => u.user_id === userId)?.full_name,
        created_at: nowIso(),
      });
      const item = demoStore.inventory.find((i) => i.id === inventoryId);
      if (item) { item.stock = Math.max(0, item.stock + delta); item.updated_at = nowIso(); }
      return;
    }
    const { error } = await requireSupabase()
      .from('inventory_movements')
      .insert({ inventory_id: inventoryId, delta, kind, note, created_by: userId });
    if (error) throw error;
  },

  // ---------------------------------------------------------- shift logs ---

  async shifts(siteId?: string): Promise<ShiftLog[]> {
    if (isFirebase) return firebaseApi.shifts(siteId);
    if (isDemo) {
      const rows = siteId ? demoStore.shifts.filter((s) => s.site_id === siteId) : demoStore.shifts;
      return rows.slice().sort((a, b) => b.shift_start.localeCompare(a.shift_start));
    }
    let q = requireSupabase().from('shift_logs').select('*').order('shift_start', { ascending: false }).limit(50);
    if (siteId) q = q.eq('site_id', siteId);
    const { data, error } = await q;
    if (error) throw error;
    return data as ShiftLog[];
  },

  async addShift(input: { siteId: string; notes: string; shiftStart: string; handoverTo: string | null; userId: string }): Promise<void> {
    if (isFirebase) return firebaseApi.addShift(input);
    if (isDemo) {
      demoStore.shifts.unshift({
        id: `sh-${Date.now()}`, site_id: input.siteId, author: input.userId,
        author_name: DEMO_USERS.find((u) => u.user_id === input.userId)?.full_name,
        shift_start: input.shiftStart, shift_end: nowIso(), notes: input.notes,
        handover_to: input.handoverTo,
        handover_to_name: DEMO_USERS.find((u) => u.user_id === input.handoverTo)?.full_name,
        created_at: nowIso(),
      });
      return;
    }
    const { error } = await requireSupabase().from('shift_logs').insert({
      site_id: input.siteId, author: input.userId, shift_start: input.shiftStart,
      shift_end: nowIso(), notes: input.notes, handover_to: input.handoverTo,
    });
    if (error) throw error;
  },

  // ---------------------------------------------------------- people, audit ---

  async profiles(): Promise<Profile[]> {
    if (isFirebase) return firebaseApi.profiles();
    if (isDemo) return DEMO_USERS;
    const { data, error } = await requireSupabase().from('profiles').select('*').order('full_name');
    if (error) throw error;
    return data as Profile[];
  },

  async audit(opts: { table?: string; actor?: string; limit?: number } = {}): Promise<AuditRow[]> {
    if (isFirebase) return firebaseApi.audit(opts);
    if (isDemo) {
      let rows = demoStore.audit.slice();
      if (opts.table) rows = rows.filter((r) => r.target_table === opts.table);
      if (opts.actor) rows = rows.filter((r) => r.actor === opts.actor);
      return rows.slice(0, opts.limit ?? 200);
    }
    let q = requireSupabase().from('audit_log').select('*').order('ts', { ascending: false }).limit(opts.limit ?? 200);
    if (opts.table) q = q.eq('target_table', opts.table);
    if (opts.actor) q = q.eq('actor', opts.actor);
    const { data, error } = await q;
    if (error) throw error;
    return data as AuditRow[];
  },
};

/**
 * Live updates. In demo mode the store ticks in this tab; against Supabase it
 * is a Realtime channel. Either way the caller just gets told to refetch.
 */
export function subscribeLive(onChange: () => void): () => void {
  if (isFirebase) return firebaseSubscribeLive(onChange);
  if (isDemo) return demoStore.subscribe(onChange);

  const db = supabase!;
  const channel = db
    .channel('waterguard-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'telemetry' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alarms' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'commands' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'batches' }, onChange)
    .subscribe();

  return () => { db.removeChannel(channel); };
}

function round2(n: number) { return Math.round(n * 100) / 100; }
