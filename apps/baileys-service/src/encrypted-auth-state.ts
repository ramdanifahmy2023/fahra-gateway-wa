import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { Pool, PoolClient } from "pg";

import { decryptEnvelope, encryptEnvelope } from "./crypto-envelope.js";
import { quoteIdentifier } from "./sql-identifier.js";

type SignalKeyType = keyof SignalDataTypeMap;

interface KeyWrite {
  readonly recordKey: string;
  readonly value: unknown;
}

export interface EncryptedBaileysAuthState {
  readonly createSocketState: () => EncryptedBaileysAuthEpoch;
  readonly saveCreds: (authEpoch: EncryptedBaileysAuthEpoch) => Promise<void>;
  readonly invalidate: (authEpoch?: EncryptedBaileysAuthEpoch) => void;
  readonly clear: () => Promise<void>;
}

export interface EncryptedBaileysAuthEpoch {
  readonly epoch: number;
  readonly state: AuthenticationState;
}

export class PostgresEncryptedAuthStore {
  readonly #table: string;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly pool: Pool,
    tableName: string,
    private readonly scope: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.#table = quoteIdentifier(tableName);
  }

  public async read<T>(recordKey: string): Promise<T | undefined> {
    // Never observe the store midway through a queued clear/key transaction.
    await this.mutationTail;
    const result = await this.pool.query<{ value_encrypted: Buffer }>(
      `SELECT value_encrypted FROM ${this.#table} WHERE scope = $1 AND key = $2`,
      [this.scope, recordKey],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    const plaintext = decryptEnvelope(
      row.value_encrypted,
      this.encryptionKey,
      this.aad(recordKey),
    );
    return JSON.parse(plaintext.toString("utf8"), BufferJSON.reviver) as T;
  }

  public async write(recordKey: string, value: unknown): Promise<void> {
    await this.writeMany([{ recordKey, value }]);
  }

  public async writeMany(writes: readonly KeyWrite[]): Promise<void> {
    if (writes.length === 0) {
      return;
    }
    return this.enqueueMutation(() => this.writeManyNow(writes));
  }

  public async clear(): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.pool.query(`DELETE FROM ${this.#table} WHERE scope = $1`, [
        this.scope,
      ]);
    });
  }

  private async writeManyNow(writes: readonly KeyWrite[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const write of writes) {
        if (write.value === null || write.value === undefined) {
          await this.deleteWithClient(client, write.recordKey);
        } else {
          await this.upsertWithClient(client, write.recordKey, write.value);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation);
    // Keep the serializer usable after a failed database mutation while still
    // returning the original rejection to its caller.
    this.mutationTail = result.catch(() => undefined);
    return result;
  }

  private async upsertWithClient(
    client: PoolClient,
    recordKey: string,
    value: unknown,
  ): Promise<void> {
    const serialized = Buffer.from(
      JSON.stringify(value, BufferJSON.replacer),
      "utf8",
    );
    const encrypted = encryptEnvelope(
      serialized,
      this.encryptionKey,
      this.aad(recordKey),
    );
    await client.query(
      `INSERT INTO ${this.#table} (scope, key, value_encrypted, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (scope, key)
       DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()`,
      [this.scope, recordKey, encrypted],
    );
  }

  private async deleteWithClient(
    client: PoolClient,
    recordKey: string,
  ): Promise<void> {
    await client.query(
      `DELETE FROM ${this.#table} WHERE scope = $1 AND key = $2`,
      [this.scope, recordKey],
    );
  }

  private aad(recordKey: string): string {
    return `openclaw-wa-auth\u0000${this.scope}\u0000${recordKey}\u0000v1`;
  }
}

export async function createEncryptedAuthState(
  store: PostgresEncryptedAuthStore,
): Promise<EncryptedBaileysAuthState> {
  let currentCreds =
    (await store.read<AuthenticationState["creds"]>("creds")) ??
    initAuthCreds();
  let currentEpoch = 0;

  const createKeys = (epoch: number): AuthenticationState["keys"] => ({
    get: async <T extends SignalKeyType>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      if (epoch !== currentEpoch) return result;
      for (const id of ids) {
        let value = await store.read<SignalDataTypeMap[T]>(keyRecord(type, id));
        if (epoch !== currentEpoch) return {};
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(
            value as unknown as Record<string, unknown>,
          ) as unknown as SignalDataTypeMap[T];
        }
        if (value !== undefined) {
          result[id] = value;
        }
      }
      return result;
    },
    set: async (data) => {
      if (epoch !== currentEpoch) return;
      const writes: KeyWrite[] = [];
      for (const type of Object.keys(data) as SignalKeyType[]) {
        const values = data[type];
        if (!values) {
          continue;
        }
        for (const [id, value] of Object.entries(values)) {
          writes.push({ recordKey: keyRecord(type, id), value });
        }
      }
      if (epoch !== currentEpoch) return;
      await store.writeMany(writes);
    },
  });

  return {
    createSocketState: () => {
      const epoch = ++currentEpoch;
      const creds = cloneWithBufferJson(currentCreds);
      currentCreds = creds;
      return { epoch, state: { creds, keys: createKeys(epoch) } };
    },
    saveCreds: async (authEpoch) => {
      if (authEpoch.epoch !== currentEpoch) return;
      currentCreds = authEpoch.state.creds;
      await store.write("creds", currentCreds);
    },
    invalidate: (authEpoch) => {
      if (!authEpoch || authEpoch.epoch === currentEpoch) {
        currentEpoch += 1;
      }
    },
    clear: async () => {
      currentEpoch += 1;
      currentCreds = initAuthCreds();
      await store.clear();
    },
  };
}

function keyRecord(type: SignalKeyType, id: string): string {
  return `key:${type}:${id}`;
}

function cloneWithBufferJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, BufferJSON.replacer),
    BufferJSON.reviver,
  ) as T;
}
