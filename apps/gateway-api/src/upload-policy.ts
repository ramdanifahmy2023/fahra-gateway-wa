const signatures: Readonly<Record<string, readonly number[][]>> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  "application/pdf": [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  "application/zip": [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b]],
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
};

const supported = new Set([
  ...Object.keys(signatures),
  "image/webp",
  "video/mp4",
  "audio/ogg",
  "audio/mpeg",
  "text/plain",
  "text/csv",
]);

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function validateUploadContent(mimeType: string, fileName: string, bytes: Buffer): void {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (
    normalized === "image/svg+xml" ||
    fileName.toLowerCase().endsWith(".svg") ||
    bytes.subarray(0, 1_024).toString("utf8").replace(/^\uFEFF?\s*/, "").toLowerCase().includes("<svg")
  ) throw new Error("SVG tidak didukung");
  if (!supported.has(normalized)) throw new Error("Tipe file tidak didukung");
  if (bytes.length === 0) throw new Error("File kosong tidak didukung");
  if (normalized === "image/webp") {
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
      throw new Error("Isi file tidak cocok dengan tipe MIME");
    return;
  }
  if (normalized === "video/mp4") {
    if (
      bytes.length < 12 ||
      bytes.toString("ascii", 4, 8) !== "ftyp"
    )
      throw new Error("Isi file tidak cocok dengan tipe MIME");
    return;
  }
  if (normalized === "audio/ogg") {
    if (
      bytes.toString("ascii", 0, 4) !== "OggS" ||
      !bytes.subarray(0, 128).includes(Buffer.from("OpusHead", "ascii"))
    )
      throw new Error("Isi file tidak cocok dengan tipe MIME");
    return;
  }
  if (normalized === "audio/mpeg") {
    const hasId3 = bytes.toString("ascii", 0, 3) === "ID3";
    const hasFrameSync =
      bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    if (!hasId3 && !hasFrameSync)
      throw new Error("Isi file tidak cocok dengan tipe MIME");
    return;
  }
  if (normalized.startsWith("text/")) {
    if (bytes.includes(0) || Buffer.from(bytes.toString("utf8"), "utf8").compare(bytes) !== 0)
      throw new Error("File teks bukan UTF-8 valid");
    return;
  }
  if (!signatures[normalized]?.some((signature) => startsWith(bytes, signature)))
    throw new Error("Isi file tidak cocok dengan tipe MIME");
}
