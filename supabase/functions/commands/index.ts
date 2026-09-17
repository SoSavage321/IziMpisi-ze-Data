/**
 * The command channel.
 *
 *   GET  /commands      — the device polls every 2 s for pending work
 *   POST /commands/ack  — the device reports accepted / rejected + reason
 *
 * The dashboard only ever inserts a row into `commands`. It cannot open a
 * valve, and nothing in this function decides whether a command is safe: that
 * judgement belongs to the firmware, which holds the interlocks and the real
 * sensor readings. This endpoint is a queue with an expiry clock.
 *
 * Commands expire 30 s after they are created. A device that was offline must
 * not wake up and execute a stale emergency instruction from ten minutes ago.
 */

import { admin, authenticateDevice, fail, json, CORS } from '../_shared/device-auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const db = admin();
  const device = await authenticateDevice(req, db);
  if (!device) return fail('Unknown or missing device key', 401);

  const url = new URL(req.url);
  const isAck = url.pathname.endsWith('/ack');

  if (req.method === 'POST' && isAck) return handleAck(req, db, device);
  if (req.method === 'GET') return handlePoll(db, device);
  return fail('Use GET /commands or POST /commands/ack', 405);
});

async function handlePoll(db: ReturnType<typeof admin>, device: { id: string; config_version: number }) {
  const nowIso = new Date().toISOString();

  // Expire anything the device never picked up, so it is never handed a stale
  // instruction and the dashboard shows an honest outcome.
  await db
    .from('commands')
    .update({
      status: 'expired',
      reason: 'No acknowledgement from the device within 30 s',
      resolved_at: nowIso,
    })
    .eq('device_id', device.id)
    .eq('status', 'pending')
    .lt('expires_at', nowIso);

  const { data: pending, error } = await db
    .from('commands')
    .select('id, type, payload, created_at, expires_at')
    .eq('device_id', device.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) return fail(`Could not read commands: ${error.message}`, 500);

  // The config the device should be running, so a poll doubles as a config
  // check without a second round trip.
  const { data: config } = await db
    .from('device_config')
    .select('*')
    .eq('device_id', device.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  return json({
    ok: true,
    server_time: nowIso,
    config_version: config?.version ?? device.config_version,
    config: config
      ? {
          version: config.version,
          ph_min: Number(config.ph_min),
          ph_max: Number(config.ph_max),
          tds_max: config.tds_max,
          treat_target_ph: Number(config.treat_target_ph),
          test_window_s: config.test_window_s,
          stable_window_s: config.stable_window_s,
          batch_l: config.batch_l,
          tank_cap_l: config.tank_cap_l,
          ph_warn_max: Number(config.ph_warn_max),
          neutraliser_low_pct: config.neutraliser_low_pct,
        }
      : null,
    commands: pending ?? [],
  });
}

async function handleAck(req: Request, db: ReturnType<typeof admin>, device: { id: string }) {
  let body: { acks?: Array<{ id: string; accepted: boolean; reason: string }> };
  try {
    body = await req.json();
  } catch {
    return fail('Body is not valid JSON', 400);
  }

  const acks = body.acks ?? [];
  if (!Array.isArray(acks) || acks.length === 0) return fail('No acknowledgements in the body', 400);

  const nowIso = new Date().toISOString();
  let applied = 0;

  for (const ack of acks) {
    if (!ack?.id || typeof ack.accepted !== 'boolean') continue;
    const { error, count } = await db
      .from('commands')
      .update(
        {
          status: ack.accepted ? 'accepted' : 'rejected',
          // The firmware's own words, shown to the operator verbatim.
          reason: String(ack.reason ?? '').slice(0, 500),
          resolved_at: nowIso,
        },
        { count: 'exact' },
      )
      .eq('id', ack.id)
      .eq('device_id', device.id)
      .eq('status', 'pending');

    if (!error && count) applied += count;
  }

  return json({ ok: true, applied, of: acks.length });
}
