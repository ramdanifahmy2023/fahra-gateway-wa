import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptValue,
  encryptValue,
  enqueueJob,
  withTransaction,
} from "@ocgw/shared";
import { requireAdminReady } from "../security.js";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";

const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(100).optional(),
});

const reservedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  reservedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  reservedAddresses.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) return reservedAddresses.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 4) return reservedAddresses.check(address, "ipv4");
  if (family === 6) return reservedAddresses.check(address, "ipv6");
  return true;
}

function isLoopbackAddress(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) return mapped.startsWith("127.");
  if (isIP(address) === 4) return address.startsWith("127.");
  return (
    address.toLowerCase() === "::1" ||
    address.toLowerCase() === "0:0:0:0:0:0:0:1"
  );
}

function mappedIpv4Address(address: string): string | null {
  let normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const octets = normalized
      .slice(separator + 1)
      .split(".")
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    )
      return null;
    normalized = `${normalized.slice(0, separator + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const compressed = normalized.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed[1] ? compressed[1].split(":") : [];
  const missing = compressed.length === 2 ? 8 - left.length - right.length : 0;
  const groups =
    compressed.length === 2
      ? [...left, ...Array(Math.max(0, missing)).fill("0"), ...right]
      : left;
  if (
    (compressed.length === 2 && missing < 1) ||
    groups.length !== 8 ||
    groups.some((group) => !/^[a-f\d]{1,4}$/.test(group))
  )
    return null;
  const values = groups.map((group) => Number.parseInt(group, 16));
  if (values.slice(0, 5).some((value) => value !== 0) || values[5] !== 0xffff)
    return null;
  return `${values[6]! >> 8}.${values[6]! & 0xff}.${values[7]! >> 8}.${values[7]! & 0xff}`;
}

async function probeProvider(baseUrl: string, apiKey: string): Promise<number> {
  const url = new URL(
    "models",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(host);
  const addresses = await lookup(host, { all: true, verbatim: true });
  const blocked =
    !addresses.length ||
    addresses.some((item) =>
      loopbackHost
        ? !isLoopbackAddress(item.address)
        : isPrivateAddress(item.address),
    );
  if (blocked)
    throw new ApiError(
      422,
      "PROVIDER_ADDRESS_BLOCKED",
      "Provider resolve ke alamat private/reserved yang tidak diizinkan",
    );
  const selected = addresses[0]!;
  return new Promise<number>((resolve, reject) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        ...(url.protocol === "https:" ? { servername: host } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      },
    );
    request.setTimeout(10_000, () =>
      request.destroy(new Error("Provider timeout")),
    );
    request.once("error", reject);
    request.end();
  });
}

async function getById(
  app: FastifyInstance,
  table: string,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await app.context.db.query(
    `SELECT * FROM ${table} WHERE id=$1`,
    [id],
  );
  if (!result.rows[0])
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "Data tidak ditemukan");
  return result.rows[0] as Record<string, unknown>;
}

export async function registerCatalogRoutes(
  app: FastifyInstance,
): Promise<void> {
  const knowledgeSchema = z.object({
    title: z.string().min(1).max(250),
    category: z.string().min(1).max(100),
    content: z.string().min(1).max(500_000),
    enabled: z.boolean().default(true),
    revision: z.number().int().optional(),
  });
  app.get(
    "/api/v1/knowledge",
    { preHandler: requireAdminReady },
    async (request) => {
      const query = listQuery.parse(request.query);
      const values: unknown[] = [];
      const where = query.search
        ? (values.push(`%${query.search}%`),
          `WHERE title ILIKE $1 OR category ILIKE $1 OR content ILIKE $1`)
        : "";
      values.push(query.limit, (query.page - 1) * query.limit);
      const result = await app.context.db.query(
        `SELECT *,count(*) OVER()::int total FROM knowledge_items ${where} ORDER BY updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return {
        data: result.rows.map(({ total: _total, ...row }) => row),
        meta: { ...query, total: Number(result.rows[0]?.total ?? 0) },
      };
    },
  );
  app.post(
    "/api/v1/knowledge",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = knowledgeSchema.parse(request.body);
      const id = randomUUID();
      const result = await withTransaction(app.context.db, async (client) => {
        const inserted = await client.query(
          `INSERT INTO knowledge_items(id,title,category,content,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [id, input.title, input.category, input.content, input.enabled],
        );
        await writeAudit(client, request, {
          action: "knowledge.created",
          resourceType: "knowledge_item",
          resourceId: id,
        });
        return inserted;
      });
      return reply.code(201).send({ data: result.rows[0] });
    },
  );
  app.get(
    "/api/v1/knowledge/:id",
    { preHandler: requireAdminReady },
    async (request) => ({
      data: await getById(
        app,
        "knowledge_items",
        idParam.parse(request.params).id,
      ),
    }),
  );
  app.put(
    "/api/v1/knowledge/:id",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const input = knowledgeSchema.parse(request.body);
      const result = await withTransaction(app.context.db, async (client) => {
        const updated = await client.query(
          `UPDATE knowledge_items SET title=$2,category=$3,content=$4,enabled=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND ($6::int IS NULL OR revision=$6) RETURNING *`,
          [
            id,
            input.title,
            input.category,
            input.content,
            input.enabled,
            input.revision ?? null,
          ],
        );
        if (!updated.rows[0])
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Data berubah atau tidak ditemukan",
          );
        await writeAudit(client, request, {
          action: "knowledge.updated",
          resourceType: "knowledge_item",
          resourceId: id,
        });
        return updated;
      });
      return { data: result.rows[0] };
    },
  );
  app.delete(
    "/api/v1/knowledge/:id",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await withTransaction(app.context.db, async (client) => {
        const result = await client.query(
          "DELETE FROM knowledge_items WHERE id=$1 RETURNING id",
          [id],
        );
        if (!result.rows[0])
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "Data tidak ditemukan");
        await writeAudit(client, request, {
          action: "knowledge.deleted",
          resourceType: "knowledge_item",
          resourceId: id,
        });
      });
      return reply.code(204).send();
    },
  );

  const toolSchema = z
    .object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).default(""),
      endpoint: z.url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      secretConfig: z.record(z.string(), z.string()).optional(),
      secret: z.string().max(5000).optional(),
      enabled: z.boolean().default(true),
      revision: z.number().int().optional(),
    })
    .transform((value) => ({
      ...value,
      secretConfig:
        value.secretConfig ??
        (value.secret ? { secret: value.secret } : undefined),
    }));
  app.get("/api/v1/tools", { preHandler: requireAdminReady }, async () => ({
    data: (
      await app.context.db.query(
        `SELECT id,name,description,endpoint,method,enabled,(config_encrypted IS NOT NULL) AS "hasSecretConfig",revision,created_at,updated_at FROM agent_tools ORDER BY name`,
      )
    ).rows,
  }));
  app.post(
    "/api/v1/tools",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = toolSchema.parse(request.body);
      const id = randomUUID();
      const encrypted = input.secretConfig
        ? encryptValue(
            input.secretConfig,
            app.context.env.SESSION_ENCRYPTION_KEY,
            `agent-tool:${id}`,
          )
        : null;
      const result = await withTransaction(app.context.db, async (client) => {
        const inserted = await client.query(
          `INSERT INTO agent_tools(id,name,description,endpoint,method,config_encrypted,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,description,endpoint,method,enabled,revision,created_at,updated_at`,
          [
            id,
            input.name,
            input.description,
            input.endpoint,
            input.method,
            encrypted,
            input.enabled,
          ],
        );
        await writeAudit(client, request, {
          action: "tool.created",
          resourceType: "agent_tool",
          resourceId: id,
        });
        return inserted;
      });
      return reply.code(201).send({ data: result.rows[0] });
    },
  );
  app.put(
    "/api/v1/tools/:id",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const input = toolSchema.parse(request.body);
      const encrypted = input.secretConfig
        ? encryptValue(
            input.secretConfig,
            app.context.env.SESSION_ENCRYPTION_KEY,
            `agent-tool:${id}`,
          )
        : undefined;
      const result = await withTransaction(app.context.db, async (client) => {
        const updated = await client.query(
          `UPDATE agent_tools SET name=$2,description=$3,endpoint=$4,method=$5,config_encrypted=COALESCE($6,config_encrypted),enabled=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND ($8::int IS NULL OR revision=$8) RETURNING id,name,description,endpoint,method,enabled,(config_encrypted IS NOT NULL) AS "hasSecretConfig",revision,created_at,updated_at`,
          [
            id,
            input.name,
            input.description,
            input.endpoint,
            input.method,
            encrypted ?? null,
            input.enabled,
            input.revision ?? null,
          ],
        );
        if (!updated.rows[0])
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Data berubah atau tidak ditemukan",
          );
        await writeAudit(client, request, {
          action: "tool.updated",
          resourceType: "agent_tool",
          resourceId: id,
        });
        return updated;
      });
      return { data: result.rows[0] };
    },
  );
  app.delete(
    "/api/v1/tools/:id",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await withTransaction(app.context.db, async (client) => {
        const result = await client.query(
          "DELETE FROM agent_tools WHERE id=$1 RETURNING id",
          [id],
        );
        if (!result.rows[0])
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "Data tidak ditemukan");
        await writeAudit(client, request, {
          action: "tool.deleted",
          resourceType: "agent_tool",
          resourceId: id,
        });
      });
      return reply.code(204).send();
    },
  );

  const jobSchema = z.object({
    name: z.string().min(1).max(120),
    instruction: z.string().min(1).max(100_000),
    schedule: z.string().max(120).nullable().optional(),
    enabled: z.boolean().default(true),
    revision: z.number().int().optional(),
  });
  app.get("/api/v1/jobs", { preHandler: requireAdminReady }, async () => ({
    data: (await app.context.db.query("SELECT * FROM agent_jobs ORDER BY name"))
      .rows,
  }));
  app.post(
    "/api/v1/jobs",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = jobSchema.parse(request.body);
      const id = randomUUID();
      const result = await withTransaction(app.context.db, async (client) => {
        const inserted = await client.query(
          `INSERT INTO agent_jobs(id,name,instruction,schedule,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [
            id,
            input.name,
            input.instruction,
            input.schedule ?? null,
            input.enabled,
          ],
        );
        await writeAudit(client, request, {
          action: "job.created",
          resourceType: "agent_job",
          resourceId: id,
        });
        return inserted;
      });
      return reply.code(201).send({ data: result.rows[0] });
    },
  );
  app.put(
    "/api/v1/jobs/:id",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const input = jobSchema.parse(request.body);
      const result = await withTransaction(app.context.db, async (client) => {
        const updated = await client.query(
          `UPDATE agent_jobs SET name=$2,instruction=$3,schedule=$4,enabled=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND ($6::int IS NULL OR revision=$6) RETURNING *`,
          [
            id,
            input.name,
            input.instruction,
            input.schedule ?? null,
            input.enabled,
            input.revision ?? null,
          ],
        );
        if (!updated.rows[0])
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Data berubah atau tidak ditemukan",
          );
        await writeAudit(client, request, {
          action: "job.updated",
          resourceType: "agent_job",
          resourceId: id,
        });
        return updated;
      });
      return { data: result.rows[0] };
    },
  );
  app.delete(
    "/api/v1/jobs/:id",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await withTransaction(app.context.db, async (client) => {
        const result = await client.query(
          "DELETE FROM agent_jobs WHERE id=$1 RETURNING id",
          [id],
        );
        if (!result.rows[0])
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "Data tidak ditemukan");
        await writeAudit(client, request, {
          action: "job.deleted",
          resourceType: "agent_job",
          resourceId: id,
        });
      });
      return reply.code(204).send();
    },
  );
  app.post(
    "/api/v1/jobs/:id/run",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const queueId = await withTransaction(app.context.db, async (client) => {
        const exists = await client.query(
          "SELECT id FROM agent_jobs WHERE id=$1 FOR SHARE",
          [id],
        );
        if (!exists.rows[0])
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "Job tidak ditemukan");
        const jobId = await enqueueJob(client, {
          queue: "openclaw-events",
          type: "run-job",
          payload: { jobId: id, requestedBy: request.admin?.id },
          dedupeKey: `run-job:${id}:${Math.floor(Date.now() / 1000)}`,
        });
        await client.query(
          "UPDATE agent_jobs SET last_run_at=now(),last_status='queued',updated_at=now() WHERE id=$1",
          [id],
        );
        await writeAudit(client, request, {
          action: "job.run",
          resourceType: "agent_job",
          resourceId: id,
        });
        return jobId;
      });
      return reply
        .code(202)
        .send({ data: { jobId: id, queueJobId: queueId, status: "queued" } });
    },
  );

  const providerUrl = z.url().refine(
    (value) => {
      const url = new URL(value);
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const transportAllowed =
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(host));
      return (
        transportAllowed &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    },
    {
      message:
        "Base URL harus HTTPS (atau HTTP loopback) tanpa credential, query, atau fragment",
    },
  );
  const providerSchema = z
    .object({
      name: z.string().min(1).max(120),
      providerType: z
        .enum(["9router", "openrouter", "openai-compatible"])
        .default("openai-compatible"),
      baseUrl: providerUrl,
      apiKey: z.string().min(1).max(1000).optional(),
      model: z.string().min(1).max(200),
      temperature: z.number().min(0).max(2).default(0.7),
      maxTokens: z.number().int().min(1).max(1_000_000).default(4096),
      isActive: z.boolean().optional(),
      enabled: z.boolean().optional(),
      revision: z.number().int().optional(),
    })
    .transform((value) => ({
      ...value,
      isActive: value.isActive ?? value.enabled ?? false,
    }));
  app.get(
    "/api/v1/ai-providers",
    { preHandler: requireAdminReady },
    async () => ({
      data: (
        await app.context.db.query(
          `SELECT id,name,provider_type AS "providerType",base_url AS "baseUrl",model,temperature,max_tokens AS "maxTokens",is_active AS "isActive",(api_key_encrypted IS NOT NULL) AS "hasApiKey",revision,created_at,updated_at FROM ai_providers ORDER BY name`,
        )
      ).rows,
    }),
  );
  app.post(
    "/api/v1/ai-providers",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const input = providerSchema.parse(request.body);
      const id = randomUUID();
      const encrypted = input.apiKey
        ? encryptValue(
            input.apiKey,
            app.context.env.SESSION_ENCRYPTION_KEY,
            `ai-provider:${id}`,
          )
        : null;
      const result = await withTransaction(app.context.db, async (client) => {
        if (input.isActive) {
          await client.query("SELECT pg_advisory_xact_lock($1)", [712_209_449]);
          await client.query(
            "UPDATE ai_providers SET is_active=false,updated_at=now()",
          );
        }
        const inserted = await client.query(
          `INSERT INTO ai_providers(id,name,provider_type,base_url,api_key_encrypted,model,temperature,max_tokens,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,provider_type AS "providerType",base_url AS "baseUrl",model,temperature,max_tokens AS "maxTokens",is_active AS "isActive",revision`,
          [
            id,
            input.name,
            input.providerType,
            input.baseUrl,
            encrypted,
            input.model,
            input.temperature,
            input.maxTokens,
            input.isActive,
          ],
        );
        await writeAudit(client, request, {
          action: "provider.created",
          resourceType: "ai_provider",
          resourceId: id,
        });
        return inserted;
      });
      return reply.code(201).send({ data: result.rows[0] });
    },
  );
  app.put(
    "/api/v1/ai-providers/:id",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const input = providerSchema.parse(request.body);
      const encrypted = input.apiKey
        ? encryptValue(
            input.apiKey,
            app.context.env.SESSION_ENCRYPTION_KEY,
            `ai-provider:${id}`,
          )
        : undefined;
      const result = await withTransaction(app.context.db, async (client) => {
        if (input.isActive)
          await client.query("SELECT pg_advisory_xact_lock($1)", [712_209_449]);
        const current = await client.query<{ base_url: string }>(
          "SELECT base_url FROM ai_providers WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (!current.rows[0])
          throw new ApiError(
            404,
            "RESOURCE_NOT_FOUND",
            "Provider tidak ditemukan",
          );
        if (
          new URL(current.rows[0].base_url).origin !==
            new URL(input.baseUrl).origin &&
          !input.apiKey
        )
          throw new ApiError(
            422,
            "PROVIDER_KEY_REQUIRED",
            "Perubahan origin provider wajib menyertakan ulang API key",
          );
        if (input.isActive)
          await client.query(
            "UPDATE ai_providers SET is_active=false,updated_at=now() WHERE id<>$1",
            [id],
          );
        const updated = await client.query(
          `UPDATE ai_providers SET name=$2,provider_type=$3,base_url=$4,api_key_encrypted=COALESCE($5,api_key_encrypted),model=$6,temperature=$7,max_tokens=$8,is_active=$9,revision=revision+1,updated_at=now() WHERE id=$1 AND ($10::int IS NULL OR revision=$10) RETURNING id,name,provider_type AS "providerType",base_url AS "baseUrl",model,temperature,max_tokens AS "maxTokens",is_active AS "isActive",revision`,
          [
            id,
            input.name,
            input.providerType,
            input.baseUrl,
            encrypted ?? null,
            input.model,
            input.temperature,
            input.maxTokens,
            input.isActive,
            input.revision ?? null,
          ],
        );
        if (!updated.rows[0])
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Data berubah saat diperbarui",
          );
        await writeAudit(client, request, {
          action: "provider.updated",
          resourceType: "ai_provider",
          resourceId: id,
        });
        return updated;
      });
      return { data: result.rows[0] };
    },
  );
  app.delete(
    "/api/v1/ai-providers/:id",
    { preHandler: requireAdminReady },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await withTransaction(app.context.db, async (client) => {
        const result = await client.query(
          "DELETE FROM ai_providers WHERE id=$1 RETURNING id",
          [id],
        );
        if (!result.rows[0])
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "Data tidak ditemukan");
        await writeAudit(client, request, {
          action: "provider.deleted",
          resourceType: "ai_provider",
          resourceId: id,
        });
      });
      return reply.code(204).send();
    },
  );
  app.post(
    "/api/v1/ai-providers/:id/test",
    { preHandler: requireAdminReady },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const row = await app.context.db.query<{
        base_url: string;
        api_key_encrypted: string | null;
      }>("SELECT base_url,api_key_encrypted FROM ai_providers WHERE id=$1", [
        id,
      ]);
      const provider = row.rows[0];
      if (!provider)
        throw new ApiError(
          404,
          "RESOURCE_NOT_FOUND",
          "Provider tidak ditemukan",
        );
      providerUrl.parse(provider.base_url);
      const apiKey = provider.api_key_encrypted
        ? decryptValue<string>(
            provider.api_key_encrypted,
            app.context.env.SESSION_ENCRYPTION_KEY,
            `ai-provider:${id}`,
          )
        : "";
      try {
        const status = await probeProvider(provider.base_url, apiKey);
        return {
          data: {
            ok: status >= 200 && status < 300,
            status,
            latencyCheckedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        return {
          data: {
            ok: false,
            error: error instanceof Error ? error.message : "connection failed",
          },
        };
      }
    },
  );
}
