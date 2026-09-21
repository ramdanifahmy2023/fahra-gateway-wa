import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  assertKeyConfirmation,
  backupLimitsFromEnvironment,
  decodeBackup,
  reviveValue,
  strictBase64Decode,
} from "./lib/backup-format.mjs";
import {
  BACKUP_TABLE_MANIFEST,
  BACKUP_TABLE_NAMES,
  RECOVERABLE_MESSAGE_STATUSES,
  RECOVERABLE_QUEUE_STATUSES,
  RESET_ON_RESTORE_TABLE_NAMES,
  assertMigrationCompatibility,
  isWorkspaceDataMarker,
  validateBackupManifestDescriptor,
  validatePayloadTables,
} from "./lib/backup-manifest.mjs";
import {
  acquireWorkspaceLock,
  assertSessionAffineDatabaseUrl,
  createManualRestoreJournal,
  createRestoreHandoff,
  inheritedEnvironment,
  managedConfigurationKeys,
  parseEnv,
  processIdentityMatches,
  readRestoreHandoff,
  removeRestoreHandoff,
  run,
  transitionRestoreHandoff,
  workspaceRoot,
} from "./lib/common.mjs";

process.umask(0o077);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const operationId = optionValue("--operation-id=");
if (operationId && !uuidPattern.test(operationId))
  throw new Error("--operation-id wajib UUID valid");
const positionalFiles = args.filter((value) => !value.startsWith("--"));
const fileOption = optionValue("--file=");
if (positionalFiles.length > 1 || (positionalFiles.length === 1 && fileOption))
  throw new Error("Sebutkan tepat satu file restore");
let file = positionalFiles[0] ?? fileOption;
if (!file)
  throw new Error(
    "File restore wajib disebut eksplisit: npm run restore -- <file.ocgwb> --yes",
  );
const confirmed =
  args.includes("--yes") || process.env.RESTORE_CONFIRM === "PULIHKAN";
if (!confirmed) {
  throw new Error(
    "Restore destruktif. Jalankan `npm run restore -- <file.ocgwb> --yes` atau set RESTORE_CONFIRM=PULIHKAN.",
  );
}
const handoffParentValue = optionValue("--handoff-parent-pid=");
const handoffJobId = optionValue("--handoff-job-id=");
const handoffToken = process.env.OCGW_RESTORE_HANDOFF_TOKEN;
const handoffParentPid = handoffParentValue ? Number(handoffParentValue) : null;
const handoffRequested = Boolean(
  handoffParentValue || handoffJobId || handoffToken,
);
if (
  handoffRequested &&
  (!operationId ||
    !handoffJobId ||
    !uuidPattern.test(handoffJobId) ||
    !Number.isSafeInteger(handoffParentPid) ||
    handoffParentPid <= 1 ||
    typeof handoffToken !== "string" ||
    Buffer.byteLength(handoffToken, "utf8") < 32)
) {
  throw new Error(
    "Handoff restore membutuhkan operation/job/parent PID/token yang valid",
  );
}
const journalOperationId = operationId ?? randomUUID();
const journalToken = handoffRequested
  ? handoffToken
  : randomBytes(48).toString("base64url");
for (const argument of args) {
  if (
    argument === "--yes" ||
    argument === "--skip-safety" ||
    !argument.startsWith("--") ||
    [
      "--file=",
      "--operation-id=",
      "--handoff-parent-pid=",
      "--handoff-job-id=",
    ].some((prefix) => argument.startsWith(prefix))
  )
    continue;
  throw new Error(`Argumen restore tidak dikenal: ${argument}`);
}

const environment = parseEnv(await readPrivateWorkspaceEnv());
// Restore must use the durable workspace keys, not compatibility-only
// secrets inherited from the maintenance worker process.
for (const key of managedConfigurationKeys) delete process.env[key];
for (const [key, value] of Object.entries(environment))
  process.env[key] = value;
const existingRestoreJournal = await readRestoreHandoff({ optional: true });
if (existingRestoreJournal) {
  throw new Error(
    `Restore ditolak: journal ${existingRestoreJournal.operationId} phase ${existingRestoreJournal.phase} masih aktif`,
  );
}
const limits = backupLimitsFromEnvironment(environment);
const shared = await import(
  pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
);
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
assertSessionAffineDatabaseUrl(
  env.DATABASE_URL,
  environment.DATABASE_POOL_MODE,
);
const roots = await prepareDataRoots();
const artifact = await readArtifact(roots.backupsRoot, file);
file = artifact.path;

let payload;
let restoreOperation = null;
let stageRoot = null;
let stopAttempted = false;
let committed = false;
let fileState = null;
let finalError = null;
let preserveStage = false;
let recoveryStartSafe = true;
let lifecyclePool = null;
let lifecycleClient = null;
let operationLockHeld = false;
let restoreLifecycleLockHeld = false;
let operationClaimed = false;
let workspaceLifecycleLock = null;
let handoffRecord = null;
let restoreOperationCompleted = false;

try {
  payload = await decodeBackup(
    artifact.content,
    env.BACKUP_ENCRYPTION_KEY,
    limits,
  );
  const preflight = validatePayload(payload);
  if (!payload.keyConfirmations || typeof payload.keyConfirmations !== "object")
    throw new Error("Artifact tidak memiliki konfirmasi kunci enkripsi");
  assertKeyConfirmation(
    payload.keyConfirmations.whatsappSession,
    env.WHATSAPP_SESSION_ENCRYPTION_KEY,
    "whatsapp-session",
  );
  assertKeyConfirmation(
    payload.keyConfirmations.applicationSecrets,
    env.SESSION_ENCRYPTION_KEY,
    "application-secrets",
  );

  lifecyclePool = shared.createDatabasePool(env);
  lifecycleClient = await lifecyclePool.connect();
  try {
    if (operationId) {
      const operationLock = await lifecycleClient.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [`openclaw-gateway-restore-operation:${operationId}`],
      );
      if (operationLock.rows[0]?.locked !== true)
        throw new Error(`Restore operation ${operationId} sedang dijalankan`);
      operationLockHeld = true;
    }
    const targetMigrations = await loadTargetMigrations(lifecycleClient);
    assertMigrationCompatibility(payload.schemaMigrations, targetMigrations);
    const targetSchema = await inspectTargetSchema(
      lifecycleClient,
      payload.tables,
    );
    validateBinaryColumns(payload.tables, targetSchema);
    if (operationId) {
      restoreOperation = await claimRestoreOperation(
        lifecycleClient,
        operationId,
        artifact,
        payload,
        handoffRequested ? handoffJobId : null,
        handoffRequested ? handoffParentPid : null,
      );
      operationClaimed = true;
    }
  } catch (error) {
    throw error;
  }

  if (!args.includes("--skip-safety")) {
    await run(process.execPath, ["scripts/backup.mjs", "--safety"]);
  }

  const restoreScript = join(workspaceRoot, "scripts", "restore.mjs");
  workspaceLifecycleLock = await acquireWorkspaceLock("lifecycle", {
    purpose: `restore ${operationId ?? basename(artifact.path)}`,
    currentFragments: [restoreScript],
    validOwnerFragments: [
      [restoreScript],
      ["scripts/restore.mjs"],
      [join(workspaceRoot, "scripts", "start.mjs")],
      ["scripts/start.mjs"],
      [join(workspaceRoot, "scripts", "stop.mjs")],
      ["scripts/stop.mjs"],
      [join(workspaceRoot, "scripts", "install.mjs")],
      ["scripts/install.mjs"],
    ],
  });
  stageRoot = join(roots.dataRoot, `.restore-stage-${randomUUID()}`);
  const journalContext = {
    sourceFilename: basename(artifact.path),
    artifactSha256: artifact.sha256,
    stageRelativePath: relative(workspaceRoot, stageRoot),
  };

  if (handoffRequested) {
    handoffRecord = await createRestoreHandoff({
      operationId,
      jobId: handoffJobId,
      parentPid: handoffParentPid,
      token: handoffToken,
      context: journalContext,
    });
    handoffRecord = await waitForHandoffGrantAndParentExit(handoffRecord);
  } else {
    handoffRecord = await createManualRestoreJournal({
      operationId: journalOperationId,
      token: journalToken,
      context: journalContext,
    });
  }

  // Publish the durable journal before materializing any decrypted file. A
  // crash during staging is then recoverable as a provably pre-downtime
  // granted journal, and stale cleanup retains an authenticated path to the
  // owner-only staging tree.
  await stageBackupFiles(preflight.files, stageRoot);
  await validateCurrentFileTargets(preflight.files);

  const lifecycleLock = await lifecycleClient.query(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [712_209_443],
  );
  if (lifecycleLock.rows[0]?.locked !== true)
    throw new Error(
      "Backup/restore lain sedang aktif; restore belum memulai downtime",
    );
  restoreLifecycleLockHeld = true;
  handoffRecord = await transitionRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
    from: "granted",
    to: "stopping",
  });
  stopAttempted = true;
  await run(process.execPath, ["scripts/stop.mjs", "--keep-database"], {
    env: restoreLifecycleEnvironment(),
  });
  handoffRecord = await transitionRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
    from: "stopping",
    to: "restoring",
  });

  const db = shared.createDatabasePool(env);
  const client = await db.connect();
  let transactionOpen = false;
  let commitAttempted = false;
  const restoreMarker = journalOperationId;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [712_209_441]);
    await client.query("SELECT pg_advisory_xact_lock($1)", [712_209_442]);
    const exclusivelyLockedTables = [
      ...BACKUP_TABLE_NAMES,
      ...RESET_ON_RESTORE_TABLE_NAMES,
      "backup_records",
    ].sort();
    await client.query(
      `LOCK TABLE ${exclusivelyLockedTables.map(quoteIdentifier).join(",")}
       IN ACCESS EXCLUSIVE MODE`,
    );
    assertMigrationCompatibility(
      payload.schemaMigrations,
      await loadTargetMigrations(client),
    );
    const targetSchema = await inspectTargetSchema(client, payload.tables);

    // backup_records is target-local and intentionally preserved. Nulling its
    // actor reference lets the restored admin snapshot replace admin_users.
    await client.query(
      "UPDATE backup_records SET initiated_by=NULL WHERE initiated_by IS NOT NULL",
    );
    for (const tableName of [...BACKUP_TABLE_NAMES].reverse()) {
      await client.query(`DELETE FROM ${quoteIdentifier(tableName)}`);
    }
    for (const tableName of RESET_ON_RESTORE_TABLE_NAMES) {
      await client.query(`DELETE FROM ${quoteIdentifier(tableName)}`);
    }

    for (const table of payload.tables) {
      const metadata = targetSchema.get(table.name);
      const manifest = BACKUP_TABLE_MANIFEST.find(
        (entry) => entry.name === table.name,
      );
      const deferredReferences = manifest?.deferredReferences ?? [];
      const hasIdentity = table.columns.some(
        (column) => metadata.get(column)?.isIdentity,
      );
      for (const rawRow of table.rows) {
        const row = reviveDatabaseRow(
          rawRow,
          table.columns,
          metadata,
          preflight.uploadStoredNames,
        );
        for (const reference of deferredReferences) {
          if (row[reference.column] !== null) {
            row[reference.column] = null;
          }
        }
        const values = table.columns.map((column) => row[column]);
        const overriding = hasIdentity ? " OVERRIDING SYSTEM VALUE" : "";
        await client.query(
          `INSERT INTO ${quoteIdentifier(table.name)} (${table.columns.map(quoteIdentifier).join(",")})${overriding}
           VALUES (${table.columns.map((_, index) => `$${index + 1}`).join(",")})`,
          values,
        );
      }
    }

    for (const table of payload.tables) {
      const manifest = BACKUP_TABLE_MANIFEST.find(
        (entry) => entry.name === table.name,
      );
      const deferredReferences = manifest?.deferredReferences ?? [];
      if (
        !deferredReferences.some((reference) =>
          table.rows.some((row) => row[reference.column] !== null),
        )
      ) {
        continue;
      }
      await client.query(
        `ALTER TABLE ${quoteIdentifier(table.name)} DISABLE TRIGGER USER`,
      );
      for (const rawRow of table.rows) {
        for (const reference of deferredReferences) {
          if (rawRow[reference.column] === null) continue;
          await client.query(
            `UPDATE ${quoteIdentifier(table.name)}
                SET ${quoteIdentifier(reference.column)}=$2
              WHERE ${quoteIdentifier(reference.primaryKey)}=$1`,
            [
              reviveValue(rawRow[reference.primaryKey]),
              reviveValue(rawRow[reference.column]),
            ],
          );
        }
      }
      await client.query(
        `ALTER TABLE ${quoteIdentifier(table.name)} ENABLE TRIGGER USER`,
      );
    }
    await restartIdentitySequencesTransactionally(client, targetSchema);
    await applyPostRestoreSafety(client, preflight.uploadStoredNames);

    if (operationId) {
      const metadata = {
        ...asRecord(restoreOperation?.metadata),
        sourceArtifact: basename(artifact.path),
        sourceCreatedAt: payload.createdAt,
      };
      const operationResult = await client.query(
        `UPDATE backup_records
            SET operation='restore',status='restoring',format_version=2,artifact_path=$2,encrypted=true,
                checksum=$3,size_bytes=$4,initiated_by=NULL,error=NULL,metadata=$5::jsonb
          WHERE id=$1`,
        [
          operationId,
          basename(artifact.path),
          artifact.sha256,
          artifact.content.length,
          JSON.stringify(metadata),
        ],
      );
      if (operationResult.rowCount !== 1)
        throw new Error(
          `Restore operation hilang saat transaksi: ${operationId}`,
        );
    }

    await client.query(
      `INSERT INTO operational_logs(level,service,event,message,context)
       VALUES ('info','restore','backup.restore_committed','Restore database snapshot committed',$1::jsonb)`,
      [
        JSON.stringify({
          restoreOperationId: restoreMarker,
          sourceArtifact: basename(artifact.path),
        }),
      ],
    );

    fileState = { root: stageRoot, originals: [], activated: [] };
    await activateBackupFiles(preflight.files, stageRoot, fileState);
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    committed = true;
    handoffRecord = await transitionRestoreHandoff({
      operationId: journalOperationId,
      token: journalToken,
      from: "restoring",
      to: "committed",
    });
  } catch (error) {
    if (transactionOpen && !commitAttempted)
      await client.query("ROLLBACK").catch(() => undefined);
    if (commitAttempted && !committed) {
      try {
        committed = await committedMarkerExists(shared, env, restoreMarker);
      } catch (verificationError) {
        preserveStage = true;
        recoveryStartSafe = false;
        throw verificationError;
      }
      if (!committed) {
        preserveStage = true;
        recoveryStartSafe = false;
        throw new Error(
          "COMMIT restore tidak terkonfirmasi; hasil negatif tunggal tidak dianggap rollback pasti dan staging dipertahankan",
        );
      }
      transactionOpen = false;
    }
    if (!committed && fileState) {
      try {
        await rollbackActivatedFiles(fileState);
      } catch (rollbackError) {
        preserveStage = true;
        recoveryStartSafe = false;
        throw new AggregateError(
          [error, rollbackError],
          "Restore gagal dan rollback file tidak selesai; staging dipertahankan",
        );
      }
    }
    throw error;
  } finally {
    client.release(
      preserveStage
        ? new Error("Discard koneksi restore dengan status transaksi ambigu")
        : undefined,
    );
    await db.end();
  }

  await run(process.execPath, ["scripts/migrate.mjs"]);
  handoffRecord = await transitionRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
    from: "committed",
    to: "starting",
  });
  await run(process.execPath, ["scripts/start.mjs"], {
    env: restoreLifecycleEnvironment(),
  });
  handoffRecord = await transitionRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
    from: "starting",
    to: "verifying",
  });
  await verifyLocalHealth();
  await removeStageBeforeTerminal();
  if (operationId && operationClaimed) {
    await updateOperationStatus(shared, env, operationId, "completed", null);
  }
  restoreOperationCompleted = true;
  handoffRecord = await transitionRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
    from: "verifying",
    to: "completed",
  });
  await removeRestoreHandoff({
    operationId: journalOperationId,
    token: journalToken,
  });
  handoffRecord = null;
  process.stdout.write(
    `Restore selesai dan health check lulus dari ${basename(artifact.path)}.\n`,
  );
} catch (error) {
  finalError = error;
  let failureStatusUpdated = !operationId || !operationClaimed;
  if (operationId && operationClaimed && !restoreOperationCompleted) {
    try {
      await updateOperationStatus(
        shared,
        env,
        operationId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      failureStatusUpdated = true;
    } catch (statusError) {
      finalError = new AggregateError(
        [finalError, statusError],
        "Restore gagal dan status operation tidak dapat diperbarui",
      );
    }
  }

  if (handoffRecord && restoreOperationCompleted) {
    try {
      const current = await readRestoreHandoff();
      if (current.phase === "verifying")
        handoffRecord = await transitionRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
          from: "verifying",
          to: "completed",
        });
      if ((await readRestoreHandoff()).phase === "completed") {
        await removeRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
        });
        handoffRecord = null;
      }
    } catch (markerError) {
      finalError = new AggregateError(
        [finalError, markerError],
        "Restore selesai tetapi marker handoff tidak dapat dibersihkan",
      );
    }
  } else if (handoffRecord && !stopAttempted) {
    try {
      await removeStageBeforeTerminal();
      const current = await readRestoreHandoff();
      if (!["completed", "failed"].includes(current.phase))
        handoffRecord = await transitionRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
          from: current.phase,
          to: "failed",
        });
      if (failureStatusUpdated) {
        await removeRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
        });
        handoffRecord = null;
      }
    } catch (markerError) {
      finalError = new AggregateError(
        [finalError, markerError],
        "Abort pre-downtime gagal membersihkan marker restore",
      );
    }
  } else if (stopAttempted && !restoreOperationCompleted && recoveryStartSafe) {
    try {
      if (handoffRecord) {
        const current = await readRestoreHandoff();
        if (!["completed", "failed", "recovery_start"].includes(current.phase))
          handoffRecord = await transitionRestoreHandoff({
            operationId: journalOperationId,
            token: journalToken,
            from: current.phase,
            to: "recovery_start",
          });
      }
      await run(process.execPath, ["scripts/start.mjs"], {
        env: restoreLifecycleEnvironment(),
      });
      await verifyLocalHealth();
      if (handoffRecord && failureStatusUpdated) {
        await removeStageBeforeTerminal();
        handoffRecord = await transitionRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
          from: "recovery_start",
          to: "failed",
        });
        await removeRestoreHandoff({
          operationId: journalOperationId,
          token: journalToken,
        });
        handoffRecord = null;
      }
    } catch (recoveryError) {
      preserveStage = true;
      finalError = new AggregateError(
        [finalError, recoveryError],
        "Restore gagal dan recovery service tidak selesai; marker dibiarkan fail-closed",
      );
    }
  }
  if (
    stageRoot &&
    handoffRecord &&
    stopAttempted &&
    !restoreOperationCompleted
  ) {
    // A non-terminal post-downtime journal is the recovery authority.  Its
    // staging tree can contain the only copy of the previous active files,
    // so never remove it from the generic finally cleanup path.
    preserveStage = true;
  }
} finally {
  if (stageRoot && !preserveStage) {
    try {
      await safeRemoveStage(stageRoot);
      stageRoot = null;
    } catch (cleanupError) {
      preserveStage = true;
      finalError = new AggregateError(
        [finalError, cleanupError].filter(Boolean),
        "Cleanup staging restore tidak selesai",
      );
    }
  }
  if (restoreLifecycleLockHeld)
    await lifecycleClient
      ?.query("SELECT pg_advisory_unlock($1)", [712_209_443])
      .catch(() => undefined);
  if (operationLockHeld)
    await lifecycleClient
      ?.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `openclaw-gateway-restore-operation:${operationId}`,
      ])
      .catch(() => undefined);
  lifecycleClient?.release();
  await lifecyclePool?.end().catch(() => undefined);
  await workspaceLifecycleLock?.release().catch(() => undefined);
}

if (finalError) {
  const suffix = preserveStage
    ? ` Staging owner-only dipertahankan di ${stageRoot} karena status konsistensi/cleanup memerlukan recovery operator.`
    : committed
      ? " Database sudah commit; gunakan safety backup terbaru bila perlu rollback operator."
      : " Tidak ada mutasi restore yang di-commit; file aktif tetap/dipulihkan.";
  throw new Error(
    `${finalError instanceof Error ? finalError.message : String(finalError)}${suffix}`,
    { cause: finalError },
  );
}

function optionValue(prefix) {
  const matches = args.filter((value) => value.startsWith(prefix));
  if (matches.length > 1)
    throw new Error(`Argumen restore duplikat: ${prefix.slice(0, -1)}`);
  const value = matches[0]?.slice(prefix.length);
  if (matches.length === 1 && !value)
    throw new Error(`Nilai argumen restore kosong: ${prefix.slice(0, -1)}`);
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

async function readPrivateWorkspaceEnv() {
  const path = join(workspaceRoot, ".env");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 1024 * 1024
  ) {
    throw new Error(".env wajib regular file owner-only berukuran aman");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(".env bukan milik user aktif");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size ||
      opened.size > 1024 * 1024
    ) {
      throw new Error(".env berubah saat dibuka");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function restoreLifecycleEnvironment() {
  return {
    ...inheritedEnvironment(process.env),
    OCGW_LIFECYCLE_OWNER_PID: String(process.pid),
    OCGW_LIFECYCLE_OWNER_TOKEN: workspaceLifecycleLock?.ownerToken ?? "",
    OCGW_SANITIZED_SERVICE_ENV: "1",
    OCGW_RESTORE_HANDOFF_TOKEN: journalToken,
    OCGW_RESTORE_OPERATION_ID: journalOperationId,
  };
}

async function waitForHandoffGrantAndParentExit(initial) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await readRestoreHandoff();
    if (
      current.operationId !== initial.operationId ||
      current.jobId !== initial.jobId ||
      current.tokenDigest !== initial.tokenDigest ||
      current.coordinatorPid !== process.pid ||
      current.parentPid !== initial.parentPid ||
      current.parentStartToken !== initial.parentStartToken
    ) {
      throw new Error("Identitas restore handoff berubah sebelum grant");
    }
    const parentAlive = await processIdentityMatches(
      initial.parentPid,
      ["maintenance-worker.js"],
      initial.parentStartToken,
    );
    if (current.phase === "ready") {
      if (!parentAlive || process.ppid !== initial.parentPid)
        throw new Error(
          "Maintenance parent berhenti sebelum memberikan grant restore",
        );
    } else if (current.phase === "granted") {
      if (!parentAlive && process.ppid !== initial.parentPid) return current;
    } else {
      throw new Error(
        `Phase handoff berubah sebelum downtime: ${current.phase}`,
      );
    }
    await delay(100);
  }
  throw new Error(
    "Timeout menunggu grant dan terminasi maintenance parent sebelum restore",
  );
}

async function claimRestoreOperation(
  client,
  id,
  selectedArtifact,
  sourcePayload,
  maintenanceJobId,
  maintenanceParentPid,
) {
  await client.query("BEGIN");
  try {
    const operationResult = await client.query(
      `SELECT id,operation,filename,status,format_version,artifact_path,initiated_by,metadata,created_at
         FROM backup_records WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const operation = operationResult.rows[0];
    const retryableStatuses = new Set([
      "queued",
      "started",
      "running",
      "restoring",
      "failed",
    ]);
    if (
      !operation ||
      operation.operation !== "restore" ||
      !retryableStatuses.has(operation.status)
    ) {
      throw new Error(
        `backup_records operation restore tidak dapat diklaim: ${id}`,
      );
    }
    operationClaimed = true;

    const sourceFilename = basename(selectedArtifact.path);
    const metadata = asRecord(operation.metadata);
    const sourceBackupId = metadata.sourceBackupId;
    if (
      operation.filename !== `restore-${id}.operation` ||
      operation.artifact_path !== sourceFilename ||
      metadata.sourceFilename !== sourceFilename ||
      typeof sourceBackupId !== "string" ||
      !uuidPattern.test(sourceBackupId)
    ) {
      throw new Error(
        `Restore operation ${id} tidak terikat pada artifact ${sourceFilename}`,
      );
    }

    const sourceResult = await client.query(
      `SELECT id,operation,filename,status,format_version,artifact_path,encrypted,checksum,size_bytes
         FROM backup_records WHERE id=$1 FOR SHARE`,
      [sourceBackupId],
    );
    const source = sourceResult.rows[0];
    if (
      !source ||
      source.operation !== "backup" ||
      source.status !== "completed" ||
      source.format_version !== 2 ||
      source.encrypted !== true ||
      source.filename !== sourceFilename ||
      source.artifact_path !== sourceFilename ||
      source.checksum !== selectedArtifact.sha256 ||
      Number(source.size_bytes) !== selectedArtifact.content.length ||
      sourcePayload.backupId !== sourceBackupId
    ) {
      throw new Error(
        `Metadata source backup ${String(sourceBackupId)} tidak cocok dengan artifact`,
      );
    }

    if (maintenanceJobId) {
      const jobResult = await client.query(
        `SELECT id,queue_name,job_type,payload,status,locked_by
           FROM queue_jobs WHERE id=$1 FOR SHARE`,
        [maintenanceJobId],
      );
      const job = jobResult.rows[0];
      const jobPayload = asRecord(job?.payload);
      if (
        !job ||
        job.queue_name !== "maintenance" ||
        job.job_type !== "backup-restore" ||
        job.status !== "processing" ||
        typeof job.locked_by !== "string" ||
        !job.locked_by.startsWith(`maintenance:${maintenanceParentPid}:`) ||
        jobPayload.restoreOperationId !== id ||
        jobPayload.sourceBackupId !== sourceBackupId ||
        jobPayload.filename !== sourceFilename
      ) {
        throw new Error(
          `Maintenance job ${maintenanceJobId} tidak cocok dengan restore operation`,
        );
      }
    }

    const updated = await client.query(
      `UPDATE backup_records
          SET status='restoring',started_at=now(),completed_at=NULL,error=NULL
        WHERE id=$1 AND operation='restore' AND status=$2`,
      [id, operation.status],
    );
    if (updated.rowCount !== 1)
      throw new Error(`Restore operation berubah saat diklaim: ${id}`);
    await client.query("COMMIT");
    return operation;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function prepareDataRoots() {
  const workspaceReal = await realpath(workspaceRoot);
  const dataPath = resolve(env.dataDir);
  if (!isInside(workspaceRoot, dataPath))
    throw new Error("DATA_DIR restore wajib berada di dalam workspace project");
  await ensureSecureDirectoryChain(dataPath, workspaceReal, "DATA_DIR");
  for (const child of ["whatsapp", "uploads", "backups"]) {
    await ensureSecureDirectoryChain(
      join(dataPath, child),
      workspaceReal,
      `DATA_DIR/${child}`,
    );
  }
  const dataInfo = await lstat(dataPath);
  if (
    !dataInfo.isDirectory() ||
    dataInfo.isSymbolicLink() ||
    (dataInfo.mode & 0o077) !== 0
  ) {
    throw new Error("DATA_DIR wajib directory owner-only dan bukan symlink");
  }
  const dataRoot = await realpath(dataPath);
  if (!isInside(workspaceReal, dataRoot))
    throw new Error("Realpath DATA_DIR keluar dari workspace");
  return {
    dataRoot,
    whatsappRoot: await secureDirectory(join(dataRoot, "whatsapp"), dataRoot),
    uploadsRoot: await secureDirectory(join(dataRoot, "uploads"), dataRoot),
    backupsRoot: await secureDirectory(join(dataRoot, "backups"), dataRoot),
  };
}

async function ensureSecureDirectoryChain(target, workspaceReal, label) {
  const relativePath = relative(workspaceRoot, target);
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    resolve(workspaceRoot, relativePath) !== target
  ) {
    throw new Error(`${label} bukan path child workspace yang valid`);
  }
  let current = workspaceRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    let info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`${label} melewati directory tidak aman: ${current}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(
        `${label} melewati directory milik user lain: ${current}`,
      );
    if ((info.mode & 0o077) !== 0) {
      await chmod(current, 0o700);
      info = await lstat(current);
      if ((info.mode & 0o077) !== 0)
        throw new Error(`${label} tidak dapat dibuat owner-only: ${current}`);
    }
    const resolved = await realpath(current);
    if (!isInside(workspaceReal, resolved))
      throw new Error(`${label} keluar dari realpath workspace`);
  }
}

async function secureDirectory(path, parentRoot) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Directory data tidak aman: ${relative(parentRoot, path)}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(
      `Directory data bukan milik user aktif: ${relative(parentRoot, path)}`,
    );
  }
  const resolved = await realpath(path);
  if (!isInside(parentRoot, resolved))
    throw new Error("Directory data keluar dari DATA_DIR");
  return resolved;
}

async function readArtifact(backupsRoot, requestedFile) {
  const selected = requestedFile;
  const path = resolve(
    selected.includes(sep) ? selected : join(backupsRoot, selected),
  );
  if (!isInside(backupsRoot, path))
    throw new Error("File restore wajib berada di data/backups");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("File restore bukan regular file non-symlink");
  if ((info.mode & 0o077) !== 0)
    throw new Error("File restore wajib owner-only (mode 600)");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("File restore bukan milik user aktif");
  const resolved = await realpath(path);
  if (!isInside(backupsRoot, resolved))
    throw new Error("Realpath file restore keluar dari data/backups");
  if (info.size > limits.maxArtifactBytes) {
    throw new Error(
      `Artifact melewati BACKUP_MAX_ARTIFACT_BYTES=${limits.maxArtifactBytes}`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size !== info.size
    ) {
      throw new Error("Artifact berubah saat dibuka");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      content.length !== info.size
    )
      throw new Error("Artifact berubah saat dibaca");
    return {
      path: resolved,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function validatePayload(value) {
  if (
    value.product !== "OpenClaw WhatsApp Gateway" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error("Identitas/timestamp payload backup tidak valid");
  validateBackupManifestDescriptor(value.manifest);
  const tables = validatePayloadTables(value.tables);
  assertMigrationShape(value.schemaMigrations);
  let totalRows = 0;
  for (const table of tables) {
    if (table.rows.length > limits.maxTableRows) {
      throw new Error(
        `Tabel ${table.name} melewati BACKUP_MAX_TABLE_ROWS=${limits.maxTableRows}`,
      );
    }
    totalRows += table.rows.length;
    if (totalRows > limits.maxTotalRows)
      throw new Error(
        `Total row melewati BACKUP_MAX_TOTAL_ROWS=${limits.maxTotalRows}`,
      );
    const columnSet = new Set(table.columns);
    for (const row of table.rows) {
      if (!asRow(row)) throw new Error(`Row backup ${table.name} bukan object`);
      const keys = Object.keys(row);
      if (
        keys.length !== table.columns.length ||
        keys.some((key) => !columnSet.has(key))
      ) {
        throw new Error(
          `Bentuk row backup tidak cocok dengan kolom: ${table.name}`,
        );
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (rowBytes > limits.maxRowBytes)
        throw new Error(
          `Row ${table.name} melewati BACKUP_MAX_ROW_BYTES=${limits.maxRowBytes}`,
        );
    }
  }

  if (!Array.isArray(value.files) || value.files.length > limits.maxFiles) {
    throw new Error(
      `Daftar file backup tidak valid atau melewati BACKUP_MAX_FILES=${limits.maxFiles}`,
    );
  }
  const seenPaths = new Set();
  let totalFileBytes = 0;
  for (const item of value.files) {
    validateFileMetadata(item);
    if (seenPaths.has(item.relativePath))
      throw new Error(`Path file backup duplikat: ${item.relativePath}`);
    seenPaths.add(item.relativePath);
    const decoded = strictBase64Decode(
      item.content,
      `File ${item.relativePath}`,
    );
    if (decoded.length !== item.sizeBytes)
      throw new Error(`Ukuran file backup tidak cocok: ${item.relativePath}`);
    if (createHash("sha256").update(decoded).digest("hex") !== item.sha256) {
      throw new Error(`SHA-256 file backup tidak cocok: ${item.relativePath}`);
    }
    totalFileBytes += decoded.length;
    if (totalFileBytes > limits.maxTotalFileBytes) {
      throw new Error(
        `Total file melewati BACKUP_MAX_TOTAL_FILE_BYTES=${limits.maxTotalFileBytes}`,
      );
    }
  }
  for (const path of seenPaths) {
    for (const ancestor of pathAncestors(path)) {
      if (seenPaths.has(ancestor))
        throw new Error(
          `Artifact memiliki konflik file/directory: ${ancestor} dan ${path}`,
        );
    }
  }
  validateUploadFileCoverage(tables, value.files);
  collectUploadStoredNames(tables);
  const uploadStoredNames = new Set(
    value.files
      .filter((item) => item.kind === "upload")
      .map((item) => safeRelativeSegments(item.relativePath)[1]),
  );
  if (
    !asRow(value.stats) ||
    value.stats.totalRows !== totalRows ||
    value.stats.totalFiles !== value.files.length ||
    Number(value.stats.totalFileBytes) !== totalFileBytes
  ) {
    throw new Error(
      "Statistik manifest backup tidak cocok dengan isi artifact",
    );
  }
  return {
    tables,
    files: value.files,
    totalRows,
    totalFileBytes,
    uploadStoredNames,
  };
}

function assertMigrationShape(value) {
  // Compatibility helper validates shape and duplicate filenames even against itself.
  assertMigrationCompatibility(value, value);
}

function asRow(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFileMetadata(item) {
  if (
    !asRow(item) ||
    !["whatsapp-session", "upload"].includes(item.kind) ||
    item.mode !== 0o600 ||
    !Number.isSafeInteger(item.sizeBytes) ||
    item.sizeBytes < 0 ||
    item.sizeBytes > limits.maxFileBytes ||
    typeof item.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.sha256) ||
    typeof item.content !== "string"
  ) {
    throw new Error("Metadata file backup tidak valid");
  }
  const segments = safeRelativeSegments(item.relativePath);
  if (item.kind === "whatsapp-session") {
    if (
      segments[0] !== "whatsapp" ||
      segments.length < 2 ||
      ephemeralWhatsappPath(segments.slice(1).join("/"))
    ) {
      throw new Error(
        `Path session backup tidak valid/ephemeral: ${item.relativePath}`,
      );
    }
    if ("uploadId" in item)
      throw new Error(
        `Session file tidak boleh memiliki uploadId: ${item.relativePath}`,
      );
  } else {
    if (
      segments[0] !== "uploads" ||
      segments.length !== 2 ||
      isWorkspaceDataMarker(segments[1]) ||
      typeof item.uploadId !== "string" ||
      !uuidPattern.test(item.uploadId)
    ) {
      throw new Error(`Path upload backup tidak valid: ${item.relativePath}`);
    }
  }
}

function safeRelativeSegments(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\")
  )
    throw new Error("Path relatif backup tidak aman");
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Path relatif backup tidak aman: ${value}`);
  }
  if (segments.join("/") !== value)
    throw new Error(`Path relatif backup tidak canonical: ${value}`);
  return segments;
}

function ephemeralWhatsappPath(value) {
  return (
    isWorkspaceDataMarker(value) ||
    (!value.includes("/") &&
      (/^qr\.(?:png|json)(?:\.tmp-.*)?$/.test(value) ||
        /^status\.json(?:\.tmp-.*)?$/.test(value)))
  );
}

function validateUploadFileCoverage(tables, files) {
  const table = (name) =>
    tables.find((candidate) => candidate.name === name)?.rows ?? [];
  const uploads = table("uploads");
  const byId = new Map(uploads.map((row) => [String(row.id), row]));
  const byName = new Map(uploads.map((row) => [String(row.stored_name), row]));
  const jobs = table("queue_jobs");
  const jobById = new Map(jobs.map((row) => [String(row.id), row]));
  const expected = new Set();

  function addId(id, label) {
    const row = byId.get(String(id));
    if (!row) throw new Error(`${label} mereferensikan upload yang tidak ada`);
    expected.add(String(row.id));
  }
  function addPath(value, label) {
    if (typeof value !== "string" || value.length === 0) return false;
    if (value.includes("\0"))
      throw new Error(`${label} memiliki filePath dengan NUL`);
    const normalized = value.replaceAll("\\", "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const row = byName.get(name);
    if (!row)
      throw new Error(
        `${label} tidak memiliki metadata upload: ${name || "(kosong)"}`,
      );
    expected.add(String(row.id));
    return true;
  }

  for (const message of table("whatsapp_messages")) {
    if (
      message.direction !== "outbound" ||
      !RECOVERABLE_MESSAGE_STATUSES.includes(String(message.status))
    )
      continue;
    const media = asRecord(message.media);
    if (typeof media.uploadId === "string")
      addId(media.uploadId, `Pesan ${String(message.id)}`);
    if (typeof message.media_path === "string")
      addPath(message.media_path, `Pesan ${String(message.id)}`);
    const job = jobById.get(String(message.queue_job_id));
    const payload = asRecord(job?.payload);
    if (typeof payload.filePath === "string")
      addPath(payload.filePath, `Queue ${String(job?.id)}`);
  }
  for (const job of jobs) {
    if (
      job.queue_name !== "whatsapp-outbound" ||
      !RECOVERABLE_QUEUE_STATUSES.includes(String(job.status))
    )
      continue;
    const payload = asRecord(job.payload);
    const mediaJob = [
      "send-image",
      "send-document",
      "send-video",
      "send-audio",
      "whatsapp.send.image",
      "whatsapp.send.document",
      "whatsapp.send.video",
      "whatsapp.send.audio",
    ].includes(String(job.job_type));
    if (typeof payload.filePath === "string" && payload.filePath.length > 0)
      addPath(payload.filePath, `Queue ${String(job.id)}`);
    else if (
      mediaJob &&
      typeof payload.base64 === "string" &&
      payload.base64.length > 0
    ) {
      const inline = strictBase64Decode(
        payload.base64,
        `Queue ${String(job.id)} inline media`,
      );
      if (inline.length > limits.maxFileBytes)
        throw new Error(
          `Inline media queue ${String(job.id)} melewati BACKUP_MAX_FILE_BYTES`,
        );
    } else if (mediaJob) {
      throw new Error(
        `Queue media recoverable ${String(job.id)} tidak memiliki file/base64`,
      );
    }
  }

  const actual = new Set();
  for (const item of files.filter((candidate) => candidate.kind === "upload")) {
    const row = byId.get(item.uploadId);
    if (
      !row ||
      item.relativePath !== `uploads/${String(row.stored_name)}` ||
      Number(row.size_bytes) !== item.sizeBytes ||
      String(row.sha256) !== item.sha256
    ) {
      throw new Error(
        `Asset upload tidak cocok dengan row database: ${item.uploadId}`,
      );
    }
    actual.add(item.uploadId);
  }
  if (
    actual.size !== expected.size ||
    [...expected].some((id) => !actual.has(id))
  ) {
    throw new Error(
      "Artifact tidak memuat tepat semua upload media recoverable",
    );
  }
}

function collectUploadStoredNames(tables) {
  const uploads = tables.find((table) => table.name === "uploads")?.rows ?? [];
  const names = new Set();
  for (const row of uploads) {
    const storedName = row.stored_name;
    if (
      typeof storedName !== "string" ||
      storedName.length === 0 ||
      storedName.length > 255 ||
      storedName.includes("\0") ||
      storedName.includes("/") ||
      storedName.includes("\\") ||
      isWorkspaceDataMarker(storedName) ||
      storedName === "." ||
      storedName === ".."
    )
      throw new Error(`stored_name upload tidak aman: ${String(storedName)}`);
    names.add(storedName);
  }
  return names;
}

async function loadTargetMigrations(client) {
  const result = await client.query(
    "SELECT filename,checksum FROM schema_migrations ORDER BY filename",
  );
  const migrationsDirectory = join(workspaceRoot, "database", "migrations");
  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  if (filenames.length === 0)
    throw new Error("File migration target tidak ditemukan");
  const local = new Map();
  for (const filename of filenames) {
    const checksum = createHash("sha256")
      .update(await readFile(join(migrationsDirectory, filename)))
      .digest("hex");
    local.set(filename, checksum);
  }
  const applied = new Map(
    result.rows.map((row) => [row.filename, row.checksum]),
  );
  for (const [filename, checksum] of local) {
    if (!applied.has(filename))
      throw new Error(`Migration target belum diterapkan: ${filename}`);
    if (applied.get(filename) !== checksum)
      throw new Error(`Checksum file migration target berbeda: ${filename}`);
  }
  for (const row of result.rows) {
    if (!local.has(row.filename))
      throw new Error(
        `Migration database target tidak tersedia di workspace: ${row.filename}`,
      );
  }
  return result.rows;
}

async function inspectTargetSchema(client, tables) {
  const required = [...BACKUP_TABLE_NAMES, ...RESET_ON_RESTORE_TABLE_NAMES];
  const existence = await client.query(
    `SELECT requested.name,to_regclass('public.'||requested.name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS requested(name)`,
    [required],
  );
  const missing = existence.rows
    .filter((row) => !row.present)
    .map((row) => row.name);
  if (missing.length)
    throw new Error(`Tabel target tidak lengkap: ${missing.join(", ")}`);

  const externalReferences = await client.query(
    `SELECT child_namespace.nspname AS child_schema,child.relname AS child_table,
            parent_namespace.nspname AS parent_schema,parent.relname AS parent_table,constraint_row.conname
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS child ON child.oid=constraint_row.conrelid
       JOIN pg_namespace AS child_namespace ON child_namespace.oid=child.relnamespace
       JOIN pg_class AS parent ON parent.oid=constraint_row.confrelid
      JOIN pg_namespace AS parent_namespace ON parent_namespace.oid=parent.relnamespace
      WHERE constraint_row.contype='f'
        AND (
          (parent_namespace.nspname='public' AND parent.relname=ANY($1::text[])
           AND NOT (child_namespace.nspname='public' AND child.relname=ANY($1::text[])))
          OR
          (child_namespace.nspname='public' AND child.relname=ANY($1::text[])
           AND NOT (parent_namespace.nspname='public' AND parent.relname=ANY($1::text[])))
        )`,
    [[...BACKUP_TABLE_NAMES, ...RESET_ON_RESTORE_TABLE_NAMES]],
  );
  const incompatibleReference = externalReferences.rows.find(
    (reference) =>
      !(
        reference.child_schema === "public" &&
        reference.child_table === "backup_records" &&
        reference.parent_schema === "public" &&
        reference.parent_table === "admin_users" &&
        reference.conname === "backup_records_initiated_by_fkey"
      ),
  );
  if (incompatibleReference) {
    const reference = incompatibleReference;
    throw new Error(
      `Schema target tidak kompatibel: ${reference.child_schema}.${reference.child_table}.${reference.conname} mereferensikan ${reference.parent_schema}.${reference.parent_table} melintasi graph restore`,
    );
  }

  const internalReferences = await client.query(
    `SELECT child.relname AS child_table,parent.relname AS parent_table,constraint_row.conname,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum,position)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key_column.attnum
               ORDER BY key_column.position
            )::text[] AS child_columns
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS child ON child.oid=constraint_row.conrelid
       JOIN pg_namespace AS child_namespace ON child_namespace.oid=child.relnamespace
       JOIN pg_class AS parent ON parent.oid=constraint_row.confrelid
       JOIN pg_namespace AS parent_namespace ON parent_namespace.oid=parent.relnamespace
      WHERE constraint_row.contype='f'
        AND child_namespace.nspname='public' AND parent_namespace.nspname='public'
        AND child.relname=ANY($1::text[]) AND parent.relname=ANY($1::text[])`,
    [[...BACKUP_TABLE_NAMES, ...RESET_ON_RESTORE_TABLE_NAMES]],
  );
  const dependencyIndex = new Map(
    BACKUP_TABLE_NAMES.map((name, index) => [name, index]),
  );
  for (const reference of internalReferences.rows) {
    const childIndex = dependencyIndex.get(reference.child_table);
    const parentIndex = dependencyIndex.get(reference.parent_table);
    if (childIndex === undefined || parentIndex === undefined) {
      throw new Error(
        `Migration target menambah FK ke/dari tabel reset yang tidak dapat dipulihkan: ${reference.conname}`,
      );
    }
    if (childIndex < parentIndex) {
      throw new Error(
        `Migration target menambah FK di luar urutan manifest: ${reference.child_table}.${reference.conname}->${reference.parent_table}`,
      );
    }
    if (childIndex === parentIndex) {
      const manifest = BACKUP_TABLE_MANIFEST.find(
        (entry) => entry.name === reference.child_table,
      );
      const supportedColumns = new Set(
        (manifest?.deferredReferences ?? []).map((entry) => entry.column),
      );
      if (
        !Array.isArray(reference.child_columns) ||
        reference.child_columns.length !== 1 ||
        !supportedColumns.has(reference.child_columns[0])
      ) {
        throw new Error(
          `Migration target menambah self-FK tanpa kebijakan restore: ${reference.child_table}.${reference.conname}`,
        );
      }
    }
  }

  const schema = new Map();
  for (const table of tables) {
    const result = await client.query(
      `SELECT column_name,data_type,is_nullable,column_default,is_generated,is_identity,identity_generation
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position`,
      [table.name],
    );
    const metadata = new Map(
      result.rows.map((row) => [
        row.column_name,
        {
          dataType: row.data_type,
          nullable: row.is_nullable === "YES",
          defaultValue: row.column_default,
          generated: row.is_generated !== "NEVER",
          isIdentity: row.is_identity === "YES",
          identityGeneration: row.identity_generation,
        },
      ]),
    );
    for (const column of table.columns) {
      const target = metadata.get(column);
      if (!target || target.generated)
        throw new Error(
          `Kolom backup tidak kompatibel di target: ${table.name}.${column}`,
        );
    }
    const sourceColumns = new Set(table.columns);
    for (const [column, target] of metadata) {
      if (
        !target.generated &&
        !sourceColumns.has(column) &&
        !target.nullable &&
        target.defaultValue === null &&
        !target.isIdentity
      ) {
        throw new Error(
          `Migration target menambah kolom wajib tanpa default: ${table.name}.${column}`,
        );
      }
    }
    schema.set(table.name, metadata);
  }
  return schema;
}

function validateBinaryColumns(tables, targetSchema) {
  for (const table of tables) {
    const metadata = targetSchema.get(table.name);
    const binaryColumns = table.columns.filter(
      (column) => metadata.get(column)?.dataType === "bytea",
    );
    for (const row of table.rows) {
      for (const column of binaryColumns) {
        const revived = reviveValue(row[column]);
        if (!Buffer.isBuffer(revived))
          throw new Error(`BYTEA backup tidak valid: ${table.name}.${column}`);
      }
    }
  }
}

async function stageBackupFiles(files, root) {
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await syncDirectory(roots.dataRoot);
  await syncDirectory(root);
  for (const child of ["new", "original"]) {
    const directory = join(root, child);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(root);
    await syncDirectory(directory);
  }
  for (const item of files) {
    const content = strictBase64Decode(
      item.content,
      `File ${item.relativePath}`,
    );
    if (
      content.length !== item.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== item.sha256
    ) {
      throw new Error(`File berubah setelah preflight: ${item.relativePath}`);
    }
    const target = join(
      root,
      "new",
      ...safeRelativeSegments(item.relativePath),
    );
    await ensureSafeParent(join(root, "new"), dirname(target));
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function validateCurrentFileTargets(files) {
  const currentSessionFiles = await listSecureRegularFiles(
    roots.whatsappRoot,
    roots.whatsappRoot,
    "session WhatsApp",
  );
  const currentUploadFiles = await listSecureRegularFiles(
    roots.uploadsRoot,
    roots.uploadsRoot,
    "upload",
  );
  for (const target of currentSessionFiles) {
    safeRelativeSegments(
      `whatsapp/${relative(roots.whatsappRoot, target).split(sep).join("/")}`,
    );
  }
  for (const target of currentUploadFiles) {
    safeRelativeSegments(
      `uploads/${relative(roots.uploadsRoot, target).split(sep).join("/")}`,
    );
  }
  await assertNoFileDirectoryTopologyCollisions(
    currentSessionFiles,
    currentUploadFiles,
    files,
  );
  // Also validates that no incoming manifest path targets the preserved marker.
  for (const item of files) safeRelativeSegments(item.relativePath);
}

async function assertNoFileDirectoryTopologyCollisions(
  currentSessionFiles,
  currentUploadFiles,
  incomingFiles,
) {
  const currentPaths = new Set([
    ...currentSessionFiles.map(
      (path) =>
        `whatsapp/${relative(roots.whatsappRoot, path).split(sep).join("/")}`,
    ),
    ...currentUploadFiles.map(
      (path) =>
        `uploads/${relative(roots.uploadsRoot, path).split(sep).join("/")}`,
    ),
  ]);
  const incomingPaths = new Set(incomingFiles.map((item) => item.relativePath));
  for (const path of currentPaths) {
    for (const ancestor of pathAncestors(path)) {
      if (incomingPaths.has(ancestor))
        throw new Error(
          `Restore menolak konflik file/directory: incoming ${ancestor} adalah parent file target ${path}`,
        );
    }
  }
  for (const path of incomingPaths) {
    for (const ancestor of pathAncestors(path)) {
      if (currentPaths.has(ancestor))
        throw new Error(
          `Restore menolak konflik file/directory: file target ${ancestor} adalah parent incoming ${path}`,
        );
    }
    const target = join(roots.dataRoot, ...safeRelativeSegments(path));
    const info = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isDirectory())
      throw new Error(
        `Restore menolak mengganti directory target dengan file: ${path}`,
      );
  }
}

function pathAncestors(value) {
  const segments = safeRelativeSegments(value);
  const ancestors = [];
  for (let index = 1; index < segments.length; index += 1)
    ancestors.push(segments.slice(0, index).join("/"));
  return ancestors;
}

async function listSecureRegularFiles(
  directory,
  root,
  labelPrefix,
  found = [],
  scan = { entries: 0 },
) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const label = relative(root, path).split(sep).join("/");
    if (isWorkspaceDataMarker(label)) continue;
    scan.entries += 1;
    if (scan.entries > limits.maxFiles * 4 + 1_024)
      throw new Error(
        `Enumerasi ${labelPrefix} melewati batas aman berdasarkan BACKUP_MAX_FILES`,
      );
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error(`Symlink tidak diizinkan di ${labelPrefix}: ${label}`);
    if (info.isDirectory()) {
      if ((info.mode & 0o077) !== 0)
        throw new Error(`Directory ${labelPrefix} tidak owner-only: ${label}`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error(
          `Directory ${labelPrefix} bukan milik user aktif: ${label}`,
        );
      const resolvedDirectory = await realpath(path);
      if (!isInside(root, resolvedDirectory))
        throw new Error(`Directory ${labelPrefix} keluar dari root: ${label}`);
      await listSecureRegularFiles(path, root, labelPrefix, found, scan);
    } else if (info.isFile()) {
      if ((info.mode & 0o077) !== 0)
        throw new Error(`File ${labelPrefix} tidak owner-only: ${label}`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error(`File ${labelPrefix} bukan milik user aktif: ${label}`);
      const resolvedFile = await realpath(path);
      if (!isInside(root, resolvedFile))
        throw new Error(`File ${labelPrefix} keluar dari root: ${label}`);
      found.push(path);
      if (found.length > limits.maxFiles)
        throw new Error(
          `Jumlah file ${labelPrefix} melewati BACKUP_MAX_FILES=${limits.maxFiles}`,
        );
    } else {
      throw new Error(
        `Special file tidak diizinkan di ${labelPrefix}: ${label}`,
      );
    }
  }
  return found;
}

function reviveDatabaseRow(rawRow, columns, metadata, uploadStoredNames) {
  const row = {};
  for (const column of columns) {
    const value = rawRow[column];
    const dataType = metadata.get(column)?.dataType;
    row[column] =
      dataType === "bytea"
        ? reviveValue(value)
        : dataType === "json" || dataType === "jsonb"
          ? value === null
            ? null
            : JSON.stringify(value)
          : value;
  }
  if (row.queue_name === "whatsapp-outbound") {
    const payloadValue = asRecord(row.payload);
    if (
      typeof payloadValue.filePath === "string" &&
      payloadValue.filePath.length > 0
    ) {
      const normalized = payloadValue.filePath.replaceAll("\\", "/");
      const storedName = normalized.slice(normalized.lastIndexOf("/") + 1);
      if (uploadStoredNames.has(storedName)) {
        row.payload = {
          ...payloadValue,
          filePath: join(roots.uploadsRoot, storedName),
        };
      } else if (RECOVERABLE_QUEUE_STATUSES.includes(String(row.status))) {
        throw new Error(
          `Queue media recoverable tidak memiliki stored_name tervalidasi: ${String(row.id)}`,
        );
      } else {
        const portablePayload = { ...payloadValue };
        delete portablePayload.filePath;
        row.payload = portablePayload;
      }
    }
  }
  if (
    row.direction === "outbound" &&
    typeof row.media_path === "string" &&
    row.media_path.length > 0
  ) {
    const normalized = row.media_path.replaceAll("\\", "/");
    const storedName = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (uploadStoredNames.has(storedName)) {
      row.media_path = join(roots.uploadsRoot, storedName);
    } else if (RECOVERABLE_MESSAGE_STATUSES.includes(String(row.status))) {
      throw new Error(
        `Pesan media recoverable tidak memiliki stored_name tervalidasi: ${String(row.id)}`,
      );
    } else {
      row.media_path = null;
    }
  }
  return row;
}

async function restartIdentitySequencesTransactionally(client, targetSchema) {
  for (const [tableName, columns] of targetSchema) {
    for (const [columnName, metadata] of columns) {
      if (!metadata.isIdentity) continue;
      const sequenceResult = await client.query(
        `SELECT namespace.nspname AS schema_name,class.relname AS sequence_name,
                sequence.seqstart::text,sequence.seqincrement::text,
                sequence.seqmin::text,sequence.seqmax::text
           FROM pg_class AS class
           JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
           JOIN pg_sequence AS sequence ON sequence.seqrelid=class.oid
          WHERE class.oid=pg_get_serial_sequence($1,$2)::regclass`,
        [`public.${tableName}`, columnName],
      );
      const sequence = sequenceResult.rows[0];
      if (!sequence) continue;
      const increment = BigInt(sequence.seqincrement);
      const aggregate = increment > 0n ? "max" : "min";
      const extreme = await client.query(
        `SELECT ${aggregate}(${quoteIdentifier(columnName)})::text AS value FROM ${quoteIdentifier(tableName)}`,
      );
      const value = extreme.rows[0]?.value;
      const restart =
        value === null || value === undefined
          ? BigInt(sequence.seqstart)
          : BigInt(value) + increment;
      if (
        restart < BigInt(sequence.seqmin) ||
        restart > BigInt(sequence.seqmax)
      ) {
        throw new Error(
          `Sequence ${sequence.schema_name}.${sequence.sequence_name} kehabisan rentang saat restore`,
        );
      }
      await client.query(
        `ALTER SEQUENCE ${quoteIdentifier(sequence.schema_name)}.${quoteIdentifier(sequence.sequence_name)} RESTART WITH ${restart.toString()}`,
      );
    }
  }
}

async function applyPostRestoreSafety(client, restoredUploadNames) {
  await client.query(
    `UPDATE admin_refresh_tokens
        SET revoked_at=now(),revoke_reason='restore'`,
  );
  await client.query(
    `UPDATE uploads
        SET status='deleted'
      WHERE NOT (stored_name=ANY($1::text[]))`,
    [[...restoredUploadNames]],
  );
  await client.query(
    `UPDATE queue_jobs
        SET status='cancelled',attempts=LEAST(attempts,max_attempts),completed_at=now(),locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,
            last_error='Cancelled by workspace restore to prevent stale command replay',updated_at=now()
      WHERE queue_name IN ('maintenance','whatsapp-control')
        AND status IN ('pending','available','locked','processing','retrying')`,
  );
  await client.query(
    `UPDATE queue_jobs
        SET status='cancelled',attempts=LEAST(attempts,max_attempts),completed_at=now(),locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,
            last_error='Cancelled by workspace restore: queue contract is not recovery-allowlisted',updated_at=now()
      WHERE queue_name NOT IN ('maintenance','whatsapp-control','whatsapp-outbound','openclaw-events')
        AND status IN ('pending','available','locked','processing','retrying')`,
  );
  await client.query(
    `UPDATE queue_job_attempts AS attempt
        SET finished_at=COALESCE(finished_at,now()),outcome=COALESCE(outcome,'failed'),
            error_code=COALESCE(error_code,'RESTORE_CANCELLED'),
            error_message=COALESCE(error_message,'Command cancelled by workspace restore')
       FROM queue_jobs AS job
      WHERE attempt.job_id=job.id AND attempt.finished_at IS NULL AND job.status='cancelled'`,
  );
  await client.query(
    `WITH recovered AS (
       UPDATE queue_jobs
          SET status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'pending' END,
              available_at=now(),locked_at=NULL,locked_by=NULL,lock_expires_at=NULL,
              failed_at=CASE WHEN attempts>=max_attempts THEN COALESCE(failed_at,now()) ELSE failed_at END,
              last_error=COALESCE(last_error,'Processing lease reset by workspace restore'),updated_at=now()
        WHERE status IN ('locked','processing')
          AND queue_name IN ('whatsapp-outbound','openclaw-events')
       RETURNING id,status
     )
     UPDATE queue_job_attempts AS attempt
        SET finished_at=COALESCE(attempt.finished_at,now()),
            outcome=COALESCE(attempt.outcome,CASE WHEN recovered.status='dead_letter' THEN 'dead' ELSE 'retry' END),
            error_code=COALESCE(attempt.error_code,'RESTORE_LEASE_RESET'),
            error_message=COALESCE(attempt.error_message,'Processing lease reset by workspace restore')
       FROM recovered
      WHERE attempt.job_id=recovered.id AND attempt.finished_at IS NULL`,
  );
  await client.query(
    `UPDATE whatsapp_messages AS message
        SET status='failed',processing_state=CASE WHEN message.direction='inbound' THEN 'failed' ELSE message.processing_state END,
            error=COALESCE(job.last_error,message.error),updated_at=now()
       FROM queue_jobs AS job
      WHERE message.queue_job_id=job.id AND message.status='processing'
        AND job.status='cancelled'`,
  );
  await client.query(
    `UPDATE whatsapp_messages AS message
        SET status=CASE WHEN job.status='dead_letter' THEN 'dead_letter' ELSE 'retrying' END,
            processing_state=CASE WHEN message.direction='inbound'
                                  THEN CASE WHEN job.status='dead_letter' THEN 'failed' ELSE 'forward_queued' END
                                  ELSE message.processing_state END,
            error=COALESCE(job.last_error,message.error),updated_at=now()
       FROM queue_jobs AS job
      WHERE message.queue_job_id=job.id
        AND message.status='processing'
        AND job.queue_name IN ('whatsapp-outbound','openclaw-events')
        AND job.status IN ('pending','dead_letter')`,
  );
  await client.query(
    `UPDATE integration_outbox
        SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
            available_at=now(),last_error=COALESCE(last_error,'Processing lease reset by workspace restore'),updated_at=now()
      WHERE status='processing'`,
  );
}

async function activateBackupFiles(files, root, state) {
  const sessionFiles = await listSecureRegularFiles(
    roots.whatsappRoot,
    roots.whatsappRoot,
    "session WhatsApp",
  );
  const uploadFiles = await listSecureRegularFiles(
    roots.uploadsRoot,
    roots.uploadsRoot,
    "upload",
  );
  await assertNoFileDirectoryTopologyCollisions(
    sessionFiles,
    uploadFiles,
    files,
  );
  for (const target of sessionFiles) {
    const relativePath = `whatsapp/${relative(roots.whatsappRoot, target).split(sep).join("/")}`;
    await moveAside(target, relativePath, state);
  }
  for (const target of uploadFiles) {
    const relativePath = `uploads/${relative(roots.uploadsRoot, target).split(sep).join("/")}`;
    await moveAside(target, relativePath, state);
  }
  for (const item of files) {
    const target = join(
      roots.dataRoot,
      ...safeRelativeSegments(item.relativePath),
    );
    await ensureSafeParent(
      item.kind === "upload" ? roots.uploadsRoot : roots.whatsappRoot,
      dirname(target),
    );
    const staged = join(
      root,
      "new",
      ...safeRelativeSegments(item.relativePath),
    );
    await rename(staged, target);
    state.activated.push(target);
    await chmod(target, 0o600);
    await syncDirectory(dirname(target));
  }
}

async function moveAside(target, relativePath, state) {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Target restore bukan regular file: ${relativePath}`);
    const original = join(
      state.root,
      "original",
      ...safeRelativeSegments(relativePath),
    );
    await ensureSafeParent(join(state.root, "original"), dirname(original));
    await rename(target, original);
    state.originals.push({ target, original });
    await syncDirectory(dirname(target));
    await syncDirectory(dirname(original));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function ensureSafeParent(root, targetDirectory) {
  if (!isInside(root, targetDirectory))
    throw new Error("Parent target restore keluar dari root");
  const relativeDirectory = relative(root, targetDirectory);
  let current = root;
  for (const segment of relativeDirectory ? relativeDirectory.split(sep) : []) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Parent target restore tidak aman: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      await syncDirectory(dirname(current));
      await syncDirectory(current);
    }
    await chmod(current, 0o700);
  }
}

async function rollbackActivatedFiles(state) {
  for (const target of [...state.activated].reverse()) {
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Tidak dapat rollback target non-regular: ${target}`);
      await rm(target, { force: true });
      await syncDirectory(dirname(target));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const item of [...state.originals].reverse()) {
    const targetRoot = isInside(roots.whatsappRoot, item.target)
      ? roots.whatsappRoot
      : isInside(roots.uploadsRoot, item.target)
        ? roots.uploadsRoot
        : null;
    if (!targetRoot)
      throw new Error(`Target rollback keluar dari data roots: ${item.target}`);
    await ensureSafeParent(targetRoot, dirname(item.target));
    await rename(item.original, item.target);
    await syncDirectory(dirname(item.target));
  }
}

async function committedMarkerExists(sharedModule, appEnvironment, marker) {
  const pool = sharedModule.createDatabasePool(appEnvironment);
  try {
    const result = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM operational_logs
          WHERE event='backup.restore_committed' AND context->>'restoreOperationId'=$1
       ) AS committed`,
      [marker],
    );
    return result.rows[0]?.committed === true;
  } catch {
    throw new Error(
      "Status COMMIT restore tidak dapat dipastikan; file staging dipertahankan untuk recovery operator",
    );
  } finally {
    await pool.end();
  }
}

async function updateOperationStatus(
  sharedModule,
  appEnvironment,
  id,
  status,
  error,
) {
  const pool = sharedModule.createDatabasePool(appEnvironment);
  try {
    const result = await pool.query(
      `UPDATE backup_records
          SET status=$2,completed_at=now(),error=$3
        WHERE id=$1 AND operation='restore'
          AND (($2='completed' AND status='restoring')
            OR ($2='failed' AND status NOT IN ('completed','cancelled')))`,
      [id, status, error ? String(error).slice(0, 4_000) : null],
    );
    if (result.rowCount !== 1)
      throw new Error(`Status restore operation tidak dapat diperbarui: ${id}`);
  } finally {
    await pool.end();
  }
}

async function verifyLocalHealth() {
  const endpoints = [
    {
      label: "Gateway API",
      url: `http://127.0.0.1:${environment.GATEWAY_PORT || 3100}/health/ready`,
      expected: 200,
    },
    {
      label: "Baileys",
      url: `http://127.0.0.1:${environment.BAILEYS_HEALTH_PORT || 3101}/health/live`,
      expected: 200,
    },
    {
      label: "Dashboard",
      url: `http://127.0.0.1:${environment.DASHBOARD_PORT || 3200}/login`,
      expected: 200,
    },
  ];
  const failures = [];
  for (const endpoint of endpoints) {
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(endpoint.url, {
          redirect: "manual",
          signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.status === endpoint.expected) {
          healthy = true;
          break;
        }
      } catch {
        // Retry while workspace processes finish starting.
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    if (!healthy) failures.push(endpoint.label);
  }
  if (failures.length)
    throw new Error(`Health check pasca-restore gagal: ${failures.join(", ")}`);
}

async function safeRemoveStage(path) {
  const expectedPrefix = `${roots.dataRoot}${sep}.restore-stage-`;
  if (
    !path.startsWith(expectedPrefix) ||
    !uuidPattern.test(path.slice(expectedPrefix.length))
  ) {
    throw new Error(
      "Menolak menghapus staging restore dengan path tidak valid",
    );
  }
  await rm(path, { recursive: true, force: true });
  await syncDirectory(roots.dataRoot);
}

async function removeStageBeforeTerminal() {
  if (!stageRoot) return;
  if (preserveStage)
    throw new Error(
      "Staging restore wajib dipertahankan; journal tidak boleh dibuat terminal",
    );
  try {
    await safeRemoveStage(stageRoot);
    stageRoot = null;
  } catch (error) {
    preserveStage = true;
    recoveryStartSafe = false;
    throw new Error(
      `Staging restore tidak dapat dibersihkan sebelum journal terminal: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
