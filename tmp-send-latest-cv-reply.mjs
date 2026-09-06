import { createDatabasePool, loadEnvironment } from '@ocgw/shared';
const env = loadEnvironment();
const db = createDatabasePool(env);
try {
  const { rows } = await db.query(`
    SELECT remote_jid
    FROM whatsapp_messages
    WHERE direction='inbound'
      AND message_type IN ('image','document')
      AND processing_state='ignored'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const to = rows[0]?.remote_jid;
  if (!to) throw new Error('Tidak ada pesan CV ignored terbaru');
  const text = 'Halo, Kak. CV-nya sudah Neng fahra terima ya. Terima kasih sudah mengirimkan. Nanti akan dibantu teruskan untuk pengecekan tim HRD.';
  const response = await fetch(`${env.GATEWAY_INTERNAL_URL}/internal/messages/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': env.INTERNAL_API_KEY,
      'idempotency-key': `manual-cv-reply-20260810`,
      'x-request-id': `manual-cv-reply-${Date.now()}`,
    },
    body: JSON.stringify({ type: 'text', to, text }),
    redirect: 'error',
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`send HTTP ${response.status} ${body}`);
  console.log(`sent ${to}`);
} finally {
  await db.end();
}
