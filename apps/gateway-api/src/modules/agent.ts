import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTransaction } from "@ocgw/shared";
import { requireAdminReady } from "../security.js";
import { writeAudit } from "../audit.js";
import { ApiError } from "../errors.js";

const profileSchema = z.object({
  name: z.string().min(1).max(120),
  persona: z.string().max(50_000).default(""),
  jobdesk: z.string().max(50_000).default(""),
  systemInstruction: z.string().max(100_000).default(""),
  revision: z.number().int().min(1).optional(),
});

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  const getProfile = async () => {
    const result = await app.context.db.query(
      `SELECT id,name,persona,jobdesk,system_instruction AS "systemInstruction",revision,created_at,updated_at
       FROM agent_profile ORDER BY created_at LIMIT 1`,
    );
    return { data: result.rows[0] ?? null };
  };
  app.get(
    "/api/v1/agent-profile",
    { preHandler: requireAdminReady },
    getProfile,
  );
  app.get(
    "/api/v1/agent/profile",
    { preHandler: requireAdminReady },
    getProfile,
  );

  const putProfile = async (request: FastifyRequest) => {
    const input = profileSchema.parse(request.body);
    const updated = await withTransaction(app.context.db, async (client) => {
      const current = await client.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM agent_profile ORDER BY created_at LIMIT 1 FOR UPDATE",
      );
      const row = current.rows[0];
      if (row && input.revision && row.revision !== input.revision) {
        throw new ApiError(
          409,
          "REVISION_CONFLICT",
          "Profil telah berubah; muat ulang sebelum menyimpan",
        );
      }
      const result = row
        ? await client.query(
            `UPDATE agent_profile SET name=$2,persona=$3,jobdesk=$4,system_instruction=$5,revision=revision+1,updated_at=now()
             WHERE id=$1 RETURNING id,name,persona,jobdesk,system_instruction AS "systemInstruction",revision,created_at,updated_at`,
            [
              row.id,
              input.name,
              input.persona,
              input.jobdesk,
              input.systemInstruction,
            ],
          )
        : await client.query(
            `INSERT INTO agent_profile(name,persona,jobdesk,system_instruction)
             VALUES($1,$2,$3,$4) RETURNING id,name,persona,jobdesk,system_instruction AS "systemInstruction",revision,created_at,updated_at`,
            [input.name, input.persona, input.jobdesk, input.systemInstruction],
          );
      const profile = result.rows[0]!;
      await writeAudit(client, request, {
        action: row ? "agent_profile.updated" : "agent_profile.created",
        resourceType: "agent_profile",
        resourceId: String(profile.id),
      });
      return profile;
    });
    return { data: updated };
  };
  app.put(
    "/api/v1/agent-profile",
    { preHandler: requireAdminReady },
    putProfile,
  );
  app.put(
    "/api/v1/agent/profile",
    { preHandler: requireAdminReady },
    putProfile,
  );
}
