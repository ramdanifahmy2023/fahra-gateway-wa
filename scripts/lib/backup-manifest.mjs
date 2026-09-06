const manifestVersion = 3;

/**
 * Dependency order is also the restore insertion order. Keep queue_jobs before
 * whatsapp_messages: whatsapp_messages.queue_job_id is a real foreign key.
 */
export const BACKUP_TABLE_MANIFEST = Object.freeze(
  [
    { name: "admin_users" },
    {
      name: "admin_refresh_tokens",
      deferredReferences: Object.freeze([
        { column: "replaced_by", primaryKey: "id" },
      ]),
    },
    { name: "admin_login_attempts" },
    { name: "internal_api_keys" },
    { name: "agent_profile" },
    { name: "knowledge_items" },
    { name: "agent_tools" },
    { name: "agent_jobs" },
    { name: "ai_providers" },
    { name: "app_settings" },
    { name: "whatsapp_connection" },
    { name: "whatsapp_auth_state" },
    { name: "whatsapp_connection_events" },
    { name: "whatsapp_groups" },
    { name: "whatsapp_group_participants" },
    { name: "uploads" },
    { name: "queue_jobs" },
    { name: "queue_job_attempts" },
    {
      name: "whatsapp_messages",
      deferredReferences: Object.freeze([
        { column: "reply_to_message_id", primaryKey: "id" },
      ]),
    },
    { name: "message_delivery_events" },
    { name: "integration_outbox" },
    { name: "openclaw_responses" },
    { name: "contact_memory" },
    { name: "crm_config_state" },
    { name: "crm_tags" },
    { name: "crm_contact_tags" },
    { name: "crm_internal_notes" },
    { name: "audit_logs" },
    { name: "operational_logs" },
  ].map((entry) => Object.freeze({ ...entry })),
);

/**
 * These tables deliberately never enter an artifact. The policy states
 * whether target-local state is reset or preserved by restore.
 */
export const EXCLUDED_TABLE_POLICY = Object.freeze([
  Object.freeze({
    name: "runtime_instances",
    reason:
      "Ephemeral process heartbeats must be recreated by the new runtime.",
    restorePolicy: "truncate",
  }),
  Object.freeze({
    name: "backup_records",
    reason:
      "Artifact/operation history belongs to the target workspace and must be preserved, not imported.",
    restorePolicy: "preserve",
  }),
]);

export const BACKUP_MANIFEST_VERSION = manifestVersion;
export const BACKUP_TABLE_NAMES = Object.freeze(
  BACKUP_TABLE_MANIFEST.map((entry) => entry.name),
);
export const RESET_ON_RESTORE_TABLE_NAMES = Object.freeze(
  EXCLUDED_TABLE_POLICY.filter(
    (entry) => entry.restorePolicy === "truncate",
  ).map((entry) => entry.name),
);

export const RECOVERABLE_MESSAGE_STATUSES = Object.freeze([
  "queued",
  "processing",
  "retrying",
  "failed",
  "dead",
  "dead_letter",
]);

export const RECOVERABLE_QUEUE_STATUSES = Object.freeze([
  "pending",
  "available",
  "locked",
  "processing",
  "retrying",
  "failed",
  "dead",
  "dead_letter",
]);

/** Repository marker only; it is never application state or an upload. */
export function isWorkspaceDataMarker(relativePath) {
  return relativePath === ".gitkeep";
}

export function createBackupManifestDescriptor() {
  return {
    version: manifestVersion,
    tables: BACKUP_TABLE_MANIFEST.map((entry) => ({
      name: entry.name,
      deferredReferences: (entry.deferredReferences ?? []).map((reference) => ({
        ...reference,
      })),
    })),
    excludedTables: EXCLUDED_TABLE_POLICY.map((entry) => ({ ...entry })),
  };
}

export function validateBackupManifestDescriptor(value) {
  if (!isRecord(value) || value.version !== manifestVersion) {
    throw new Error(
      `Versi manifest backup tidak didukung: ${isRecord(value) ? String(value.version) : "missing"}`,
    );
  }
  const expected = createBackupManifestDescriptor();
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(
      "Manifest tabel backup tidak cocok dengan kontrak restore versi ini",
    );
  }
  return expected;
}

export function validatePayloadTables(value) {
  if (!Array.isArray(value) || value.length !== BACKUP_TABLE_NAMES.length) {
    throw new Error(
      `Backup wajib memuat tepat ${BACKUP_TABLE_NAMES.length} tabel durable`,
    );
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const table = value[index];
    const expectedName = BACKUP_TABLE_NAMES[index];
    if (!isRecord(table) || table.name !== expectedName) {
      throw new Error(
        `Urutan tabel backup tidak valid pada posisi ${index + 1}; diharapkan ${expectedName}`,
      );
    }
    if (seen.has(table.name))
      throw new Error(`Tabel backup duplikat: ${table.name}`);
    seen.add(table.name);
    if (
      !Array.isArray(table.columns) ||
      table.columns.length === 0 ||
      table.columns.some(
        (column) =>
          typeof column !== "string" || !/^[a-z_][a-z0-9_]*$/.test(column),
      )
    ) {
      throw new Error(`Daftar kolom backup tidak valid: ${table.name}`);
    }
    if (new Set(table.columns).size !== table.columns.length) {
      throw new Error(`Kolom backup duplikat: ${table.name}`);
    }
    if (!Array.isArray(table.rows))
      throw new Error(`Rows backup bukan array: ${table.name}`);
  }
  return value;
}

export function normalizeSchemaMigrations(value, label = "backup") {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Daftar schema migration ${label} kosong atau tidak valid`);
  }
  const normalized = [];
  const seen = new Set();
  for (const row of value) {
    if (
      !isRecord(row) ||
      typeof row.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(row.filename) ||
      typeof row.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.checksum)
    ) {
      throw new Error(`Metadata schema migration ${label} tidak valid`);
    }
    if (seen.has(row.filename))
      throw new Error(`Schema migration ${label} duplikat: ${row.filename}`);
    seen.add(row.filename);
    normalized.push({ filename: row.filename, checksum: row.checksum });
  }
  return normalized;
}

/**
 * Restore is intentionally exact-schema. A target superset can add types,
 * domains, constraints, or triggers that reject old rows only after downtime;
 * filename/checksum inclusion alone cannot prove that graph compatible.
 */
export function assertMigrationCompatibility(sourceValue, targetValue) {
  const source = normalizeSchemaMigrations(sourceValue, "backup");
  const target = normalizeSchemaMigrations(targetValue, "target");
  const targetByName = new Map(
    target.map((row) => [row.filename, row.checksum]),
  );
  for (const row of source) {
    const targetChecksum = targetByName.get(row.filename);
    if (targetChecksum === undefined) {
      throw new Error(
        `Target belum memiliki migration backup: ${row.filename}`,
      );
    }
    if (targetChecksum !== row.checksum) {
      throw new Error(`Checksum migration berbeda untuk ${row.filename}`);
    }
  }
  if (target.length !== source.length) {
    throw new Error(
      `Jumlah migration target (${target.length}) wajib sama dengan backup (${source.length}); jalankan upgrade terpisah setelah restore`,
    );
  }
  return {
    sourceCount: source.length,
    targetCount: target.length,
    targetIsSuperset: false,
  };
}

export function manifestEntry(name) {
  const entry = BACKUP_TABLE_MANIFEST.find(
    (candidate) => candidate.name === name,
  );
  if (!entry) throw new Error(`Tabel tidak terdapat dalam manifest: ${name}`);
  return entry;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
