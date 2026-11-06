const { createHash } = require('node:crypto');
const nodemailer = require('nodemailer');

function gmailCredentials(env) {
  return { user: (env.GMAIL_USER || '').trim().toLowerCase(),
    pass: (env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '') };
}

function getMailProvider(env = process.env) {
  const requested = (env.MAIL_PROVIDER || '').trim().toLowerCase();
  if ((!requested || requested === 'resend') && env.RESEND_API_KEY && env.MAIL_FROM) return 'resend';
  const gmail = gmailCredentials(env);
  if ((!requested || requested === 'gmail') && /^[a-z0-9.]+@gmail\.com$/.test(gmail.user) && /^[a-z]{16}$/i.test(gmail.pass)) return 'gmail';
  return null;
}

function createMailSender({ env = process.env, fetchImpl = fetch, createTransport = nodemailer.createTransport } = {}) {
  const provider = getMailProvider(env);
  let transport;
  return async function send({ to, subject, text, headers, idempotencyKey }) {
    if (!provider) throw Object.assign(new Error('MAIL_DISABLED'), { permanent: true });
    if (provider === 'resend') {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, headers })
      });
      if (!response.ok) throw Object.assign(new Error('MAIL_SEND_FAILED'), { statusCode: response.status });
      return;
    }
    try {
      const auth = gmailCredentials(env);
      transport ||= createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, dnsTimeout: 10000,
        disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
      await transport.sendMail({ from: { name: 'Finalyze.AI', address: auth.user }, to: { address: to }, subject, text, headers,
        messageId: `<finalyze-${createHash('sha256').update(idempotencyKey).digest('hex')}@finalyze-ai.vercel.app>` });
    } catch (error) {
      // SMTP errors can contain recipient addresses or authentication details.
      throw Object.assign(new Error('MAIL_SEND_FAILED'), {
        ...(Number.isInteger(error.responseCode) ? { statusCode: error.responseCode } : {})
      });
    }
  };
}

module.exports = { getMailProvider, createMailSender };
