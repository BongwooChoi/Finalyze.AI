const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { getMailProvider, createMailSender } = require('../mailSender');
const { accountConfig } = require('../accountRoutes');
const { createSenders } = require('../disclosureNotifications');
const { seal } = require('../accountSecurity');

const gmail = { GMAIL_USER: 'finalyze.test@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
const message = { to: 'member@gmail.com', subject: '새 실적 공시', text: '공시 보기: https://finalyze-ai.vercel.app/',
  headers: { 'List-Unsubscribe': '<https://finalyze-ai.vercel.app/unsubscribe/test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  idempotencyKey: 'delivery-1' };

test('mail stays disabled until the selected provider is fully configured', () => {
  assert.equal(getMailProvider({}), null);
  assert.equal(getMailProvider({ ...gmail, GMAIL_APP_PASSWORD: '' }), null);
  assert.equal(getMailProvider({ ...gmail, GMAIL_USER: 'sender@example.com' }), null);
  assert.equal(getMailProvider({ ...gmail, MAIL_PROVIDER: 'resend' }), null);
  assert.equal(getMailProvider({ ...gmail, MAIL_PROVIDER: 'unknown' }), null);
  assert.equal(accountConfig(gmail).mailAvailable, true);
  assert.equal(accountConfig({ GMAIL_USER: gmail.GMAIL_USER }).mailAvailable, false);
  assert.equal(getMailProvider({ ...gmail, RESEND_API_KEY: 'test', MAIL_FROM: 'sender@example.com' }), 'resend');
  assert.equal(getMailProvider({ ...gmail, MAIL_PROVIDER: 'gmail', RESEND_API_KEY: 'test', MAIL_FROM: 'sender@example.com' }), 'gmail');
});

test('Gmail sends through TLS with the authenticated sender and keeps unsubscribe headers', async () => {
  let options, created = 0;
  const sent = [];
  const send = createMailSender({ env: { ...gmail, MAIL_FROM: 'ignored@example.com' },
    fetchImpl: () => assert.fail('Gmail must not call Resend'),
    createTransport: value => { options = value; created++; return { sendMail: async mail => { sent.push(mail); } }; } });
  await send(message);
  await send(message);
  await send({ ...message, idempotencyKey: 'delivery-2' });
  assert.equal(created, 1);
  assert.equal(options.host, 'smtp.gmail.com');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.deepEqual(options.auth, { user: gmail.GMAIL_USER, pass: 'abcdefghijklmnop' });
  assert.equal(options.debug, false);
  assert.equal(options.logger, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.ok(options.connectionTimeout <= 10000 && options.socketTimeout <= 20000);
  assert.deepEqual(sent[0].from, { name: 'Finalyze.AI', address: gmail.GMAIL_USER });
  assert.deepEqual(sent[0].to, { address: message.to });
  assert.deepEqual(sent[0].headers, message.headers);
  assert.equal(sent[0].text, message.text);
  assert.equal(sent[0].messageId, sent[1].messageId);
  assert.notEqual(sent[0].messageId, sent[2].messageId);
});

test('disabled mail never attempts delivery, and SMTP failures do not expose account details', async () => {
  const disabled = createMailSender({ env: {}, fetchImpl: () => assert.fail(), createTransport: () => assert.fail() });
  await assert.rejects(disabled(message), error => error.message === 'MAIL_DISABLED' && error.permanent);
  const send = createMailSender({ env: gmail, createTransport: () => ({ sendMail: async () => {
    throw Object.assign(new Error(`Authentication rejected for ${gmail.GMAIL_USER}: ${gmail.GMAIL_APP_PASSWORD}`), { responseCode: 535 });
  } }) });
  await assert.rejects(send(message), error => {
    assert.equal(error.message, 'MAIL_SEND_FAILED');
    assert.equal(error.statusCode, 535);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /finalyze\.test|abcd|member@gmail/);
    return true;
  });
});

test('Resend retains provider idempotency and never retries through Gmail after a provider failure', async () => {
  let request;
  const send = createMailSender({ env: { ...gmail, RESEND_API_KEY: 'test-key', MAIL_FROM: 'Finalyze.AI <alerts@example.com>' },
    fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: false, status: 429 }; },
    createTransport: () => assert.fail('Do not send a second copy through Gmail') });
  await assert.rejects(send(message), error => error.message === 'MAIL_SEND_FAILED' && error.statusCode === 429);
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.headers['Idempotency-Key'], message.idempotencyKey);
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.body), { from: 'Finalyze.AI <alerts@example.com>', to: [message.to],
    subject: message.subject, text: message.text, headers: message.headers });
});

test('disclosure emails preserve company deep links, consent-scoped unsubscribe, and encrypted recipients', async () => {
  const dataKey = crypto.randomBytes(32).toString('base64');
  let body;
  const senders = createSenders({ config: { mailAvailable: true, dataKey, origin: 'https://finalyze-ai.vercel.app' },
    env: { RESEND_API_KEY: 'test-key', MAIL_FROM: 'alerts@example.com' },
    unsubscribeToken: (id, since) => { assert.equal(id, 'user-1'); assert.equal(since, 123); return 'signed-token'; },
    fetchImpl: async (_, options) => { body = JSON.parse(options.body); return { ok: true }; } });
  await senders.email({ email_enc: seal('member@gmail.com', dataKey), email_since: 123, corp_code: '00126380',
    corp_name: '삼성전자', receipt: '20261106000001', report_name: '분기보고서 (2026.09)', receipt_date: '20261106' },
  { user_id: 'user-1', id: 'delivery-1' });
  assert.deepEqual(body.to, ['member@gmail.com']);
  assert.match(body.subject, /삼성전자 새 실적 공시/);
  assert.match(body.text, /corp=00126380/);
  assert.match(body.text, /rcept=20261106000001/);
  assert.match(body.text, /이메일 알림 끄기: https:\/\/finalyze-ai.vercel.app\/api\/notifications\/unsubscribe\/signed-token/);
  assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});
