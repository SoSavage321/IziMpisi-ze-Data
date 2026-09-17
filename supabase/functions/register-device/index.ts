/**
 * POST /register-device — mint a device API key.
 *
 * Called from Settings by an admin, with their own session JWT. The key is
 * generated here, hashed, and only the hash is stored; the plaintext is
 * returned exactly once, in this response, and can never be recovered. If it
 * is lost, the device is re-registered with a new key.
 *
 * Body: { site_id, name, hardware_revision?, flow_sensor?, device_id? }
 * Passing device_id rotates the key of an existing device instead.
 */

import { admin, fail, json, sha256Hex, CORS } from '../_shared/device-auth.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('POST only', 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('Sign in first', 401);

  // Identify the caller with their own token, so RLS and role checks apply to
  // them and not to the service role.
  const asUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );

  const { data: auth } = await asUser.auth.getUser();
  if (!auth?.user) return fail('Sign in first', 401);

  const { data: profile } = await asUser
    .from('profiles')
    .select('org_id, role')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!profile) return fail('No profile for this user', 403);
  if (profile.role !== 'admin') return fail('Only an admin can register a device', 403);

  let body: { site_id?: string; name?: string; hardware_revision?: string; flow_sensor?: boolean; device_id?: string };
  try {
    body = await req.json();
  } catch {
    return fail('Body is not valid JSON', 400);
  }

  const db = admin();

  // The site must belong to the caller's organisation.
  const siteId = body.site_id;
  if (!siteId) return fail('site_id is required', 400);

  const { data: site } = await db.from('sites').select('id, org_id, name').eq('id', siteId).maybeSingle();
  if (!site || site.org_id !== profile.org_id) return fail('That site is not in your organisation', 403);

  const key = `wg_live_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const hash = await sha256Hex(key);

  let deviceId = body.device_id ?? null;

  if (deviceId) {
    // Rotating an existing device's key.
    const { data: existing } = await db.from('devices').select('id, site_id').eq('id', deviceId).maybeSingle();
    if (!existing || existing.site_id !== siteId) return fail('That device is not at this site', 403);

    const { error } = await db.from('devices').update({ api_key_hash: hash }).eq('id', deviceId);
    if (error) return fail(`Could not rotate the key: ${error.message}`, 500);
  } else {
    const { data: created, error } = await db
      .from('devices')
      .insert({
        site_id: siteId,
        name: body.name ?? 'WaterGuard controller',
        hardware_revision: body.hardware_revision ?? null,
        flow_sensor: body.flow_sensor ?? false,
        api_key_hash: hash,
        status: 'never_seen',
      })
      .select('id')
      .single();

    if (error || !created) return fail(`Could not register the device: ${error?.message}`, 500);
    deviceId = created.id;

    // Ship it with a default configuration so it has something to run.
    await db.from('device_config').insert({
      device_id: deviceId,
      version: 1,
      reason: 'Initial configuration at registration',
      created_by: auth.user.id,
    });

    // And a calibration schedule, because a probe nobody calibrates is a probe
    // nobody can trust in a compliance report.
    await db.from('maintenance_items').insert([
      { device_id: deviceId, component: 'pH probe', task: 'calibrate', interval_days: 30, last_done_at: new Date().toISOString() },
      { device_id: deviceId, component: 'TDS probe', task: 'calibrate', interval_days: 90, last_done_at: new Date().toISOString() },
      { device_id: deviceId, component: 'Dosing pump', task: 'service', interval_days: 180, last_done_at: new Date().toISOString() },
    ]);
  }

  await db.from('audit_log').insert({
    actor: auth.user.id,
    action: body.device_id ? 'ROTATE_KEY' : 'REGISTER_DEVICE',
    target_table: 'devices',
    target_id: deviceId,
    after: { site_id: siteId, name: body.name ?? null },
  });

  return json({
    ok: true,
    device_id: deviceId,
    /** Shown once. Copy it into the firmware's config now. */
    api_key: key,
    warning: 'This key is shown once and cannot be recovered. Store it in the device now.',
  });
});
