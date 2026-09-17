/**
 * Alarm escalation. Run on a schedule (every minute):
 *
 *   select cron.schedule('escalate', '* * * * *', $$
 *     select net.http_post(
 *       url := 'https://YOUR-PROJECT.supabase.co/functions/v1/escalate',
 *       headers := '{"Authorization":"Bearer <service-role-key>"}'::jsonb
 *     ) $$);
 *
 * A critical alarm nobody has acknowledged within ten minutes goes up to the
 * site's admins. Escalating once is enough — the flag stops it becoming its
 * own nuisance alarm at 02:00.
 */

import { admin, fail, json, CORS } from '../_shared/device-auth.ts';
import { notify } from '../_shared/notify.ts';
import { shouldEscalate, ExistingAlarm } from '../_shared/lib/alarms.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Only the service role may run this; it is not a public endpoint.
  const auth = req.headers.get('authorization') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!serviceKey || auth !== `Bearer ${serviceKey}`) return fail('Forbidden', 403);

  const db = admin();
  const now = Date.now();

  const { data: open, error } = await db
    .from('alarms')
    .select('id, type, severity, message, raised_at, acknowledged_at, escalated, device_id')
    .is('cleared_at', null)
    .eq('severity', 'critical')
    .is('acknowledged_at', null)
    .eq('escalated', false);

  if (error) return fail(`Could not read alarms: ${error.message}`, 500);

  const due = (open ?? []).filter((a) => shouldEscalate(a as unknown as ExistingAlarm, now));
  const escalated: string[] = [];

  for (const alarm of due) {
    const { data: device } = await db
      .from('devices')
      .select('name, site_id, sites(name)')
      .eq('id', alarm.device_id)
      .maybeSingle();

    if (!device) continue;
    const siteName = (device as any).sites?.name ?? 'Site';
    const minutes = Math.round((now - Date.parse(alarm.raised_at)) / 60000);

    await notify(db, device.site_id, {
      severity: 'critical',
      site: siteName,
      device: device.name,
      title: `ESCALATED after ${minutes} min unacknowledged: ${alarm.message}`,
      body:
        `This critical alarm has been open for ${minutes} minutes with no acknowledgement.\n\n` +
        `${alarm.message}\n\n` +
        `The plant is still enforcing its interlocks, but nobody has taken ownership of this fault.`,
      url: (Deno.env.get('PUBLIC_APP_URL') ?? '') + '/alarms',
    });

    await db.from('alarms').update({ escalated: true, escalated_at: new Date().toISOString() }).eq('id', alarm.id);
    escalated.push(alarm.id);
  }

  return json({ ok: true, checked: open?.length ?? 0, escalated: escalated.length });
});
