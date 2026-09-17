/**
 * Notification providers.
 *
 * One interface, several channels. Email is implemented through Resend. SMS
 * and WhatsApp are deliberate stubs: on a mine site those are the channels that
 * actually reach a control-room operator at 02:00, so they are wired all the
 * way through to the call site and only the provider request is missing.
 *
 * Nothing here throws. A notification that cannot be sent must never take down
 * the alarm engine — the plant is still running and its alarms still matter.
 *
 * Set the credentials with:
 *   firebase functions:secrets:set RESEND_API_KEY
 *   firebase functions:config:set alarm.from="waterguard@yourdomain.co.za"
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Notification {
  severity: Severity;
  site: string;
  device: string;
  title: string;
  body: string;
  /** Deep link into the dashboard. */
  url?: string;
}

export interface SendResult {
  channel: 'email' | 'sms' | 'whatsapp';
  to: string;
  ok: boolean;
  detail: string;
}

// --------------------------------------------------------------- email ---

export async function sendEmail(to: string, n: Notification): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ALARM_FROM_EMAIL ?? 'waterguard@example.co.za';
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
    if (!res.ok) {
      return { channel: 'email', to, ok: false, detail: `Resend ${res.status}: ${await res.text()}` };
    }
    return { channel: 'email', to, ok: true, detail: 'sent' };
  } catch (e) {
    return { channel: 'email', to, ok: false, detail: String(e) };
  }
}

function emailHtml(n: Notification): string {
  const colour = n.severity === 'critical' ? '#DC2626'
    : n.severity === 'warning' ? '#B45309' : '#087EA4';
  const link = n.url
    ? `<p style="margin:24px 0 0"><a href="${n.url}" style="background:${colour};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open the dashboard</a></p>`
    : '';
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#172B3A">
    <p style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${colour};font-weight:700;margin:0 0 4px">
      ${n.severity} alarm
    </p>
    <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(n.title)}</h1>
    <p style="margin:0 0 6px;color:#4A6076">${escapeHtml(n.site)} · ${escapeHtml(n.device)}</p>
    <p style="font-size:15px;line-height:1.5">${escapeHtml(n.body)}</p>
    ${link}
    <p style="font-size:12px;color:#7C93A6;margin-top:28px;border-top:1px solid #DBE7EE;padding-top:12px">
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
 * Set SMS_API_KEY / SMS_SENDER_ID and replace the body of this function — the
 * call site and the per-user preference already exist.
 */
export async function sendSms(to: string, n: Notification): Promise<SendResult> {
  if (!process.env.SMS_API_KEY) {
    return { channel: 'sms', to, ok: false, detail: 'STUB: SMS provider not configured' };
  }
  console.log(`[sms-stub] would send to ${to}: ${n.title}`);
  return { channel: 'sms', to, ok: false, detail: 'STUB: provider call not implemented' };
}

/**
 * TODO: implement WhatsApp via the Meta Cloud API. Needs a verified business
 * number and pre-approved message templates — a critical alarm template with
 * {{site}}, {{device}} and {{message}} placeholders. Free-form replies are only
 * allowed inside a 24-hour window, so the template is not optional.
 */
export async function sendWhatsApp(to: string, n: Notification): Promise<SendResult> {
  if (!process.env.WHATSAPP_TOKEN) {
    return { channel: 'whatsapp', to, ok: false, detail: 'STUB: WhatsApp not configured' };
  }
  console.log(`[whatsapp-stub] would send to ${to}: ${n.title}`);
  return { channel: 'whatsapp', to, ok: false, detail: 'STUB: provider call not implemented' };
}
