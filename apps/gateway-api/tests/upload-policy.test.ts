import { describe, expect, it } from "vitest";
import { validateUploadContent } from "../src/upload-policy.js";

describe("upload content policy", () => {
  it("accepts supported binary signatures", () => {
    expect(() => validateUploadContent("image/png", "a.png", Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))).not.toThrow();
    expect(() => validateUploadContent("image/webp", "a.webp", Buffer.from("RIFF0000WEBP", "ascii"))).not.toThrow();
    expect(() => validateUploadContent("application/pdf", "a.pdf", Buffer.from("%PDF-1.7"))).not.toThrow();
  });

  it("rejects spoofed MIME and SVG under any filename or MIME", () => {
    expect(() => validateUploadContent("image/png", "a.png", Buffer.from("not png"))).toThrow(/tidak cocok/);
    expect(() => validateUploadContent("image/png", "a.png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'>"))).toThrow(/SVG/);
    expect(() => validateUploadContent("text/plain", "a.svg", Buffer.from("hello"))).toThrow(/SVG/);
    expect(() => validateUploadContent("image/svg+xml", "a.txt", Buffer.from("hello"))).toThrow(/SVG/);
  });

  it("accepts MP4 only when the ISO base media signature is present", () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom", "ascii"),
      Buffer.alloc(16),
    ]);
    expect(() => validateUploadContent("video/mp4", "status.mp4", mp4)).not.toThrow();
    expect(() =>
      validateUploadContent("video/mp4", "status.mp4", Buffer.from("not-video")),
    ).toThrow(/tidak cocok/);
  });

  it("accepts OGG Opus and MP3 signatures while rejecting spoofed audio", () => {
    const ogg = Buffer.concat([
      Buffer.from("OggS", "ascii"),
      Buffer.alloc(20),
      Buffer.from("OpusHead", "ascii"),
    ]);
    expect(() => validateUploadContent("audio/ogg", "voice.ogg", ogg)).not.toThrow();
    expect(() =>
      validateUploadContent("audio/ogg", "voice.ogg", Buffer.from("OggS without codec")),
    ).toThrow(/tidak cocok/);
    expect(() =>
      validateUploadContent("audio/mpeg", "audio.mp3", Buffer.from("ID3audio")),
    ).not.toThrow();
    expect(() =>
      validateUploadContent("audio/mpeg", "audio.mp3", Buffer.from([0xff, 0xe3, 0x00])),
    ).not.toThrow();
    expect(() =>
      validateUploadContent("audio/mpeg", "audio.mp3", Buffer.from("not-audio")),
    ).toThrow(/tidak cocok/);
  });

  it("accepts valid UTF-8 text and rejects binary text", () => {
    expect(() => validateUploadContent("text/plain", "a.txt", Buffer.from("halo dunia"))).not.toThrow();
    expect(() => validateUploadContent("text/plain", "a.txt", Buffer.from([0x00, 0xff]))).toThrow(/UTF-8/);
  });
});
