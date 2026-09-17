/**
 * Device authentication and shared helpers for the device-facing API.
 *
 * Devices do not have user accounts. Each carries a per-device API key,
 * presented as `x-device-key`. Only the sha256 of the key is stored, so a
 * leaked database dump does not let anyone impersonate a controller.
 *
 * These functions run with the service role and therefore bypass RLS. That is
 * deliberate and is the only place it happens: a device writes telemetry for
 * itself, and the key it presents decides which device_id that is. A device
 * can never write to another device's rows because the id comes from the key
 * lookup, never from the request body.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: message, ...extra }, status);
}

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AuthedDevice {
  id: string;
  name: string;
  site_id: string;
  flow_sensor: boolean;
  last_seen: string | null;
  config_version: number;
  firmware_version: string | null;
}

/**
 * Resolve the device from its API key. Returns null when the key is unknown —
 * callers must answer 401 without saying which part was wrong.
 */
export async function authenticateDevice(
  req: Request,
  db: SupabaseClient,
): Promise<AuthedDevice | null> {
  const key = req.headers.get('x-device-key');
  if (!key) return null;

  const hash = await sha256Hex(key);
  const { data, error } = await db
    .from('devices')
    .select('id, name, site_id, flow_sensor, last_seen, config_version, firmware_version')
    .eq('api_key_hash', hash)
    .maybeSingle();

  if (error || !data) return null;
  return data as AuthedDevice;
}

/** Config row -> the shape the controller and firmware use. */
export function toControllerConfig(row: Record<string, any>) {
  return {
    version: row.version,
    phMin: Number(row.ph_min),
    phMax: Number(row.ph_max),
    tdsMax: Number(row.tds_max),
    treatTargetPh: Number(row.treat_target_ph),
    testWindowS: Number(row.test_window_s),
    stableWindowS: Number(row.stable_window_s),
    batchL: Number(row.batch_l),
    tankCapL: Number(row.tank_cap_l),
    phWarnMax: Number(row.ph_warn_max),
    neutraliserLowPct: Number(row.neutraliser_low_pct),
  };
}

/** The active config for a device, falling back to the shipped defaults. */
export async function loadConfig(db: SupabaseClient, deviceId: string) {
  const { data } = await db
    .from('device_config')
    .select('*')
    .eq('device_id', deviceId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data ? toControllerConfig(data) : null;
}
