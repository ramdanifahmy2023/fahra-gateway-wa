import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  extractReply,
  sanitizedReplyText,
  validatedOpenClawUrl,
} from "../src/bridge-worker.js";

describe("OpenClaw chat bridge", () => {
  it("accepts only the loopback chat-completions route", () => {
    expect(
      validatedOpenClawUrl("http://127.0.0.1:18789/v1/chat/completions")
        .pathname,
    ).toBe("/v1/chat/completions");
    expect(() =>
      validatedOpenClawUrl("http://127.0.0.1:18789/internal/openclaw/event"),
    ).toThrow();
    expect(() =>
      validatedOpenClawUrl("https://example.com/v1/chat/completions"),
    ).toThrow();
  });

  it("extracts a non-streaming OpenAI reply", () => {
    expect(
      extractReply({
        choices: [{ message: { role: "assistant", content: "  Mangga  " } }],
      }),
    ).toEqual({ to: "", text: "Mangga" });
  });

  it("injects active profile, knowledge, and isolated contact context", () => {
    const prompt = buildSystemPrompt(
      {
        profile: { name: "Fahra", system_instruction: "Jangan mengarang." },
        knowledge: [
          { category: "Karier", title: "Lowongan", content: "Internet Marketing" },
        ],
      },
      {
        memory: {
          candidate_name: "Asep",
          recruitment_stage: "form_submitted",
          form_submitted: true,
          last_summary: "Pelamar sudah isi formulir.",
        },
        messages: [
          { direction: "inbound", text_body: "Sudah isi formulir", created_at: new Date() },
          { direction: "outbound", text_body: "Hatur nuhun, Kak.", created_at: new Date() },
        ],
      },
    );
    expect(prompt).toContain("Fahra");
    expect(prompt).toContain("Jangan mengarang.");
    expect(prompt).toContain("Internet Marketing");
    expect(prompt).toContain("KONTEKS NOMOR INI");
    expect(prompt).toContain("Asep");
    expect(prompt).toContain("form_submitted");
  });

  it("redacts sensitive contact context", () => {
    const prompt = buildSystemPrompt({}, {
      memory: null,
      messages: [
        {
          direction: "inbound",
          text_body: "otp 123456 nik 3201234567890001 rekening 123456789012",
          created_at: new Date(),
        },
      ],
    });
    expect(prompt).toContain("otp [redacted]");
    expect(prompt).toContain("nik [redacted]");
    expect(prompt).not.toContain("123456789012");
  });

  it("strips markdown markers from replies", () => {
    expect(sanitizedReplyText("**Halo**\n> Kak\n---")).toBe("Halo\nKak");
  });
});
