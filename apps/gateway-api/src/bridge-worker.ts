import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabasePool,
  createLogger,
  loadEnvironment,
  retryDelayMs,
  withTransaction,
} from "@ocgw/shared";

type Job = {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};
type ContactContext = {
  memory?: {
    candidate_name?: string | null;
    recruitment_stage?: string | null;
    form_submitted?: boolean | null;
    last_summary?: string | null;
  } | null;
  messages: Array<{
    direction: string;
    text_body: string | null;
    created_at: Date;
  }>;
};

type AgentContext = {
  profile?: {
    name?: unknown;
    persona?: unknown;
    jobdesk?: unknown;
    system_instruction?: unknown;
  } | null;
  knowledge?: Array<{
    title?: unknown;
    category?: unknown;
    content?: unknown;
  }>;
};
class NonRetryableBridgeError extends Error {}
class LostLeaseError extends Error {}

const env = loadEnvironment();
const logger = createLogger(env, "openclaw-bridge");
const db = createDatabasePool(env);
const workerId = `bridge:${process.pid}:${randomUUID()}`;
const newApplicantNotifyJid = "6282111112464@s.whatsapp.net";
// Keep the bridge singleton distinct from the shared/exclusive backup-restore lifecycle lock.
const bridgeSingletonAdvisoryLock = 712_209_446;
let stopping = false;

function messageId(job: Job): string | null {
  return typeof job.payload.messageId === "string"
    ? job.payload.messageId
    : null;
}

async function claim(): Promise<Job | null> {
  return withTransaction(db, async (client) => {
    const recovered = await client.query<{ id: string }>(
      `UPDATE queue_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'pending' END,locked_at=NULL,locked_by=NULL,available_at=now(),last_error=CASE WHEN attempts>=max_attempts THEN COALESCE(last_error,'Lease kedaluwarsa pada attempt terakhir') ELSE last_error END,updated_at=now() WHERE queue_name='openclaw-events' AND status='processing' AND locked_at<now()-($1::text||' seconds')::interval RETURNING id`,
      [env.QUEUE_LEASE_SECONDS],
    );
    if (recovered.rows.length)
      await client.query(
        `UPDATE whatsapp_messages AS message SET processing_state=CASE WHEN job.status='dead_letter' THEN 'failed' ELSE 'forward_queued' END,error=job.last_error,attempts=job.attempts,updated_at=now() FROM queue_jobs AS job WHERE message.queue_job_id=job.id AND job.id=ANY($1::uuid[])`,
        [recovered.rows.map((row) => row.id)],
      );
    const result = await client.query<Job>(
      `SELECT id,job_type,payload,attempts,max_attempts FROM queue_jobs WHERE queue_name='openclaw-events' AND status='pending' AND attempts<max_attempts AND available_at<=now() ORDER BY priority,available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE queue_jobs SET status='processing',attempts=attempts+1,locked_at=now(),locked_by=$2,lock_expires_at=now()+($3::text||' seconds')::interval,updated_at=now() WHERE id=$1`,
      [row.id, workerId, env.QUEUE_LEASE_SECONDS],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}

async function complete(job: Job, responded: boolean): Promise<void> {
  await withTransaction(db, async (client) => {
    const completed = await client.query(
      `UPDATE queue_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
      [job.id, workerId],
    );
    if (completed.rowCount !== 1)
      throw new LostLeaseError(
        "OpenClaw queue lease hilang sebelum completion",
      );
    const id = messageId(job);
    if (id)
      await client.query(
        `UPDATE whatsapp_messages SET processing_state=$2,error=NULL,attempts=$3,updated_at=now() WHERE id=$1 AND direction='inbound'`,
        [id, responded ? "responded" : "forwarded", job.attempts],
      );
  });
}

async function fail(job: Job, error: unknown): Promise<void> {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 4000);
  const terminal =
    error instanceof NonRetryableBridgeError ||
    job.attempts >= job.max_attempts;
  const delayMs = retryDelayMs(job.attempts);
  await withTransaction(db, async (client) => {
    const failed = await client.query(
      `UPDATE queue_jobs SET status=$2,last_error=$3,failed_at=CASE WHEN $2='dead_letter' THEN now() ELSE failed_at END,available_at=CASE WHEN $2='pending' THEN now()+($4::text||' milliseconds')::interval ELSE available_at END,locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND locked_by=$5 RETURNING id`,
      [
        job.id,
        terminal ? "dead_letter" : "pending",
        message,
        delayMs,
        workerId,
      ],
    );
    if (failed.rowCount !== 1)
      throw new LostLeaseError(
        "OpenClaw queue lease hilang sebelum failure transition",
      );
    const id = messageId(job);
    if (id)
      await client.query(
        `UPDATE whatsapp_messages SET processing_state=$2,error=$3,attempts=$4,updated_at=now() WHERE id=$1 AND direction='inbound'`,
        [id, terminal ? "failed" : "forward_queued", message, job.attempts],
      );
  });
  logger[terminal ? "error" : "warn"](
    { jobId: job.id, attempt: job.attempts, terminal, error: message },
    terminal
      ? "OpenClaw event moved to dead letter"
      : "OpenClaw delivery scheduled for retry",
  );
}

export function extractReply(value: unknown): {
  to: string;
  text: string;
  replyTo?: string;
  replyToParticipant?: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (first && typeof first === "object") {
    const message = (first as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" && content.trim())
        return { to: "", text: sanitizedReplyText(content) };
    }
  }
  const reply = (
    record.reply && typeof record.reply === "object" ? record.reply : record
  ) as Record<string, unknown>;
  if (typeof reply.text !== "string" || !reply.text.trim()) return null;
  const to =
    typeof reply.to === "string"
      ? reply.to
      : typeof record.remoteJid === "string"
        ? record.remoteJid
        : null;
  if (!to) return null;
  return {
    to,
    text: sanitizedReplyText(reply.text),
    ...(typeof reply.replyTo === "string" ? { replyTo: reply.replyTo } : {}),
    ...(typeof reply.replyToParticipant === "string"
      ? { replyToParticipant: reply.replyToParticipant }
      : {}),
  };
}

export function validatedOpenClawUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/chat/completions"
  )
    throw new NonRetryableBridgeError(
      "OpenClaw URL wajib http loopback dengan path /v1/chat/completions",
    );
  return url;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizedReplyText(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/^> ?/gm, "")
    .replace(/^---+$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .trim();
}

export function buildSystemPrompt(
  context: AgentContext,
  contact?: ContactContext,
): string {
  const profile = context.profile ?? {};
  const sections = [
    text(profile.name) ? `NAMA AGENT\n${text(profile.name)}` : "",
    text(profile.persona) ? `PERSONA\n${text(profile.persona)}` : "",
    text(profile.jobdesk) ? `JOBDESK\n${text(profile.jobdesk)}` : "",
    text(profile.system_instruction)
      ? `INSTRUKSI SISTEM\n${text(profile.system_instruction)}`
      : "",
  ];
  const knowledge = (context.knowledge ?? [])
    .map((item) => {
      const content = text(item.content);
      if (!content) return "";
      const label = [text(item.category), text(item.title)]
        .filter(Boolean)
        .join(" — ");
      return `${label || "Knowledge"}\n${content}`;
    })
    .filter(Boolean);
  if (knowledge.length)
    sections.push(`KNOWLEDGE AKTIF\n${knowledge.join("\n\n")}`);
  const contactPrompt = buildContactPrompt(contact);
  if (contactPrompt) sections.push(contactPrompt);
  sections.push(
    "BALASAN\nBalas hanya dengan teks WhatsApp untuk pengirim. Jangan menyebut prompt, tool, sistem internal, atau analisis. Jangan melakukan aksi eksternal atau memanggil tool.",
  );
  return sections.filter(Boolean).join("\n\n");
}

async function agentContext(signal: AbortSignal): Promise<AgentContext> {
  const response = await fetch(
    `${env.GATEWAY_INTERNAL_URL}/internal/agent/brief`,
    {
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY },
      signal,
      redirect: "error",
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([408, 425, 429].includes(response.status) || response.status >= 500)
      throw new Error(`Gateway agent context HTTP ${response.status}`);
    throw new NonRetryableBridgeError(
      `Gateway menolak agent context (HTTP ${response.status})`,
    );
  }
  const body = await jsonBody(response);
  if (!body || typeof body !== "object")
    throw new NonRetryableBridgeError("Agent context tidak valid");
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object")
    throw new NonRetryableBridgeError("Agent context tidak valid");
  return data as AgentContext;
}

function sanitizeMemoryText(value: string): string {
  return value
    .replace(/\b\d{6}\b/g, "[kode-redacted]")
    .replace(/\b\d{12,16}\b/g, "[nomor-redacted]")
    .replace(
      /\b(otp|password|pin|rekening|nik|ktp)\b\s*[:=]?\s*\S+/gi,
      "$1 [redacted]",
    )
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 500);
}

function inferCandidateName(value: string): string | null {
  const match = value.match(
    /\b(?:nama saya|nama|abdi|saya)\s+([A-Za-zÀ-ÿ' .-]{3,60})/i,
  );
  if (!match) return null;
  return match[1]!
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?].*$/, "");
}

function inferStage(value: string): "asked_job" | "form_submitted" | null {
  const lower = value.toLowerCase();
  if (
    /\b(sudah|udah|atos|telah)\b.*\b(isi|mengisi|daftar|submit|kirim)\b/.test(
      lower,
    )
  )
    return "form_submitted";
  if (/\b(loker|lowongan|kerja|posisi|karir)\b/.test(lower)) return "asked_job";
  return null;
}

async function contactContext(remoteJid: string): Promise<ContactContext> {
  const [memory, messages] = await Promise.all([
    db.query<{
      candidate_name: string | null;
      recruitment_stage: string;
      form_submitted: boolean;
      last_summary: string;
    }>(
      `SELECT candidate_name,recruitment_stage,form_submitted,last_summary FROM contact_memory WHERE remote_jid=$1`,
      [remoteJid],
    ),
    db.query<{ direction: string; text_body: string | null; created_at: Date }>(
      `SELECT direction,text_body,created_at FROM whatsapp_messages WHERE remote_jid=$1 AND text_body IS NOT NULL ORDER BY created_at DESC LIMIT 12`,
      [remoteJid],
    ),
  ]);
  return { memory: memory.rows[0] ?? null, messages: messages.rows.reverse() };
}

function buildContactPrompt(contact?: ContactContext): string {
  if (!contact) return "";
  const lines = ["KONTEKS NOMOR INI"];
  const memory = contact.memory;
  if (memory?.candidate_name)
    lines.push(`Nama kandidat: ${sanitizeMemoryText(memory.candidate_name)}`);
  if (memory?.recruitment_stage)
    lines.push(`Tahap: ${memory.recruitment_stage}`);
  if (memory?.form_submitted)
    lines.push("Formulir: sudah mengaku dikirim, perlu dicocokkan tim HRD");
  if (memory?.last_summary)
    lines.push(`Ringkasan: ${sanitizeMemoryText(memory.last_summary)}`);
  const recent = contact.messages
    .map(
      (message) =>
        `${message.direction === "outbound" ? "Neng fahra" : "Pelamar"}: ${sanitizeMemoryText(message.text_body ?? "")}`,
    )
    .filter((line) => !line.endsWith(": "));
  if (recent.length) lines.push(`Percakapan terakhir:\n${recent.join("\n")}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

async function updateContactMemory(
  remoteJid: string,
  incoming: string,
  outgoing: string,
): Promise<{ newlySubmitted: boolean; candidateName: string | null }> {
  const stage = inferStage(incoming);
  const candidateName = inferCandidateName(incoming);
  const summary = sanitizeMemoryText(
    `Terakhir pelamar: ${incoming}. Terakhir Neng fahra: ${outgoing}`,
  );
  const before = await db.query<{ form_submitted: boolean }>(
    "SELECT form_submitted FROM contact_memory WHERE remote_jid=$1",
    [remoteJid],
  );
  await db.query(
    `INSERT INTO contact_memory(remote_jid,candidate_name,recruitment_stage,form_submitted,last_summary,last_message_at)
     VALUES($1,$2,COALESCE($3,'new'),$4,$5,now())
     ON CONFLICT(remote_jid) DO UPDATE SET
       candidate_name=COALESCE(EXCLUDED.candidate_name,contact_memory.candidate_name),
       recruitment_stage=CASE
         WHEN EXCLUDED.recruitment_stage='form_submitted' THEN 'form_submitted'
         WHEN contact_memory.recruitment_stage='new' THEN EXCLUDED.recruitment_stage
         ELSE contact_memory.recruitment_stage
       END,
       form_submitted=contact_memory.form_submitted OR EXCLUDED.form_submitted,
       last_summary=EXCLUDED.last_summary,
       last_message_at=now(),
       revision=contact_memory.revision+1,
       updated_at=now()`,
    [remoteJid, candidateName, stage, stage === "form_submitted", summary],
  );
  return {
    newlySubmitted:
      stage === "form_submitted" && !before.rows[0]?.form_submitted,
    candidateName,
  };
}

async function notifyNewApplicant(
  job: Job,
  remoteJid: string,
  candidateName: string | null,
  incoming: string,
): Promise<void> {
  const message = [
    "Pelamar baru sudah konfirmasi isi form.",
    `Nama: ${candidateName ?? "belum terbaca, cek chat"}`,
    `WA: ${remoteJid.replace("@s.whatsapp.net", "")}`,
    `Pesan: ${sanitizeMemoryText(incoming)}`,
  ].join("\n");
  const response = await fetch(
    `${env.GATEWAY_INTERNAL_URL}/internal/messages/send`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-api-key": env.INTERNAL_API_KEY,
        "idempotency-key": `new-applicant:${job.id}`,
        "x-request-id": job.id,
      },
      body: JSON.stringify({ to: newApplicantNotifyJid, type: "text", text: message }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) logger.warn({ status: response.status, jobId: job.id }, "new applicant notification failed");
}

async function selectedOpenClawUrl(): Promise<URL> {
  const setting = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key='openclaw.url' AND is_secret=false`,
  );
  const value =
    typeof setting.rows[0]?.value === "string"
      ? setting.rows[0].value
      : env.OPENCLAW_WEBHOOK_URL;
  return validatedOpenClawUrl(value);
}

async function jsonBody(
  response: Response,
  maxBytes = 1_048_576,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new NonRetryableBridgeError("Respons OpenClaw terlalu besar");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new NonRetryableBridgeError("Respons OpenClaw terlalu besar");
      }
      chunks.push(value);
    }
  }
  if (size === 0) return null;
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new NonRetryableBridgeError("Respons JSON OpenClaw tidak valid");
  }
}

async function processJob(job: Job): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OPENCLAW_TIMEOUT_MS);
  let leaseLost = false;
  let heartbeatRunning = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void db
        .query(
          `UPDATE queue_jobs SET locked_at=now(),lock_expires_at=now()+($3::text||' seconds')::interval,updated_at=now() WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
          [job.id, workerId, env.QUEUE_LEASE_SECONDS],
        )
        .then((result) => {
          if (result.rowCount !== 1) {
            leaseLost = true;
            controller.abort();
          }
        })
        .catch((error) => {
          leaseLost = true;
          logger.error(
            { err: error, jobId: job.id },
            "OpenClaw lease heartbeat failed",
          );
          controller.abort();
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    },
    Math.max(1_000, Math.floor((env.QUEUE_LEASE_SECONDS * 1000) / 3)),
  );
  heartbeat.unref();
  try {
    const context = await agentContext(controller.signal);
    const remoteJid = text(job.payload.remoteJid);
    const incomingText = text(job.payload.text);
    const messageType = text(job.payload.messageType) || "text";
    const media =
      job.payload.media && typeof job.payload.media === "object"
        ? (job.payload.media as Record<string, unknown>)
        : {};
    if (!remoteJid)
      throw new NonRetryableBridgeError("Payload pesan WhatsApp tidak valid: remoteJid kosong");
    const hasMedia = Object.keys(media).length > 0;
    if (!incomingText && !hasMedia)
      throw new NonRetryableBridgeError("Payload pesan WhatsApp tidak valid: text/media kosong");
    const contact = await contactContext(remoteJid);
    const mediaLines = Object.entries(media)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${String(value)}`);
    const mediaPrompt = `[WhatsApp ${messageType || "media"}]${
      mediaLines.length ? `\n${mediaLines.join("\n")}` : ""
    }\ncaption: ${incomingText || "(tanpa caption)"}`;
    const userContent = messageType === "text" ? incomingText : mediaPrompt;
    logger.info(
      {
        jobId: job.id,
        messageType,
        hasText: Boolean(incomingText),
        hasMedia,
        timeoutMs: env.OPENCLAW_TIMEOUT_MS,
      },
      "OpenClaw bridge forwarding inbound message",
    );
    const response = await fetch(await selectedOpenClawUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENCLAW_API_KEY}`,
        "x-openclaw-message-channel": "whatsapp",
        "idempotency-key": `ocgw:${job.id}`,
        "x-request-id": job.id,
      },
      body: JSON.stringify({
        model: "openclaw/wa-hrd",
        user: `ocgw-wa:${remoteJid}`,
        messages: [
          { role: "system", content: buildSystemPrompt(context, contact) },
          { role: "user", content: userContent },
        ],
        stream: false,
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if ([408, 425, 429].includes(response.status) || response.status >= 500)
        throw new Error(`OpenClaw HTTP ${response.status}`);
      throw new NonRetryableBridgeError(
        `OpenClaw menolak event (HTTP ${response.status})`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const responseBody = await jsonBody(response);
    const extracted = extractReply(responseBody);
    if (!extracted)
      throw new NonRetryableBridgeError("OpenClaw tidak memberi reply teks");
    const reply = {
      ...extracted,
      to: extracted.to || remoteJid,
      ...(text(job.payload.waMessageId)
        ? { replyTo: text(job.payload.waMessageId) }
        : {}),
      ...(text(job.payload.participantJid)
        ? { replyToParticipant: text(job.payload.participantJid) }
        : {}),
    };
    if (env.OPENCLAW_REPLY_DELAY_MS > 0)
      await delay(env.OPENCLAW_REPLY_DELAY_MS, undefined, {
        signal: controller.signal,
      });
    const send = await fetch(
      `${env.GATEWAY_INTERNAL_URL}/internal/messages/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-api-key": env.INTERNAL_API_KEY,
          "idempotency-key": `openclaw-reply:${job.id}`,
          "x-request-id": job.id,
        },
        body: JSON.stringify({ type: "text", ...reply }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    await send.body?.cancel().catch(() => undefined);
    if (!send.ok) {
      if ([408, 425, 429].includes(send.status) || send.status >= 500)
        throw new Error(`Gateway reply queue HTTP ${send.status}`);
      throw new NonRetryableBridgeError(
        `Gateway menolak reply (HTTP ${send.status})`,
      );
    }
    const memoryUpdate = await updateContactMemory(
      remoteJid,
      incomingText,
      reply.text,
    );
    if (memoryUpdate.newlySubmitted)
      await notifyNewApplicant(
        job,
        remoteJid,
        memoryUpdate.candidateName,
        incomingText,
      );
    return true;
  } catch (error) {
    if (leaseLost)
      throw new LostLeaseError(
        "OpenClaw queue lease hilang saat request berlangsung",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
}

if (!process.env.VITEST) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopping = true;
      logger.info({ signal }, "bridge stopping");
    });
  await db.query("SELECT 1");
  const singleton = await db.connect();
  const singletonLock = await singleton.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [bridgeSingletonAdvisoryLock],
  );
  if (!singletonLock.rows[0]?.locked) {
    singleton.release();
    await db.end();
    throw new Error(
      "Instance OpenClaw bridge lain masih memegang singleton lock",
    );
  }
  logger.info({ workerId }, "OpenClaw bridge started");
  while (!stopping) {
    const job = await claim().catch((error) => {
      logger.error({ err: error }, "queue claim failed");
      return null;
    });
    if (!job) {
      await delay(env.QUEUE_POLL_MS);
      continue;
    }
    try {
      const responded = await processJob(job);
      await complete(job, responded);
      logger.info(
        { jobId: job.id, type: job.job_type, responded },
        "OpenClaw event delivered",
      );
    } catch (error) {
      if (error instanceof LostLeaseError)
        logger.error(
          { err: error, jobId: job.id },
          "queue ownership lost; state left to current owner/recovery",
        );
      else
        await fail(job, error).catch((failError) =>
          logger.error(
            { err: failError, jobId: job.id },
            "queue failure update failed",
          ),
        );
    }
  }
  await singleton
    .query("SELECT pg_advisory_unlock($1)", [bridgeSingletonAdvisoryLock])
    .catch(() => undefined);
  singleton.release();
  await db.end();
}
