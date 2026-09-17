/**
 * Notification providers.
 *
 * One interface, several channels. Email is implemented through Resend. SMS
 * and WhatsApp are deliberate stubs: on a mine site those are the channels
 * that actually reach a control-room operator at 02:00, so they are wired all
 * the way through to the call site and only the provider request is missing.
 *
 * Nothing here throws. A notification that cannot be sent must never take down
 * telemetry ingest — the plant is still running and its data still matters.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type Severity = 'info' | 'warning' | 'critical';

export interface Recipient {
  user_id: string;
  email: string | null;
  phone: string | null;
  full_name: string;
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
  min_severity: Severity;
}

export interface Notification {
  severity: Severity;
  site: string;
  device: string;
  title: string;
  body: string;
  /** Deep link into the dashboard, e.g. /alarms?id=... */
  url?: string;
}

export interface SendResult {
  channel: 'email' | 'sms' | 'whatsapp';
  to: string;
  ok: boolean;
  detail: string;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function wantsIt(r: Recipient, n: Notification): boolean {
  return RANK[n.severity] >= RANK[r.min_severity];
}

// --------------------------------------------------------------- email ---

export async function sendEmail(to: string, n: Notification): Promise<SendResult> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('ALARM_FROM_EMAIL') ?? 'waterguard@example.co.za';
  if (!key) return { channel: 'email', to, ok: false, detail: 'RESEND_API_KEY is not set' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `WaterGuard <${from}>`,
        to: [to],
        subject: `[${n.severity.toUpperCase()}] ${n.site} — ${n.title}`,
        html: emailHtml(n),
      }),
    });
    if (!res.ok) return { channel: 'email', to, ok: false, detail: `Resend ${res.status}: ${await res.text()}` };
    return { channel: 'email', to, ok: true, detail: 'sent' };
  } catch (e) {
    return { channel: 'email', to, ok: false, detail: String(e) };
  }
}

function emailHtml(n: Notification): string {
  const colour = n.severity === 'critical' ? '#d03b3b' : n.severity === 'warning' ? '#b8860b' : '#0d5f57';
  const link = n.url
    ? `<p style="margin:24px 0 0"><a href="${n.url}" style="background:${colour};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open the dashboard</a></p>`
    : '';
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#0d1413">
    <p style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${colour};font-weight:700;margin:0 0 4px">
      ${n.severity} alarm
    </p>
    <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(n.title)}</h1>
    <p style="margin:0 0 6px;color:#4d5956">${escapeHtml(n.site)} · ${escapeHtml(n.device)}</p>
    <p style="font-size:15px;line-height:1.5">${escapeHtml(n.body)}</p>
    ${link}
    <p style="font-size:12px;color:#7c8885;margin-top:28px;border-top:1px solid #dde3e1;padding-top:12px">
      WaterGuard — acid mine drainage test-before-release control.
      The plant keeps running and keeps enforcing its interlocks whether or not this email arrives.
    </p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ------------------------------------------------------- SMS / WhatsApp ---

/**
 * TODO: implement SMS. On a South African mine site the realistic options are
 * Clickatell, BulkSMS or Twilio; all three are a single authenticated POST.
 * Wire the credentials in as SMS_API_KEY / SMS_SENDER_ID and replace the body
 * of this function — the call site and the per-user preference already exist.
 */
export async function sendSms(to: string, n: Notification): Promise<SendResult> {
  const key = Deno.env.get('SMS_API_KEY');
  if (!key) {
    return { channel: 'sms', to, ok: false, detail: 'STUB: SMS provider not configured (set SMS_API_KEY)' };
  }
  console.log(`[sms-stub] would send to ${to}: ${n.title}`);
  return { channel: 'sms', to, ok: false, detail: 'STUB: provider call not implemented' };
}

/**
 * TODO: implement WhatsApp via the Meta Cloud API. Needs a verified business
 * number and pre-approved message templates — a critical alarm template with
 * {{site}}, {{device}} and {{message}} placeholders. Free-form replies are
 * only allowed inside a 24-hour window, so the template is not optional.
 */
export async function sendWhatsApp(to: string, n: Notification): Promise<SendResult> {
  const token = Deno.env.get('WHATSAPP_TOKEN');
  if (!token) {
    return { channel: 'whatsapp', to, ok: false, detail: 'STUB: WhatsApp not configured (set WHATSAPP_TOKEN)' };
  }
  console.log(`[whatsapp-stub] would send to ${to}: ${n.title}`);
  return { channel: 'whatsapp', to, ok: false, detail: 'STUB: provider call not implemented' };
}

// ------------------------------------------------------------ dispatch ---

/** Who should hear about an alarm at this site, and how they want it. */
export async function recipientsForSite(db: SupabaseClient, siteId: string): Promise<Recipient[]> {
  const { data: prefs } = await db
    .from('notification_prefs')
    .select('user_id, email, sms, whatsapp, min_severity')
    .eq('site_id', siteId);

  if (!prefs?.length) return [];

  const ids = prefs.map((p) => p.user_id);
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, full_name, phone')
    .in('user_id', ids);

  // auth.users holds the email; profiles holds the phone.
  const emails = new Map<string, string>();
  for (const id of ids) {
    const { data } = await db.auth.admin.getUserById(id);
    if (data?.user?.email) emails.set(id, data.user.email);
  }

  return prefs.map((p) => {
    const profile = profiles?.find((x) => x.user_id === p.user_id);
    return {
      user_id: p.user_id,
      email: emails.get(p.user_id) ?? null,
      phone: profile?.phone ?? null,
      full_name: profile?.full_name ?? 'Operator',
      channels: { email: p.email, sms: p.sms, whatsapp: p.whatsapp },
      min_severity: p.min_severity as Severity,
    };
  });
}

export async function notify(
  db: SupabaseClient,
  siteId: string,
  n: Notification,
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  let recipients: Recipient[] = [];

  try {
    recipients = await recipientsForSite(db, siteId);
  } catch (e) {
    console.error('could not load notification recipients', e);
    return results;
  }

  for (const r of recipients) {
    if (!wantsIt(r, n)) continue;
    if (r.channels.email && r.email) results.push(await sendEmail(r.email, n));
    if (r.channels.sms && r.phone) results.push(await sendSms(r.phone, n));
    if (r.channels.whatsapp && r.phone) results.push(await sendWhatsApp(r.phone, n));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.warn('notification failures', failed);
  return results;
}
