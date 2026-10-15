import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Minimal mail sender. Uses Resend's HTTP API when RESEND_API_KEY is set, so
 * no SMTP dependency is needed; otherwise it logs the message.
 *
 * The fallback is deliberate: a deployment without mail configured should still
 * let someone reset a password (the operator reads the link from the logs)
 * rather than silently dropping it and appearing to work.
 */
export async function sendMail({ to, subject, html, text }) {
  if (!config.resendApiKey) {
    logger.warn('No RESEND_API_KEY configured — email not sent, logging instead', { to, subject });
    logger.info(`EMAIL FALLBACK >>> ${subject}\n${text}`);
    return { delivered: false, reason: 'no-provider' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error('Email provider rejected the message', { status: res.status, detail: detail.slice(0, 200) });
      return { delivered: false, reason: `provider-${res.status}` };
    }
    logger.info('Email sent', { to, subject });
    return { delivered: true };
  } catch (err) {
    // Never let a mail outage take down the request that triggered it.
    logger.error('Email delivery failed', { err: err.message });
    return { delivered: false, reason: 'network' };
  }
}

/** Builds the absolute base URL for links in emails. */
export function baseUrl(req) {
  if (config.appUrl) return config.appUrl.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

export function resetEmail({ name, link, minutes }) {
  const safeName = String(name || 'there').replace(/[<>]/g, '');
  return {
    subject: 'Reset your FinTrack password',
    text: `Hi ${safeName},\n\nReset your FinTrack password with this link:\n${link}\n\n`
        + `The link expires in ${minutes} minutes and can only be used once.\n`
        + `If you did not ask for this, you can ignore this email — nothing has changed.\n`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f6fb;padding:28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <div style="font-size:22px;font-weight:800;margin-bottom:18px">💰 FinTrack</div>
    <p style="color:#0f172a;font-size:15px">Hi ${safeName},</p>
    <p style="color:#52637d;font-size:15px;line-height:1.6">Someone asked to reset the password on your FinTrack account. Use the button below to choose a new one.</p>
    <p style="margin:26px 0"><a href="${link}" style="background:#6366f1;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Reset my password</a></p>
    <p style="color:#94a3b8;font-size:13px;line-height:1.6">This link expires in ${minutes} minutes and works only once.<br>If you did not ask for this, ignore this email — nothing has changed.</p>
    <p style="color:#cbd5e1;font-size:12px;word-break:break-all;margin-top:18px">${link}</p>
  </div>
</body></html>`
  };
}
