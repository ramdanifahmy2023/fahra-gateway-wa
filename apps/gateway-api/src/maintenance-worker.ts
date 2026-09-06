import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WEEKLY_BACKUP_SCHEDULING_STATUSES,
  localBackupWindow,
  weeklyBackupDedupeKey,
  weeklyRetentionIds,
} from "./backup-maintenance-policy.js";
import {
  createDatabasePool,
  createLogger,
  loadEnvironment,
  withTransaction,
  enqueueJob,
} from "@ocgw/shared";

type Job = {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

class LostLeaseError extends Error {}

const env = loadEnvironment();
const logger = createLogger(env, "maintenance-worker");
const db = createDatabasePool(env);
const workerId = `maintenance:${process.pid}:${randomUUID()}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let stopping = false;
let nextRetentionAt = 0;
let nextFileLogRetentionAt = 0;
let nextDailyBackupAt = 0;
const restoreHandoffPath = join(
  env.workspaceRoot,
  ".runtime",
  "restore-handoff.json",
);
const restorePhases = new Set([
  "ready",
  "granted",
  "stopping",
  "restoring",
  "committed",
  "starting",
  "verifying",
  "completed",
  "recovery_start",
  "failed",
]);

type RestoreHandoff = {
  version: number;
  mode?: string;
  workspaceRoot: string;
  operationId: string;
  jobId: string;
  tokenDigest: string;
  coordinatorPid: number;
  coordinatorStartToken: string;
  parentPid: number;
  parentStartToken: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  context?: {
    sourceFilename: string;
    artifactSha256: string;
    stageRelativePath: string;
  };
};

function inheritedProcessEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SHELL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

async function captureProcessField(
  pid: number,
  field: "command" | "lstart",
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", `${field}=`], {
      env: inheritedProcessEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) =>
      resolve(
        code === 0 && output.trim() ? output.trim().replace(/\s+/g, " ") : null,
      ),
    );
  });
}

type PendingRestoreCoordinator = {
  childPid: number;
  granted: boolean;
  grant: () => Promise<void>;
  cancel: (reason: string) => Promise<void>;
};

async function processStartToken(pid: number): Promise<string | null> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    return (
      source
        .slice(source.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    const started = await captureProcessField(pid, "lstart");
    return started ? `ps:${started}` : null;
  }
}

async function coordinatorIdentityMatches(
  marker: RestoreHandoff,
): Promise<boolean> {
  try {
    process.kill(marker.coordinatorPid, 0);
  } catch {
    return false;
  }
  let command: string | null = null;
  try {
    command = (await readFile(`/proc/${marker.coordinatorPid}/cmdline`))
      .toString("utf8")
      .replaceAll("\0", " ");
  } catch {
    command = await captureProcessField(marker.coordinatorPid, "command");
  }
  if (!command?.includes("scripts/restore.mjs")) return false;
  const currentStart = await processStartToken(marker.coordinatorPid);
  return Boolean(currentStart && marker.coordinatorStartToken === currentStart);
}

async function processInstanceDefinitelyGone(
  pid: number,
  expectedStartToken: string,
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const currentStart = await processStartToken(pid);
  return Boolean(currentStart && currentStart !== expectedStartToken);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

function validateRestoreHandoff(value: unknown): RestoreHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Restore handoff marker tidak valid");
  const marker = value as RestoreHandoff;
  if (
    marker.version !== 1 ||
    marker.workspaceRoot !== env.workspaceRoot ||
    !uuidPattern.test(marker.operationId) ||
    !uuidPattern.test(marker.jobId) ||
    !/^[a-f0-9]{64}$/i.test(marker.tokenDigest) ||
    !Number.isSafeInteger(marker.coordinatorPid) ||
    marker.coordinatorPid <= 1 ||
    !Number.isSafeInteger(marker.parentPid) ||
    marker.parentPid <= 1 ||
    typeof marker.coordinatorStartToken !== "string" ||
    !marker.coordinatorStartToken ||
    typeof marker.parentStartToken !== "string" ||
    !marker.parentStartToken ||
    !restorePhases.has(marker.phase)
  )
    throw new Error("Restore handoff marker gagal validasi");
  const context = marker.context;
  const stage = resolve(
    env.workspaceRoot,
    String(context?.stageRelativePath ?? ""),
  );
  const canonicalStageRelativePath = relative(env.workspaceRoot, stage);
  if (
    !context ||
    basename(context.sourceFilename) !== context.sourceFilename ||
    !context.sourceFilename.endsWith(".ocgwb") ||
    !/^[a-f0-9]{64}$/i.test(context.artifactSha256) ||
    context.stageRelativePath !== canonicalStageRelativePath ||
    (stage !== env.workspaceRoot &&
      !stage.startsWith(`${env.workspaceRoot}${sep}`)) ||
    !/^\.restore-stage-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      basename(stage),
    )
  ) {
    throw new Error("Restore handoff staging context gagal validasi");
  }
  return marker;
}

async function removeRestoreJournalStage(
  marker: RestoreHandoff,
): Promise<void> {
  if (!marker.context)
    throw new Error("Restore journal staging context hilang");
  const stage = resolve(env.workspaceRoot, marker.context.stageRelativePath);
  const workspaceInfo = await lstat(env.workspaceRoot);
  if (
    !workspaceInfo.isDirectory() ||
    workspaceInfo.isSymbolicLink() ||
    (typeof process.getuid === "function" &&
      workspaceInfo.uid !== process.getuid())
  ) {
    throw new Error("Workspace root restore cleanup tidak aman");
  }
  const stageParts = relative(env.workspaceRoot, stage)
    .split(sep)
    .filter(Boolean);
  let currentParent = env.workspaceRoot;
  for (const part of stageParts.slice(0, -1)) {
    currentParent = join(currentParent, part);
    const info = await lstat(currentParent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new Error(
        "Restore staging parent bukan directory workspace yang aman",
      );
    }
  }
  const rootInfo = await lstat(stage).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return;
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  const validateTree = async (target: string): Promise<void> => {
    const info = await lstat(target);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.mode & 0o077) !== 0 ||
      (expectedUid !== null && info.uid !== expectedUid)
    ) {
      throw new Error("Restore staging tree bukan regular owner-only");
    }
    if (info.isDirectory())
      for (const name of await readdir(target))
        await validateTree(join(target, name));
  };
  await validateTree(stage);
  await rm(stage, { recursive: true, force: true });
  await syncDirectory(dirname(stage));
}

async function readRestoreHandoff(
  optional = false,
): Promise<RestoreHandoff | null> {
  const info = await lstat(restoreHandoffPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!info) {
    if (optional) return null;
    throw new Error("Restore handoff marker tidak ditemukan");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    info.size > 16_384
  ) {
    throw new Error("Restore handoff marker wajib regular file owner-only");
  }
  const handle = await open(
    restoreHandoffPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > 16_384
    ) {
      throw new Error("Restore handoff marker berubah saat dibuka");
    }
    return validateRestoreHandoff(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
  } finally {
    await handle.close();
  }
}

async function gateDatabaseForActiveRestore(): Promise<boolean> {
  let announced = false;
  let identity: string | null = null;
  for (;;) {
    if (stopping) return false;
    const marker = await readRestoreHandoff(true);
    if (!marker) return !stopping;
    const currentIdentity = `${marker.operationId}:${marker.tokenDigest}:${marker.coordinatorPid}:${marker.coordinatorStartToken ?? ""}`;
    if (identity && identity !== currentIdentity)
      throw new Error(
        "Restore handoff owner berubah saat maintenance worker menunggu",
      );
    identity = currentIdentity;
    if (!(await coordinatorIdentityMatches(marker))) {
      const coordinatorGone = await processInstanceDefinitelyGone(
        marker.coordinatorPid,
        marker.coordinatorStartToken,
      );
      const provablyPreDowntime =
        coordinatorGone &&
        (marker.phase === "granted" ||
          (marker.phase === "ready" &&
            (await processInstanceDefinitelyGone(
              marker.parentPid,
              marker.parentStartToken,
            ))));
      const safelyTerminal =
        marker.phase === "completed" || marker.phase === "failed";
      if (provablyPreDowntime || (coordinatorGone && safelyTerminal)) {
        const latest = await readRestoreHandoff();
        if (
          latest &&
          latest.phase === marker.phase &&
          latest.operationId === marker.operationId &&
          latest.tokenDigest === marker.tokenDigest &&
          latest.coordinatorPid === marker.coordinatorPid &&
          latest.coordinatorStartToken === marker.coordinatorStartToken
        ) {
          try {
            await removeRestoreJournalStage(latest);
            await rm(restoreHandoffPath, { force: true });
            await syncDirectory(dirname(restoreHandoffPath));
            logger.warn(
              { operationId: marker.operationId, phase: marker.phase },
              safelyTerminal
                ? "stale terminal restore marker and staging removed after coordinator exit"
                : "stale pre-downtime restore marker and staging removed; no stop phase was authorized",
            );
            return !stopping;
          } catch (error) {
            logger.error(
              { err: error, operationId: marker.operationId },
              "safe stale restore cleanup failed; maintenance remains fail-closed",
            );
            announced = true;
          }
        }
      }
      if (!announced)
        logger.error(
          { operationId: marker.operationId, phase: marker.phase },
          "restore coordinator invalid; maintenance remains fail-closed without DB writes",
        );
      announced = true;
      await delay(5_000);
      if (stopping) return false;
      continue;
    }
    if (!announced) {
      logger.warn(
        { operationId: marker.operationId, phase: marker.phase },
        "maintenance DB writes gated by active restore coordinator",
      );
      announced = true;
    }
    await delay(500);
    if (stopping) return false;
  }
}

function minimalCoordinatorEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    ...inheritedProcessEnvironment(),
    OCGW_RESTORE_HANDOFF_TOKEN: token,
  };
}

async function spawnRestoreCoordinator(
  job: Job,
  filename: string,
  operationId: string,
): Promise<PendingRestoreCoordinator> {
  const token = randomBytes(48).toString("base64url");
  const tokenDigest = createHash("sha256").update(token, "utf8").digest("hex");
  const coordinatorLogPath = join(
    env.workspaceRoot,
    "data",
    "logs",
    "restore-coordinator.log",
  );
  const logInfo = await lstat(coordinatorLogPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (logInfo?.isSymbolicLink() || (logInfo && !logInfo.isFile()))
    throw new Error("Restore coordinator log path tidak aman");
  const log = await open(
    coordinatorLogPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const opened = await log.stat();
    if (
      !opened.isFile() ||
      (logInfo && (opened.dev !== logInfo.dev || opened.ino !== logInfo.ino))
    ) {
      throw new Error("Restore coordinator log berubah saat dibuka");
    }
    await log.chmod(0o600);
    const spawned = spawn(
      process.execPath,
      [
        "scripts/restore.mjs",
        filename,
        "--yes",
        `--operation-id=${operationId}`,
        `--handoff-parent-pid=${process.pid}`,
        `--handoff-job-id=${job.id}`,
      ],
      {
        cwd: env.workspaceRoot,
        env: minimalCoordinatorEnvironment(token),
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
      },
    );
    child = spawned;
    await new Promise<void>((resolve, reject) => {
      spawned.once("spawn", resolve);
      spawned.once("error", reject);
    });
  } finally {
    await log.close();
  }
  if (!child) throw new Error("Restore coordinator gagal dibuat");
  const childPid = child.pid;
  if (
    typeof childPid !== "number" ||
    !Number.isSafeInteger(childPid) ||
    childPid <= 1
  )
    throw new Error("Restore coordinator tidak memiliki PID valid");
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });
  child.unref();
  let cancellation: Promise<void> | null = null;
  const processGroupAlive = (): boolean => {
    try {
      process.kill(-childPid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      try {
        process.kill(childPid, 0);
        return true;
      } catch (leaderError) {
        return (leaderError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  };
  const waitForProcessGroupExit = async (
    milliseconds: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (!processGroupAlive()) return true;
      await delay(100);
    }
    return !processGroupAlive();
  };
  const pendingCoordinatorIdentityMatches = async (
    marker: RestoreHandoff,
  ): Promise<boolean> => {
    if (await coordinatorIdentityMatches(marker)) return true;
    // When the workspace hides both /proc and usable ps output, the child
    // publishes a random process-local token.  Before grant we still own the
    // exact ChildProcess instance and require its authenticated handoff token.
    return (
      marker.coordinatorPid === childPid &&
      marker.coordinatorStartToken.startsWith("self:") &&
      !childExited &&
      processGroupAlive()
    );
  };
  const cancelBeforeGrant = (reason: string): Promise<void> => {
    if (cancellation) return cancellation;
    cancellation = (async () => {
      try {
        process.kill(-childPid, "SIGTERM");
      } catch {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      if (!(await waitForProcessGroupExit(5_000))) {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      if (!(await waitForProcessGroupExit(5_000)))
        throw new Error(
          `Restore coordinator process group ${childPid} gagal dihentikan`,
        );
      const marker = await readRestoreHandoff(true);
      if (
        marker?.phase === "ready" &&
        marker.operationId === operationId &&
        marker.jobId === job.id &&
        marker.tokenDigest === tokenDigest &&
        marker.parentPid === process.pid
      ) {
        await removeRestoreJournalStage(marker);
        await rm(restoreHandoffPath, { force: true });
        await syncDirectory(dirname(restoreHandoffPath));
      }
      logger.warn(
        { operationId, coordinatorPid: childPid, reason },
        "restore coordinator cancelled before handoff grant",
      );
    })();
    return cancellation;
  };
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    if (stopping) {
      await cancelBeforeGrant("maintenance worker stopping");
      throw new Error(
        "Restore coordinator dibatalkan sebelum grant karena maintenance worker berhenti",
      );
    }
    const marker = await readRestoreHandoff(true);
    if (marker) {
      const currentParentStartToken = await processStartToken(process.pid);
      const parentIdentityMatches =
        marker.parentStartToken === currentParentStartToken ||
        marker.parentStartToken === `handoff:${tokenDigest}`;
      const valid =
        marker.operationId === operationId &&
        marker.jobId === job.id &&
        marker.tokenDigest === tokenDigest &&
        marker.coordinatorPid === childPid &&
        marker.parentPid === process.pid &&
        parentIdentityMatches &&
        marker.phase === "ready";
      if (!valid || !(await pendingCoordinatorIdentityMatches(marker))) {
        await cancelBeforeGrant("handoff marker mismatch");
        throw new Error("Restore coordinator handoff marker tidak cocok");
      }
      const pending: PendingRestoreCoordinator = {
        childPid,
        granted: false,
        cancel: cancelBeforeGrant,
        grant: async () => {
          if (stopping)
            throw new Error(
              "Maintenance worker berhenti sebelum restore grant",
            );
          const latest = await readRestoreHandoff();
          if (
            !latest ||
            latest.phase !== "ready" ||
            latest.operationId !== operationId ||
            latest.jobId !== job.id ||
            latest.tokenDigest !== tokenDigest ||
            latest.coordinatorPid !== childPid ||
            latest.parentPid !== process.pid ||
            !(await pendingCoordinatorIdentityMatches(latest))
          )
            throw new Error("Restore handoff berubah sebelum parent grant");
          const granted = {
            ...latest,
            phase: "granted",
            updatedAt: new Date().toISOString(),
          };
          const temporary = `${restoreHandoffPath}.grant-${process.pid}-${randomBytes(8).toString("hex")}`;
          try {
            const handle = await open(
              temporary,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                (constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              await handle.writeFile(`${JSON.stringify(granted)}\n`, "utf8");
              await handle.sync();
            } finally {
              await handle.close();
            }
            if (stopping)
              throw new Error(
                "Maintenance worker menerima signal sebelum restore grant",
              );
            await rename(temporary, restoreHandoffPath);
            await syncDirectory(dirname(restoreHandoffPath));
            pending.granted = true;
          } finally {
            await rm(temporary, { force: true });
          }
          logger.info(
            { operationId, coordinatorPid: childPid },
            "restore coordinator handoff granted; maintenance worker will exit",
          );
        },
      };
      return pending;
    }
    try {
      process.kill(childPid, 0);
    } catch {
      await cancelBeforeGrant("coordinator exited before ready");
      throw new Error("Restore coordinator berhenti sebelum handoff ready");
    }
    await delay(500);
  }
  await cancelBeforeGrant("ready handoff timeout");
  throw new Error("Timeout menunggu restore coordinator handoff ready");
}

async function enqueueDailyBackup(): Promise<void> {
  const setting = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key='locale.timezone' AND is_secret=false`,
  );
  const configured = setting.rows[0]?.value;
  const timeZone = typeof configured === "string" ? configured : "Asia/Jakarta";
  const { scheduledDate: date, scheduledWeek: week, eligible } = localBackupWindow(timeZone);
  if (!eligible) return;
  await withTransaction(db, async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM backup_records
       WHERE operation='backup' AND metadata->>'schedule'='weekly' AND metadata->>'scheduledWeek'=$1
         AND status=ANY($2::text[])
       LIMIT 1`,
      [week, [...WEEKLY_BACKUP_SCHEDULING_STATUSES]],
    );
    if (existing.rowCount) return;
    const backupId = randomUUID();
    const backup = await client.query<{ id: string }>(
      `INSERT INTO backup_records(id,operation,filename,status,metadata,created_at,started_at)
       VALUES($1,'backup',$2,'queued',jsonb_build_object('schedule','weekly','scheduledDate',$3::text,'scheduledWeek',$4::text),now(),now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [backupId, `pending-${backupId}.ocgwb`, date, week],
    );
    if (!backup.rows[0]) return;
    const queueJobId = await enqueueJob(client, {
      queue: "maintenance",
      type: "backup-create",
      payload: { backupId: backup.rows[0].id },
      dedupeKey: weeklyBackupDedupeKey(week, backup.rows[0].id),
      maxAttempts: 2,
    });
    const linkedJob = await client.query<{ backupId: string | null }>(
      `SELECT payload->>'backupId' AS "backupId"
       FROM queue_jobs WHERE id=$1 FOR SHARE`,
      [queueJobId],
    );
    if (linkedJob.rows[0]?.backupId !== backup.rows[0].id)
      throw new Error("Weekly backup queue job tidak menunjuk operation yang baru dibuat");
    logger.info({ scheduledDate: date, scheduledWeek: week, backupId: backup.rows[0].id, timeZone }, "weekly encrypted backup queued");
  });
}

async function runBackupRetention(): Promise<void> {
  const records = await db.query<{ id: string; filename: string }>(
    `SELECT id,filename FROM backup_records
     WHERE operation='backup' AND status='completed'
       AND metadata->>'schedule'='weekly'
     ORDER BY (metadata->>'scheduledWeek') DESC, completed_at DESC`,
  );
  const removable = weeklyRetentionIds(records.rows);
  const keep = records.rows.filter((record) => !removable.has(record.id));
  const remove = records.rows.filter((record) => removable.has(record.id));
  for (const record of remove) {
    const active = await db.query(
      `SELECT 1 FROM backup_records WHERE metadata @> jsonb_build_object('sourceBackupId',$1::text) LIMIT 1`,
      [record.id],
    );
    if (active.rowCount || basename(record.filename) !== record.filename || !record.filename.endsWith('.ocgwb')) continue;
    const backupsRoot = resolve(env.dataDir, "backups");
    const artifact = resolve(backupsRoot, record.filename);
    const info = await lstat(artifact).catch(() => null);
    if (
      artifact !== join(backupsRoot, record.filename) ||
      !info ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      continue;
    await rm(artifact);
    await syncDirectory(backupsRoot);
    await db.query(
      "DELETE FROM backup_records WHERE id=$1 AND operation='backup' AND status='completed'",
      [record.id],
    );
  }
  if (remove.length || keep.length) logger.info({ kept: keep.length, candidates: remove.length }, "daily backup retention evaluated");
}

async function runRetention(): Promise<void> {
  const setting = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key='messages.retention_days' AND is_secret=false`,
  );
  const parsed = Number(setting.rows[0]?.value ?? 90);
  const days =
    Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : 90;
  const messages = await db.query(
    `WITH expired AS (
       SELECT message.id FROM whatsapp_messages AS message
       WHERE message.created_at < now()-($1::text||' days')::interval
         AND ((message.direction='outbound' AND message.status IN ('sent','delivered','read','failed','dead','dead_letter'))
           OR (message.direction='inbound' AND message.processing_state IN ('ignored','forwarded','responded','failed')))
         AND NOT EXISTS (
           SELECT 1 FROM queue_jobs AS job WHERE job.id=message.queue_job_id
             AND job.status NOT IN ('completed','failed','dead','dead_letter','cancelled')
         )
       ORDER BY message.created_at LIMIT 1000
     ) DELETE FROM whatsapp_messages AS message USING expired WHERE message.id=expired.id`,
    [days],
  );
  const logs = await db.query(
    `WITH expired AS (
       SELECT id FROM operational_logs
       WHERE created_at < now()-($1::text||' days')::interval
       ORDER BY created_at LIMIT 5000
     ) DELETE FROM operational_logs AS log USING expired WHERE log.id=expired.id`,
    [days],
  );
  if ((messages.rowCount ?? 0) + (logs.rowCount ?? 0) > 0) {
    logger.info(
      {
        retentionDays: days,
        messages: messages.rowCount,
        operationalLogs: logs.rowCount,
      },
      "retention cleanup completed",
    );
  }
  nextRetentionAt = Date.now() + 60 * 60 * 1000;
}

async function enforceFileLogRetention(): Promise<void> {
  const directory = join(env.workspaceRoot, "data", "logs");
  const maxBytes = 50 * 1024 * 1024;
  const truncated: string[] = [];
  for (const name of await readdir(directory)) {
    const target = join(directory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Entry log workspace tidak aman: ${name}`);
    if (info.size <= maxBytes) continue;
    const handle = await open(
      target,
      constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino
      )
        throw new Error(`Log berubah saat dibuka: ${name}`);
      await handle.truncate(0);
      await handle.chmod(0o600);
      await handle.sync();
      truncated.push(name);
    } finally {
      await handle.close();
    }
  }
  if (truncated.length) {
    await syncDirectory(directory);
    logger.warn(
      { files: truncated, maxBytes },
      "workspace log files truncated at owner-only size cap",
    );
  }
  nextFileLogRetentionAt = Date.now() + 5 * 60 * 1000;
}

async function claim(): Promise<Job | null> {
  return withTransaction(db, async (client) => {
    const recovered = await client.query<{ id: string }>(
      `UPDATE queue_jobs
       SET status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'pending' END,
           available_at=now(),locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,
           last_error=COALESCE(last_error,'Recovered expired maintenance lease'),updated_at=now()
       WHERE queue_name='maintenance' AND status='processing'
         AND COALESCE(lock_expires_at,locked_at+($1::text||' seconds')::interval)<now()
       RETURNING id`,
      [env.QUEUE_LEASE_SECONDS],
    );
    if (recovered.rows.length) {
      await client.query(
        `UPDATE backup_records AS operation
         SET status='failed',error=COALESCE(operation.error,'Maintenance lease kedaluwarsa'),completed_at=now()
         FROM queue_jobs AS job
         WHERE job.id=ANY($1::uuid[]) AND job.status='dead_letter'
           AND job.job_type='backup-restore' AND operation.id::text=job.payload->>'restoreOperationId'
           AND operation.operation='restore' AND operation.status NOT IN ('completed','failed','cancelled')`,
        [recovered.rows.map((row) => row.id)],
      );
    }
    const result = await client.query<Job>(
      `SELECT id,job_type,payload,attempts,max_attempts FROM queue_jobs
       WHERE queue_name='maintenance' AND status='pending' AND attempts<max_attempts AND available_at<=now()
       ORDER BY priority,available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const locked = await client.query(
      `UPDATE queue_jobs SET status='processing',attempts=attempts+1,locked_at=now(),locked_by=$2,
         lock_expires_at=now()+($3::text||' seconds')::interval,updated_at=now()
       WHERE id=$1 AND status='pending' RETURNING id`,
      [row.id, workerId, env.QUEUE_LEASE_SECONDS],
    );
    if (locked.rowCount !== 1) return null;
    return { ...row, attempts: row.attempts + 1 };
  });
}

function execute(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: env.workspaceRoot,
      env: process.env,
      stdio: "ignore",
      detached: false,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `maintenance command exited ${code ?? signal ?? "unknown"}`,
          ),
        );
    });
  });
}

async function withLeaseHeartbeat<T>(
  job: Job,
  operation: () => Promise<T>,
): Promise<T> {
  let heartbeatRunning = false;
  let leaseLost = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void db
        .query(
          `UPDATE queue_jobs SET locked_at=now(),lock_expires_at=now()+($3::text||' seconds')::interval,updated_at=now()
       WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
          [job.id, workerId, env.QUEUE_LEASE_SECONDS],
        )
        .then((result) => {
          if (result.rowCount !== 1) leaseLost = true;
        })
        .catch((error) => {
          leaseLost = true;
          logger.error(
            { err: error, jobId: job.id },
            "maintenance lease heartbeat failed",
          );
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    },
    Math.max(1_000, Math.floor((env.QUEUE_LEASE_SECONDS * 1000) / 3)),
  );
  heartbeat.unref();
  try {
    const result = await operation();
    if (leaseLost)
      throw new LostLeaseError(
        "Maintenance queue lease hilang saat command berjalan",
      );
    const ownership = await db.query(
      `UPDATE queue_jobs SET locked_at=now(),lock_expires_at=now()+($3::text||' seconds')::interval,updated_at=now()
       WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
      [job.id, workerId, env.QUEUE_LEASE_SECONDS],
    );
    if (ownership.rowCount !== 1)
      throw new LostLeaseError(
        "Maintenance queue lease hilang sebelum handoff grant",
      );
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

async function complete(job: Job): Promise<void> {
  const result = await db.query(
    `UPDATE queue_jobs SET status='completed',completed_at=now(),locked_at=NULL,locked_by=NULL,
       lock_expires_at=NULL,last_error=NULL,updated_at=now()
     WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
    [job.id, workerId],
  );
  if (result.rowCount !== 1)
    throw new LostLeaseError(
      "Maintenance queue lease hilang sebelum completion",
    );
}

function restoreOperationId(job: Job): string | null {
  const value = job.payload.restoreOperationId;
  return typeof value === "string" && uuidPattern.test(value) ? value : null;
}

async function processJob(job: Job): Promise<"restore-handoff" | void> {
  if (job.job_type === "backup-create") {
    const backupId = job.payload.backupId;
    if (typeof backupId !== "string" || !uuidPattern.test(backupId))
      throw new Error("backupId maintenance tidak valid");
    await withLeaseHeartbeat(job, () =>
      execute(["scripts/backup.mjs", `--backup-id=${backupId}`]),
    );
    await complete(job);
    return;
  }
  if (job.job_type === "backup-restore") {
    const filename = job.payload.filename;
    const operationId = restoreOperationId(job);
    if (
      typeof filename !== "string" ||
      !filename.endsWith(".ocgwb") ||
      !operationId
    ) {
      throw new Error("Payload restore maintenance tidak valid");
    }
    // The detached coordinator performs preflight first, then publishes an
    // owner-validated handoff. This worker exits only after that ACK so stop
    // never relies on a grandchild accidentally surviving PM2/runner teardown.
    let pending: PendingRestoreCoordinator | null = null;
    try {
      pending = await withLeaseHeartbeat(job, () =>
        spawnRestoreCoordinator(job, filename, operationId),
      );
      await pending.grant();
      return "restore-handoff";
    } catch (error) {
      if (pending && !pending.granted) {
        try {
          await pending.cancel("lease/grant failure");
        } catch (cancelError) {
          stopping = true;
          throw new AggregateError(
            [error, cancelError],
            "Restore grant gagal dan coordinator tidak dapat dibersihkan",
          );
        }
      }
      throw error;
    }
  }
  throw new Error(`unsupported maintenance job ${job.job_type}`);
}

async function fail(job: Job, error: unknown): Promise<void> {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 4_000);
  const terminal = job.attempts >= job.max_attempts;
  const result = await db.query(
    `UPDATE queue_jobs SET status=$3,last_error=$4,locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,
       failed_at=CASE WHEN $3='dead_letter' THEN now() ELSE failed_at END,
       available_at=CASE WHEN $3='pending' THEN now()+interval '1 minute' ELSE available_at END,updated_at=now()
     WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
    [job.id, workerId, terminal ? "dead_letter" : "pending", message],
  );
  if (result.rowCount !== 1)
    throw new LostLeaseError(
      "Maintenance queue lease hilang sebelum failure transition",
    );
  const operationId = restoreOperationId(job);
  if (terminal && operationId) {
    await db.query(
      `UPDATE backup_records SET status='failed',error=$2,completed_at=now()
       WHERE id=$1 AND operation='restore' AND status NOT IN ('completed','failed','cancelled')`,
      [operationId, message],
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    logger.info({ signal }, "maintenance worker stopping");
  });
}

if (!(await gateDatabaseForActiveRestore())) {
  await db.end();
  process.exit(0);
}
await db.query("SELECT 1");
const singleton = await db.connect();
const singletonLock = await singleton.query<{ locked: boolean }>(
  "SELECT pg_try_advisory_lock($1) AS locked",
  [712_209_448],
);
if (!singletonLock.rows[0]?.locked) {
  singleton.release();
  await db.end();
  throw new Error("Instance maintenance worker lain masih aktif");
}

logger.info({ workerId }, "maintenance worker started");
try {
  while (!stopping) {
    if (Date.now() >= nextFileLogRetentionAt) {
      await enforceFileLogRetention().catch((error) => {
        logger.error({ err: error }, "workspace file log retention failed");
        nextFileLogRetentionAt = Date.now() + 60_000;
      });
    }
    if (Date.now() >= nextDailyBackupAt) {
      await enqueueDailyBackup().catch((error) => logger.error({ err: error }, "daily backup scheduling failed"));
      nextDailyBackupAt = Date.now() + 5 * 60 * 1000;
    }
    if (Date.now() >= nextRetentionAt) {
      await Promise.all([runRetention(), runBackupRetention()]).catch((error) => {
        logger.error({ err: error }, "retention cleanup failed");
        nextRetentionAt = Date.now() + 5 * 60 * 1000;
      });
    }
    const job = await claim().catch((error) => {
      logger.error({ err: error }, "claim failed");
      return null;
    });
    if (!job) {
      await delay(env.QUEUE_POLL_MS);
      continue;
    }
    try {
      const result = await processJob(job);
      if (result === "restore-handoff") {
        stopping = true;
        break;
      }
    } catch (error) {
      if (error instanceof LostLeaseError) {
        logger.error(
          { err: error, jobId: job.id },
          "maintenance queue ownership lost",
        );
      } else {
        await fail(job, error).catch((failError) =>
          logger.error(
            { err: failError, jobId: job.id },
            "maintenance failure update failed",
          ),
        );
        logger.error({ err: error, jobId: job.id }, "maintenance job failed");
      }
    }
  }
} finally {
  await singleton
    .query("SELECT pg_advisory_unlock($1)", [712_209_448])
    .catch(() => undefined);
  singleton.release();
  await db.end();
}
