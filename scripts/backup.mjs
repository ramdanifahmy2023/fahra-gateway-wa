import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  backupLimitsFromEnvironment,
  assertKeyConfirmation,
  boundedBackupPageRows,
  createKeyConfirmation,
  decodeBackup,
  encodeBinaryValue,
  encodeBackup,
  strictBase64Decode,
} from "./lib/backup-format.mjs";
import {
  BACKUP_TABLE_MANIFEST,
  RECOVERABLE_MESSAGE_STATUSES,
  RECOVERABLE_QUEUE_STATUSES,
  createBackupManifestDescriptor,
  isWorkspaceDataMarker,
  normalizeSchemaMigrations,
  validateBackupManifestDescriptor,
  validatePayloadTables,
} from "./lib/backup-manifest.mjs";
import { assertNotSuspiciousEmptyBackup } from "./lib/backup-safety.mjs";
import {
  assertSessionAffineDatabaseUrl,
  managedConfigurationKeys,
  parseEnv,
  readRestoreHandoff,
  workspaceRoot,
} from "./lib/common.mjs";

process.umask(0o077);
const environment = parseEnv(await readPrivateWorkspaceEnv());
// Maintenance workers intentionally receive compatibility-only secrets. The
// workspace file is authoritative for backup/session key continuity.
for (const key of managedConfigurationKeys) delete process.env[key];
for (const [key, value] of Object.entries(environment))
  process.env[key] = value;
await assertNoActiveRestoreJournal("sebelum backup dimulai");

const shared = await import(
  pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
);
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
assertSessionAffineDatabaseUrl(
  env.DATABASE_URL,
  environment.DATABASE_POOL_MODE,
);
const limits = backupLimitsFromEnvironment(environment);
const db = shared.createDatabasePool(env);
const cliArguments = process.argv.slice(2);
const backupIdOptions = cliArguments.filter((value) =>
  value.startsWith("--backup-id="),
);
if (backupIdOptions.length > 1)
  throw new Error("Argumen --backup-id tidak boleh duplikat");
for (const argument of cliArguments) {
  if (argument === "--safety" || argument.startsWith("--backup-id=")) continue;
  throw new Error(`Argumen backup tidak dikenal: ${argument}`);
}
const requestedBackupId = backupIdOptions[0]?.slice("--backup-id=".length);
if (backupIdOptions.length === 1 && !requestedBackupId)
  throw new Error("Nilai --backup-id tidak boleh kosong");
if (cliArguments.filter((value) => value === "--safety").length > 1)
  throw new Error("Argumen --safety tidak boleh duplikat");
const safety = cliArguments.includes("--safety");
if (safety && requestedBackupId)
  throw new Error("--safety dan --backup-id tidak boleh digunakan bersama");
const backupId = requestedBackupId ?? (safety ? null : randomUUID());
const createDirectOperation = !requestedBackupId && !safety;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (backupId && !uuidPattern.test(backupId))
  throw new Error("--backup-id wajib UUID valid");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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

async function assertNoActiveRestoreJournal(phase) {
  const journal = await readRestoreHandoff({ optional: true });
  if (journal) {
    throw new Error(
      `Backup ditolak ${phase}: restore journal ${journal.operationId} phase ${journal.phase} masih aktif`,
    );
  }
}

function serializedRow(row, tableName) {
  const serialized = JSON.stringify(row);
  if (Buffer.byteLength(serialized, "utf8") > limits.maxRowBytes) {
    throw new Error(
      `Row ${tableName} melewati BACKUP_MAX_ROW_BYTES=${limits.maxRowBytes}`,
    );
  }
  return {
    row: JSON.parse(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

async function prepareDataRoots() {
  const workspaceReal = await realpath(workspaceRoot);
  const dataPath = resolve(env.dataDir);
  if (!isInside(workspaceRoot, dataPath)) {
    throw new Error("DATA_DIR backup wajib berada di dalam workspace project");
  }
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
  const dataReal = await realpath(dataPath);
  if (!isInside(workspaceReal, dataReal))
    throw new Error("Realpath DATA_DIR keluar dari workspace");
  return {
    dataRoot: dataReal,
    whatsappRoot: await secureDirectory(join(dataReal, "whatsapp"), dataReal),
    uploadsRoot: await secureDirectory(join(dataReal, "uploads"), dataReal),
    backupsRoot: await secureDirectory(join(dataReal, "backups"), dataReal),
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
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} melewati directory tidak aman: ${current}`);
    }
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

async function readSecureFile(root, candidate, label) {
  const lexical = resolve(candidate);
  if (!isInside(root, lexical))
    throw new Error(`${label} keluar dari root data yang diizinkan`);
  const linkInfo = await lstat(lexical);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile())
    throw new Error(`${label} bukan regular file non-symlink`);
  if ((linkInfo.mode & 0o077) !== 0)
    throw new Error(`${label} wajib owner-only`);
  if (
    typeof process.getuid === "function" &&
    linkInfo.uid !== process.getuid()
  ) {
    throw new Error(`${label} bukan milik user aktif`);
  }
  const resolved = await realpath(lexical);
  if (!isInside(root, resolved))
    throw new Error(`${label} realpath keluar dari root data`);
  const handle = await open(
    lexical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limits.maxFileBytes) {
      throw new Error(
        `${label} bukan file atau melewati BACKUP_MAX_FILE_BYTES=${limits.maxFileBytes}`,
      );
    }
    if (before.dev !== linkInfo.dev || before.ino !== linkInfo.ino) {
      throw new Error(`${label} berubah saat dibuka`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      content.length !== before.size
    )
      throw new Error(`${label} berubah saat dibaca`);
    return {
      content,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function dumpTable(client, tableName, budget) {
  const columnsResult = await client.query(
    `SELECT column_name,data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER'
      ORDER BY ordinal_position`,
    [tableName],
  );
  const columns = columnsResult.rows.map((row) => row.column_name);
  const binaryColumns = new Set(
    columnsResult.rows
      .filter((row) => row.data_type === "bytea")
      .map((row) => row.column_name),
  );
  if (columns.length === 0)
    throw new Error(
      `Tabel manifest tidak ditemukan atau tanpa kolom: ${tableName}`,
    );
  const countResult = await client.query(
    `SELECT count(*)::text AS total,
            COALESCE(max(octet_length(row_to_json(source_row)::text)),0)::text AS max_row_bytes
       FROM ${quoteIdentifier(tableName)} AS source_row`,
  );
  const count = Number(countResult.rows[0]?.total);
  const serverMaxRowBytes = Number(countResult.rows[0]?.max_row_bytes);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > limits.maxTableRows
  ) {
    throw new Error(
      `Tabel ${tableName} memiliki ${String(countResult.rows[0]?.total)} row; batas ${limits.maxTableRows}`,
    );
  }
  if (
    !Number.isSafeInteger(serverMaxRowBytes) ||
    serverMaxRowBytes < 0 ||
    serverMaxRowBytes > limits.maxRowBytes
  ) {
    throw new Error(
      `Row ${tableName} memiliki estimasi JSON server ${String(countResult.rows[0]?.max_row_bytes)} byte; batas ${limits.maxRowBytes}`,
    );
  }
  budget.totalRows += count;
  if (budget.totalRows > limits.maxTotalRows) {
    throw new Error(
      `Total row backup melewati BACKUP_MAX_TOTAL_ROWS=${limits.maxTotalRows}`,
    );
  }

  const rows = [];
  const projection = columns.map(quoteIdentifier).join(",");
  const pageRows = boundedBackupPageRows(limits, serverMaxRowBytes || 1);
  const cursorName = `backup_${tableName}`;
  await client.query(
    `DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR FOR
     SELECT ${projection} FROM ${quoteIdentifier(tableName)} ORDER BY ctid`,
  );
  try {
    for (;;) {
      const page = await client.query(
        `FETCH FORWARD ${pageRows} FROM ${quoteIdentifier(cursorName)}`,
      );
      if (page.rows.length === 0) break;
      for (const value of page.rows) {
        const portable = { ...value };
        for (const column of binaryColumns) {
          if (!Buffer.isBuffer(portable[column]))
            throw new Error(
              `BYTEA source tidak berupa Buffer: ${tableName}.${column}`,
            );
          portable[column] = encodeBinaryValue(
            portable[column],
            `${tableName}.${column}`,
          );
        }
        const encoded = serializedRow(portable, tableName);
        budget.estimatedClearBytes += encoded.bytes + 2;
        if (budget.estimatedClearBytes > limits.maxClearBytes) {
          throw new Error(
            `Estimasi payload backup melewati BACKUP_MAX_CLEAR_BYTES=${limits.maxClearBytes}`,
          );
        }
        rows.push(encoded.row);
      }
    }
  } finally {
    await client
      .query(`CLOSE ${quoteIdentifier(cursorName)}`)
      .catch(() => undefined);
  }
  return { name: tableName, columns, rows };
}

async function loadValidatedSchemaMigrations(client) {
  const result = await client.query(
    "SELECT filename,checksum FROM schema_migrations ORDER BY filename",
  );
  const schemaMigrations = normalizeSchemaMigrations(result.rows, "source");
  const migrationsDirectory = join(workspaceRoot, "database", "migrations");
  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  if (filenames.length === 0)
    throw new Error("File migration workspace tidak ditemukan");
  const local = new Map();
  for (const filename of filenames) {
    local.set(
      filename,
      createHash("sha256")
        .update(await readFile(join(migrationsDirectory, filename)))
        .digest("hex"),
    );
  }
  const applied = new Map(
    schemaMigrations.map((row) => [row.filename, row.checksum]),
  );
  for (const [filename, checksum] of local) {
    if (!applied.has(filename))
      throw new Error(`Migration workspace belum diterapkan: ${filename}`);
    if (applied.get(filename) !== checksum)
      throw new Error(`Checksum migration workspace berbeda: ${filename}`);
  }
  for (const row of schemaMigrations) {
    if (!local.has(row.filename))
      throw new Error(
        `Migration database tidak tersedia di workspace: ${row.filename}`,
      );
  }
  return schemaMigrations;
}

function tableRows(tables, name) {
  const table = tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Dump tabel tidak ditemukan: ${name}`);
  return table.rows;
}

function referencedUploadIds(tables, uploadsRoot) {
  const uploads = tableRows(tables, "uploads");
  const uploadsById = new Map(uploads.map((row) => [String(row.id), row]));
  const uploadsByStoredName = new Map(
    uploads.map((row) => [String(row.stored_name), row]),
  );
  const queueJobs = tableRows(tables, "queue_jobs");
  const queueById = new Map(queueJobs.map((row) => [String(row.id), row]));
  const selected = new Set();

  function addById(id, label) {
    const row = uploadsById.get(String(id));
    if (!row)
      throw new Error(
        `${label} mereferensikan upload yang tidak ada: ${String(id)}`,
      );
    selected.add(String(row.id));
  }

  function addByPath(pathValue, label) {
    if (typeof pathValue !== "string" || pathValue.length === 0) return false;
    if (pathValue.includes("\0"))
      throw new Error(`${label} memiliki filePath dengan NUL`);
    const normalized = pathValue.replaceAll("\\", "/");
    const storedName = normalized.slice(normalized.lastIndexOf("/") + 1);
    const row = uploadsByStoredName.get(storedName);
    if (!row)
      throw new Error(
        `${label} tidak memiliki metadata upload untuk ${storedName || "(kosong)"}`,
      );
    const referencedPath = isAbsolute(pathValue)
      ? resolve(pathValue)
      : resolve(uploadsRoot, pathValue);
    const expectedPath = join(uploadsRoot, storedName);
    if (
      referencedPath !== expectedPath ||
      !isInside(uploadsRoot, referencedPath)
    )
      throw new Error(
        `${label} memiliki filePath di luar upload workspace: ${pathValue}`,
      );
    selected.add(String(row.id));
    return true;
  }

  for (const message of tableRows(tables, "whatsapp_messages")) {
    if (
      message.direction !== "outbound" ||
      !RECOVERABLE_MESSAGE_STATUSES.includes(String(message.status))
    )
      continue;
    const media = asRecord(message.media);
    if (typeof media.uploadId === "string")
      addById(media.uploadId, `Pesan ${String(message.id)}`);
    if (typeof message.media_path === "string")
      addByPath(message.media_path, `Pesan ${String(message.id)}`);
    const job = queueById.get(String(message.queue_job_id));
    const payload = asRecord(job?.payload);
    if (typeof payload.filePath === "string")
      addByPath(payload.filePath, `Queue ${String(job?.id)}`);
  }

  for (const job of queueJobs) {
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
    const hasFile =
      typeof payload.filePath === "string" && payload.filePath.length > 0;
    const hasInline =
      typeof payload.base64 === "string" && payload.base64.length > 0;
    if (hasFile) addByPath(payload.filePath, `Queue ${String(job.id)}`);
    else if (mediaJob && hasInline) {
      const inline = strictBase64Decode(
        payload.base64,
        `Queue ${String(job.id)} inline media`,
      );
      if (inline.length > limits.maxFileBytes)
        throw new Error(
          `Inline media queue ${String(job.id)} melewati BACKUP_MAX_FILE_BYTES`,
        );
    } else if (mediaJob)
      throw new Error(
        `Queue media recoverable ${String(job.id)} tidak memiliki file/base64`,
      );
  }
  return { selected, uploadsById };
}

function ephemeralWhatsappFile(relativePath) {
  return (
    isWorkspaceDataMarker(relativePath) ||
    (!relativePath.includes("/") &&
      (/^qr\.(?:png|json)(?:\.tmp-.*)?$/.test(relativePath) ||
        /^status\.json(?:\.tmp-.*)?$/.test(relativePath)))
  );
}

async function collectSessionFiles(whatsappRoot, fileBudget) {
  const files = [];
  let scannedEntries = 0;
  async function walk(directory, segments) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const childSegments = [...segments, entry.name];
      const relativePath = childSegments.join("/");
      if (entry.name.includes("\\") || relativePath.length > 1_000) {
        throw new Error(`Nama/path session tidak portable: ${relativePath}`);
      }
      if (ephemeralWhatsappFile(relativePath)) continue;
      scannedEntries += 1;
      if (scannedEntries > limits.maxFiles * 4 + 1_024)
        throw new Error(
          "Enumerasi session melewati batas aman berdasarkan BACKUP_MAX_FILES",
        );
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error(
          `Symlink tidak diizinkan di data/whatsapp: ${relativePath}`,
        );
      if (info.isDirectory()) {
        if ((info.mode & 0o077) !== 0)
          throw new Error(
            `Directory session wajib owner-only: ${relativePath}`,
          );
        if (
          typeof process.getuid === "function" &&
          info.uid !== process.getuid()
        )
          throw new Error(
            `Directory session bukan milik user aktif: ${relativePath}`,
          );
        const resolvedDirectory = await realpath(path);
        if (!isInside(whatsappRoot, resolvedDirectory))
          throw new Error(
            `Directory session keluar dari root: ${relativePath}`,
          );
        await walk(path, childSegments);
        continue;
      }
      if (!info.isFile())
        throw new Error(
          `Special file tidak diizinkan di data/whatsapp: ${relativePath}`,
        );
      const value = await readSecureFile(
        whatsappRoot,
        path,
        `Session ${relativePath}`,
      );
      addFileBudget(fileBudget, value.sizeBytes);
      files.push({
        kind: "whatsapp-session",
        relativePath: `whatsapp/${relativePath}`,
        mode: 0o600,
        sizeBytes: value.sizeBytes,
        sha256: value.sha256,
        content: value.content.toString("base64"),
      });
    }
  }
  await walk(whatsappRoot, []);
  return files;
}

async function collectUploadFiles(uploadsRoot, tables, fileBudget) {
  const { selected, uploadsById } = referencedUploadIds(tables, uploadsRoot);
  const files = [];
  for (const id of [...selected].sort()) {
    const row = uploadsById.get(id);
    const storedName = String(row.stored_name ?? "");
    if (
      !storedName ||
      storedName !== basename(storedName) ||
      storedName.includes("\0") ||
      storedName.includes("\\") ||
      isWorkspaceDataMarker(storedName) ||
      storedName.length > 255
    ) {
      throw new Error(
        `stored_name upload tidak aman: ${storedName || "(kosong)"}`,
      );
    }
    const value = await readSecureFile(
      uploadsRoot,
      join(uploadsRoot, storedName),
      `Upload ${id}`,
    );
    const databaseSize = Number(row.size_bytes);
    if (
      !Number.isSafeInteger(databaseSize) ||
      databaseSize !== value.sizeBytes
    ) {
      throw new Error(`Ukuran file upload ${id} tidak cocok dengan database`);
    }
    if (String(row.sha256) !== value.sha256)
      throw new Error(`SHA-256 file upload ${id} tidak cocok dengan database`);
    addFileBudget(fileBudget, value.sizeBytes);
    files.push({
      kind: "upload",
      uploadId: id,
      relativePath: `uploads/${storedName}`,
      mode: 0o600,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
      content: value.content.toString("base64"),
    });
  }
  return files;
}

function addFileBudget(budget, sizeBytes) {
  budget.count += 1;
  budget.totalBytes += sizeBytes;
  if (budget.count > limits.maxFiles)
    throw new Error(
      `Jumlah file backup melewati BACKUP_MAX_FILES=${limits.maxFiles}`,
    );
  if (budget.totalBytes > limits.maxTotalFileBytes) {
    throw new Error(
      `Total file backup melewati BACKUP_MAX_TOTAL_FILE_BYTES=${limits.maxTotalFileBytes}`,
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

async function readExistingArtifact(backupsRoot, filename) {
  if (
    !filename ||
    filename !== basename(filename) ||
    !filename.endsWith(".ocgwb")
  )
    throw new Error("Filename backup_records tidak aman");
  const path = join(backupsRoot, filename);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(`Artifact existing tidak aman: ${filename}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(`Artifact existing bukan milik user aktif: ${filename}`);
  if (info.size > limits.maxArtifactBytes)
    throw new Error(
      `Artifact existing melewati BACKUP_MAX_ARTIFACT_BYTES: ${filename}`,
    );
  const resolved = await realpath(path);
  if (!isInside(backupsRoot, resolved))
    throw new Error(`Artifact existing keluar dari data/backups: ${filename}`);
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
    )
      throw new Error(`Artifact existing berubah saat dibuka: ${filename}`);
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
      throw new Error(`Artifact existing berubah saat dibaca: ${filename}`);
    return {
      filename,
      path: resolved,
      content,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function validateOwnedArtifact(artifact, expectedBackupId) {
  const payload = await decodeBackup(
    artifact.content,
    env.BACKUP_ENCRYPTION_KEY,
    limits,
  );
  if (
    payload.product !== "OpenClaw WhatsApp Gateway" ||
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt))
  )
    throw new Error(
      `Identitas/timestamp artifact tidak valid: ${artifact.filename}`,
    );
  validateBackupManifestDescriptor(payload.manifest);
  if (!payload.keyConfirmations || typeof payload.keyConfirmations !== "object")
    throw new Error(
      `Konfirmasi kunci artifact tidak valid: ${artifact.filename}`,
    );
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
  validatePayloadTables(payload.tables);
  normalizeSchemaMigrations(payload.schemaMigrations, "artifact");
  let totalRows = 0;
  for (const table of payload.tables) {
    if (table.rows.length > limits.maxTableRows)
      throw new Error(
        `Artifact ${artifact.filename} melewati batas row per tabel`,
      );
    totalRows += table.rows.length;
  }
  if (totalRows > limits.maxTotalRows)
    throw new Error(`Artifact ${artifact.filename} melewati batas total row`);
  if (payload.backupId !== expectedBackupId)
    throw new Error(
      `Artifact ${artifact.filename} bukan milik backup operation ${expectedBackupId}`,
    );
  if (!Array.isArray(payload.files) || payload.files.length > limits.maxFiles)
    throw new Error(
      `Artifact ${artifact.filename} tidak memiliki file manifest`,
    );
  let totalFileBytes = 0;
  for (const item of payload.files) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.content !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      item.sizeBytes > limits.maxFileBytes
    )
      throw new Error(
        `File manifest artifact tidak valid: ${artifact.filename}`,
      );
    const content = strictBase64Decode(
      item.content,
      `Artifact ${artifact.filename} file`,
    );
    if (
      content.length !== item.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== item.sha256
    )
      throw new Error(
        `File checksum artifact tidak valid: ${artifact.filename}`,
      );
    totalFileBytes += content.length;
    if (totalFileBytes > limits.maxTotalFileBytes)
      throw new Error(
        `Artifact ${artifact.filename} melewati batas total file`,
      );
  }
  if (
    !payload.stats ||
    payload.stats.totalFiles !== payload.files.length ||
    Number(payload.stats.totalFileBytes) !== totalFileBytes
  )
    throw new Error(`Statistik artifact tidak valid: ${artifact.filename}`);
}

async function cleanOwnedTemporaryArtifacts(backupsRoot, canonicalFilename) {
  const prefix = `${canonicalFilename}.tmp-`;
  let removed = false;
  for (const name of await readdir(backupsRoot)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(backupsRoot, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error(
        `Temporary artifact milik operation bukan file owner-only: ${name}`,
      );
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(`Temporary artifact bukan milik user aktif: ${name}`);
    await rm(path);
    removed = true;
  }
  if (removed) await syncDirectory(backupsRoot);
}

async function prepareBackupOperation(client, backupsRoot, id) {
  const canonicalFilename = `openclaw-gateway-${id}.ocgwb`;
  await client.query("BEGIN");
  try {
    const result = await client.query(
      `SELECT id,operation,filename,status,format_version,artifact_path,encrypted,size_bytes,checksum
         FROM backup_records WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const record = result.rows[0];
    if (!record || record.operation !== "backup")
      throw new Error(`backup_records operation backup tidak ditemukan: ${id}`);

    await cleanOwnedTemporaryArtifacts(backupsRoot, canonicalFilename);
    if (record.status === "completed") {
      if (
        record.format_version !== 2 ||
        record.filename !== canonicalFilename ||
        record.artifact_path !== canonicalFilename ||
        record.encrypted !== true
      )
        throw new Error(
          `Metadata completed backup tidak canonical/terenkripsi: ${id}`,
        );
      const artifact = await readExistingArtifact(backupsRoot, record.filename);
      if (
        Number(record.size_bytes) !== artifact.sizeBytes ||
        record.checksum !== artifact.sha256
      )
        throw new Error(
          `Metadata/checksum completed backup tidak cocok: ${id}`,
        );
      await validateOwnedArtifact(artifact, id);
      await client.query("COMMIT");
      return artifact;
    }

    try {
      const artifact = await readExistingArtifact(
        backupsRoot,
        canonicalFilename,
      );
      await validateOwnedArtifact(artifact, id);
      await client.query(
        `UPDATE backup_records
            SET filename=$2,status='completed',format_version=2,artifact_path=$2,encrypted=true,size_bytes=$3,checksum=$4,
                completed_at=now(),error=NULL
          WHERE id=$1`,
        [id, canonicalFilename, artifact.sizeBytes, artifact.sha256],
      );
      await client.query("COMMIT");
      return artifact;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    await client.query(
      `UPDATE backup_records
          SET filename=$2,status='running',format_version=2,artifact_path=NULL,encrypted=true,size_bytes=NULL,checksum=NULL,
              started_at=now(),completed_at=NULL,error=NULL
        WHERE id=$1`,
      [id, canonicalFilename],
    );
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const roots = await prepareDataRoots();
const client = await db.connect();
let transactionOpen = false;
let temporaryArtifact = null;
let operationLockHeld = false;
let operationCompleted = false;
let lifecycleSharedLockHeld = false;
let migrationSharedLockHeld = false;
try {
  let reusedArtifact = null;
  if (backupId) {
    if (createDirectOperation) {
      await client.query(
        `INSERT INTO backup_records(id,operation,filename,status,created_at,started_at)
         VALUES($1,'backup',$2,'queued',now(),now())`,
        [backupId, `pending-${backupId}.ocgwb`],
      );
    }
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      `openclaw-gateway-backup:${backupId}`,
    ]);
    operationLockHeld = true;
    reusedArtifact = await prepareBackupOperation(
      client,
      roots.backupsRoot,
      backupId,
    );
    operationCompleted = Boolean(reusedArtifact);
  }
  if (reusedArtifact) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, reused: true, backupId, filename: reusedArtifact.filename, path: reusedArtifact.path, sizeBytes: reusedArtifact.sizeBytes, sha256: reusedArtifact.sha256 })}\n`,
    );
  } else {
    // Restore owns the same key exclusively during downtime/file activation;
    // migrations own 712209441 exclusively. Shared locks make the DB and
    // session/upload generation one coherent snapshot without blocking other
    // backups.
    await client.query("SELECT pg_advisory_lock_shared($1)", [712_209_443]);
    lifecycleSharedLockHeld = true;
    await assertNoActiveRestoreJournal("setelah lifecycle lock diperoleh");
    await client.query("SELECT pg_advisory_lock_shared($1)", [712_209_441]);
    migrationSharedLockHeld = true;
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transactionOpen = true;
    await client.query(
      `LOCK TABLE ${BACKUP_TABLE_MANIFEST.map((entry) => quoteIdentifier(entry.name)).join(",")}
       IN SHARE MODE`,
    );
    await assertNotSuspiciousEmptyBackup({
      client,
      safety,
      baselinePath: join(workspaceRoot, "data/state/boot-baseline.json"),
    });
    const budget = { totalRows: 0, estimatedClearBytes: 64 * 1024 };
    const tables = [];
    for (const entry of BACKUP_TABLE_MANIFEST)
      tables.push(await dumpTable(client, entry.name, budget));

    const schemaMigrations = await loadValidatedSchemaMigrations(client);
    const fileBudget = { count: 0, totalBytes: 0 };
    const sessionFiles = await collectSessionFiles(
      roots.whatsappRoot,
      fileBudget,
    );
    const uploadFiles = await collectUploadFiles(
      roots.uploadsRoot,
      tables,
      fileBudget,
    );
    const files = [...sessionFiles, ...uploadFiles];
    budget.estimatedClearBytes += files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8") + 512,
      0,
    );
    if (budget.estimatedClearBytes > limits.maxClearBytes) {
      throw new Error(
        `Estimasi payload backup melewati BACKUP_MAX_CLEAR_BYTES=${limits.maxClearBytes}`,
      );
    }

    const createdAt = new Date().toISOString();
    const payload = {
      format: "OCGWB1",
      product: "OpenClaw WhatsApp Gateway",
      version: "1.0.0",
      createdAt,
      host: hostname(),
      backupId: backupId ?? null,
      manifest: createBackupManifestDescriptor(),
      keyConfirmations: {
        whatsappSession: createKeyConfirmation(
          env.WHATSAPP_SESSION_ENCRYPTION_KEY,
          "whatsapp-session",
        ),
        applicationSecrets: createKeyConfirmation(
          env.SESSION_ENCRYPTION_KEY,
          "application-secrets",
        ),
      },
      schemaMigrations,
      tables,
      files,
      stats: {
        totalRows: budget.totalRows,
        totalFiles: fileBudget.count,
        totalFileBytes: fileBudget.totalBytes,
      },
    };
    await client.query("COMMIT");
    transactionOpen = false;

    const encoded = await encodeBackup(
      payload,
      env.BACKUP_ENCRYPTION_KEY,
      limits,
    );
    const filename = backupId
      ? `openclaw-gateway-${backupId}.ocgwb`
      : `${safety ? "safety-" : "openclaw-gateway-"}${timestamp()}-${randomUUID()}.ocgwb`;
    const destination = join(roots.backupsRoot, filename);
    try {
      await stat(destination);
      throw new Error(`Artifact backup sudah ada: ${filename}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    temporaryArtifact = `${destination}.tmp-${process.pid}`;
    const handle = await open(temporaryArtifact, "wx", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryArtifact, destination);
    await rm(temporaryArtifact);
    temporaryArtifact = null;
    await chmod(destination, 0o600);
    await syncDirectory(roots.backupsRoot);
    const checksum = createHash("sha256").update(encoded).digest("hex");
    if (backupId) {
      const completed = await client.query(
        `UPDATE backup_records
          SET filename=$2,status='completed',format_version=2,size_bytes=$3,checksum=$4,artifact_path=$2,encrypted=true,
              completed_at=now(),error=NULL
        WHERE id=$1`,
        [backupId, filename, encoded.length, checksum],
      );
      if (completed.rowCount !== 1)
        throw new Error(
          `backup_records operation hilang sebelum completion: ${backupId}`,
        );
      operationCompleted = true;
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, backupId, filename, path: destination, sizeBytes: encoded.length, sha256: checksum })}\n`,
    );
  }
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  if (temporaryArtifact)
    await rm(temporaryArtifact, { force: true }).catch(() => undefined);
  if (backupId && !operationCompleted) {
    await client
      .query(
        `UPDATE backup_records SET status='failed',error=$2,completed_at=now() WHERE id=$1`,
        [
          backupId,
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            4_000,
          ),
        ],
      )
      .catch(() => undefined);
  }
  throw error;
} finally {
  if (migrationSharedLockHeld)
    await client
      .query("SELECT pg_advisory_unlock_shared($1)", [712_209_441])
      .catch(() => undefined);
  if (lifecycleSharedLockHeld)
    await client
      .query("SELECT pg_advisory_unlock_shared($1)", [712_209_443])
      .catch(() => undefined);
  if (operationLockHeld)
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `openclaw-gateway-backup:${backupId}`,
      ])
      .catch(() => undefined);
  client.release();
  await db.end();
}
