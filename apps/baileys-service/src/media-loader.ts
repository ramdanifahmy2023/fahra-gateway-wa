import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { PermanentJobError } from "./errors.js";

export interface MediaReference {
  readonly filePath?: string;
  readonly base64?: string;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly caption?: string;
}

export interface LoadedMedia {
  readonly bytes: Buffer;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly caption?: string;
}

export class MediaLoader {
  public constructor(
    private readonly uploadsDir: string,
    private readonly maximumBytes: number,
  ) {}

  public async load(reference: MediaReference): Promise<LoadedMedia> {
    if (reference.caption && reference.caption.length > 4_096) {
      throw new PermanentJobError(
        "Media caption cannot exceed 4096 characters",
      );
    }
    if (
      reference.mimeType &&
      (reference.mimeType.length > 127 ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
          reference.mimeType,
        ))
    ) {
      throw new PermanentJobError("Media mimeType is invalid");
    }
    if (
      reference.fileName &&
      (reference.fileName.length > 255 ||
        /[\u0000-\u001f\u007f]/.test(reference.fileName))
    ) {
      throw new PermanentJobError("Media fileName is invalid");
    }
    const hasPath =
      typeof reference.filePath === "string" &&
      reference.filePath.trim() !== "";
    const hasBase64 =
      typeof reference.base64 === "string" && reference.base64 !== "";
    if (hasPath === hasBase64) {
      throw new PermanentJobError(
        "Media payload must specify exactly one of filePath or base64",
      );
    }

    let bytes: Buffer;
    if (hasPath && reference.filePath) {
      bytes = await this.readWorkspaceFile(reference.filePath);
    } else if (hasBase64 && reference.base64) {
      bytes = this.decodeBase64(reference.base64);
    } else {
      throw new PermanentJobError("Media source is missing");
    }
    return {
      bytes,
      ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      ...(reference.fileName
        ? { fileName: path.basename(reference.fileName) }
        : {}),
      ...(reference.caption ? { caption: reference.caption } : {}),
    };
  }

  private async readWorkspaceFile(filePath: string): Promise<Buffer> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.[a-z0-9]{1,10})?$/i.test(filePath)) {
      throw new PermanentJobError("Media file must use a gateway-generated stored name");
    }
    const uploadsRoot = await realpath(this.uploadsDir).catch(() => {
      throw new PermanentJobError("Workspace uploads directory does not exist");
    });
    const candidate = path.join(uploadsRoot, filePath);
    const resolved = await realpath(candidate).catch(() => {
      throw new PermanentJobError("Media file does not exist");
    });
    const relative = path.relative(uploadsRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PermanentJobError(
        "Media file must stay inside DATA_DIR/uploads",
      );
    }
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new PermanentJobError("Media file cannot be opened safely");
    });
    try {
      const information = await handle.stat();
      if (!information.isFile()) {
        throw new PermanentJobError("Media path must reference a regular file");
      }
      if (information.size <= 0 || information.size > this.maximumBytes) {
        throw new PermanentJobError(
          `Media file size must be between 1 and ${this.maximumBytes} bytes`,
        );
      }
      const bytes = await handle.readFile();
      if (bytes.length === 0 || bytes.length > this.maximumBytes) {
        throw new PermanentJobError(
          "Media file changed while it was being read",
        );
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private decodeBase64(encoded: string): Buffer {
    if (encoded.length > Math.ceil(this.maximumBytes / 3) * 4 + 4) {
      throw new PermanentJobError("Media base64 exceeds the size limit");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new PermanentJobError("Media base64 is malformed");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > this.maximumBytes ||
      bytes.toString("base64") !== encoded
    ) {
      throw new PermanentJobError(
        "Media base64 is non-canonical or outside the size limit",
      );
    }
    return bytes;
  }
}
