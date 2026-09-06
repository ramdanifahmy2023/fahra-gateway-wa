import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "./lib/common.mjs";

const shared = await import(
  pathToFileURL(join(workspaceRoot, "packages/shared/dist/index.js")).href
);
const argon = await import("@node-rs/argon2");
const env = shared.loadEnvironment({ fresh: true, root: workspaceRoot });
const db = shared.createDatabasePool(env);
try {
  const existing = await db.query(
    "SELECT id,password_hash FROM admin_users WHERE lower(email)=lower($1)",
    [env.BOOTSTRAP_ADMIN_EMAIL],
  );
  if (existing.rows[0]?.password_hash) {
    process.stdout.write(
      "Admin bootstrap sudah tersedia; password tidak diubah.\n",
    );
  } else {
    const passwordHash = await argon.hash(env.BOOTSTRAP_ADMIN_PASSWORD, {
      algorithm: argon.Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });
    if (existing.rows[0]) {
      await db.query(
        `UPDATE admin_users SET password_hash=$2,status='active',is_active=true,force_password_change=true,password_initialized_at=now(),updated_at=now() WHERE id=$1`,
        [existing.rows[0].id, passwordHash],
      );
    } else {
      await db.query(
        `INSERT INTO admin_users(id,email,password_hash,status,is_active,force_password_change,password_initialized_at) VALUES($1,lower($2),$3,'active',true,true,now())`,
        [randomUUID(), env.BOOTSTRAP_ADMIN_EMAIL, passwordHash],
      );
    }
    process.stdout.write(
      `Admin bootstrap aktif: ${env.BOOTSTRAP_ADMIN_EMAIL} (wajib ganti password saat login pertama)\n`,
    );
  }
} finally {
  await db.end();
}
