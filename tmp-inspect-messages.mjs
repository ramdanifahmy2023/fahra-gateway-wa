import { createDatabasePool, loadEnvironment } from '@ocgw/shared';
const db=createDatabasePool(loadEnvironment());
try {
  const r=await db.query(`select id, remote_jid, direction, message_type, left(coalesce(text_body,''),120) text, processing_state,status,error,created_at, media_path, media from whatsapp_messages order by created_at desc limit 30`);
  console.table(r.rows.map(x=>({
    id:x.id, jid:x.remote_jid, dir:x.direction, type:x.message_type, text:x.text, state:x.processing_state, status:x.status, err:x.error, at:x.created_at, media_path:x.media_path, media:JSON.stringify(x.media).slice(0,160)
  })));
} finally { await db.end(); }
