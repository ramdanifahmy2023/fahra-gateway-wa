import {
  chmod,
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBackupDownload } from "../src/modules/operations.js";

const backupId = "550e8400-e29b-41d4-a716-446655440000";
const filename = `openclaw-gateway-${backupId}.ocgwb`;
let temporaryRoot: string | undefined;

async function createTemporaryRoot(): Promise<string> {
  temporaryRoot = await mkdtemp(join(tmpdir(), "ocgw-backup-download-"));
  return temporaryRoot;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("Backup artifact download safety", () => {
  it("streams from the verified FileHandle even if the pathname is replaced", async () => {
    const root = await createTemporaryRoot();
    const artifactPath = join(root, filename);
    const detachedPath = join(root, "detached.ocgwb");
    await writeFile(artifactPath, "verified artifact", { mode: 0o600 });
    await chmod(artifactPath, 0o600);

    const stream = await openBackupDownload(root, filename, backupId);
    await rename(artifactPath, detachedPath);
    await writeFile(artifactPath, "replacement artifact", { mode: 0o600 });

    await expect(readStream(stream)).resolves.toEqual(
      Buffer.from("verified artifact"),
    );
    expect(stream.closed).toBe(true);
  });

  it("rejects non-canonical and record-mismatched filenames", async () => {
    const root = await createTemporaryRoot();
    await expect(
      openBackupDownload(root, `../${filename}`, backupId),
    ).rejects.toMatchObject({ code: "BACKUP_PATH_INVALID" });
    await expect(
      openBackupDownload(
        root,
        filename,
        "7d444840-9dc0-4ed3-9f20-6f39c2ed2f53",
      ),
    ).rejects.toMatchObject({ code: "BACKUP_PATH_INVALID" });
  });

  it("rejects symbolic links instead of following them", async () => {
    const root = await createTemporaryRoot();
    const target = join(root, "sensitive.env");
    await writeFile(target, "SECRET=value", { mode: 0o600 });
    await symlink(target, join(root, filename));

    await expect(
      openBackupDownload(root, filename, backupId),
    ).rejects.toMatchObject({ code: "BACKUP_ARTIFACT_INVALID" });
  });

  it("rejects hard-linked and group-readable artifacts", async () => {
    const root = await createTemporaryRoot();
    const source = join(root, "source.ocgwb");
    const artifactPath = join(root, filename);
    await writeFile(source, "artifact", { mode: 0o600 });
    await link(source, artifactPath);
    await expect(
      openBackupDownload(root, filename, backupId),
    ).rejects.toMatchObject({ code: "BACKUP_ARTIFACT_INVALID" });

    await rm(artifactPath);
    await writeFile(artifactPath, "artifact", { mode: 0o640 });
    await chmod(artifactPath, 0o640);
    await expect(
      openBackupDownload(root, filename, backupId),
    ).rejects.toMatchObject({ code: "BACKUP_ARTIFACT_INVALID" });
  });
});
