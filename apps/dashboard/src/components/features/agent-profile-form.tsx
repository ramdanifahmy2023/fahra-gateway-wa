"use client";

import { FormEvent, useEffect, useState } from "react";
import { Bot, LoaderCircle, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { apiFetchResponse } from "@/lib/client-api";
import { getString, unwrapRecord } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";

type Profile = {
  name: string;
  persona: string;
  jobdesk: string;
  systemInstruction: string;
};
const emptyProfile: Profile = {
  name: "",
  persona: "",
  jobdesk: "",
  systemInstruction: "",
};

export function AgentProfileForm() {
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [etag, setEtag] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data, response } = await apiFetchResponse<unknown>(
        "/api/gateway/agent/profile",
      );
      const value = unwrapRecord(data);
      setProfile({
        name: getString(value, "name"),
        persona: getString(value, "persona"),
        jobdesk: getString(value, "jobdesk", "jobDescription"),
        systemInstruction: getString(
          value,
          "systemInstruction",
          "system_instruction",
        ),
      });
      const loadedRevision = Number(value.revision);
      setRevision(
        Number.isInteger(loadedRevision) && loadedRevision > 0
          ? loadedRevision
          : undefined,
      );
      setEtag(response.headers.get("etag"));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Profil agent gagal dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { data, response } = await apiFetchResponse<unknown>(
        "/api/gateway/agent/profile",
        {
          method: "PUT",
          headers: etag ? { "if-match": etag } : undefined,
          body: { ...profile, revision },
        },
      );
      const value = unwrapRecord(data);
      if (Object.keys(value).length)
        setProfile({
          name: getString(value, "name") || profile.name,
          persona: getString(value, "persona") || profile.persona,
          jobdesk:
            getString(value, "jobdesk", "jobDescription") || profile.jobdesk,
          systemInstruction:
            getString(value, "systemInstruction", "system_instruction") ||
            profile.systemInstruction,
        });
      const savedRevision = Number(value.revision);
      if (Number.isInteger(savedRevision) && savedRevision > 0)
        setRevision(savedRevision);
      setEtag(response.headers.get("etag") ?? etag);
      setNotice(
        "Profil agent tersimpan. Identitas ini tetap ada saat nomor WhatsApp diganti.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Profil agent gagal disimpan.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Persistent identity"
        title="Agent Profile"
        description="Persona, jobdesk, dan system instruction disimpan terpisah dari session WhatsApp."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Muat ulang
          </Button>
        }
      />
      {loading ? (
        <LoadingState />
      ) : error && !profile.name && !profile.persona ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <form onSubmit={save} className="grid gap-5 xl:grid-cols-[1fr_340px]">
          {" "}
          <Card>
            <CardHeader>
              <CardTitle>Identitas agent</CardTitle>
              <CardDescription>
                Gateway menyimpan dan meneruskan konteks; reasoning tetap
                dijalankan OpenClaw.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {notice ? (
                <InlineNotice tone="success">{notice}</InlineNotice>
              ) : null}
              {error ? (
                <InlineNotice tone="danger">{error}</InlineNotice>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="agent-name">Nama agent</Label>
                <Input
                  id="agent-name"
                  value={profile.name}
                  onChange={(event) =>
                    setProfile((value) => ({
                      ...value,
                      name: event.target.value,
                    }))
                  }
                  placeholder="Nama yang dikenali pengguna"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="persona">Persona</Label>
                <Textarea
                  id="persona"
                  value={profile.persona}
                  onChange={(event) =>
                    setProfile((value) => ({
                      ...value,
                      persona: event.target.value,
                    }))
                  }
                  placeholder="Karakter dan gaya komunikasi agent…"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jobdesk">Jobdesk</Label>
                <Textarea
                  id="jobdesk"
                  value={profile.jobdesk}
                  onChange={(event) =>
                    setProfile((value) => ({
                      ...value,
                      jobdesk: event.target.value,
                    }))
                  }
                  placeholder="Tanggung jawab dan batas tugas agent…"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="system-instruction">System instruction</Label>
                <Textarea
                  id="system-instruction"
                  className="min-h-52 font-mono text-xs leading-6"
                  value={profile.systemInstruction}
                  onChange={(event) =>
                    setProfile((value) => ({
                      ...value,
                      systemInstruction: event.target.value,
                    }))
                  }
                  placeholder="Instruksi sistem yang akan menjadi konteks OpenClaw…"
                  required
                />
              </div>
              <div className="flex justify-end">
                <Button disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? "Menyimpan…" : "Simpan profil"}
                </Button>
              </div>
            </CardContent>
          </Card>
          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <span className="mb-2 w-fit rounded-md border border-primary/20 bg-primary/10 p-2.5 text-primary">
                  <Bot className="h-5 w-5" />
                </span>
                <CardTitle>Batas tanggung jawab</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
                <p>Gateway tidak menjalankan model AI atau reasoning.</p>
                <p>
                  Profil ini hanya disimpan sebagai sumber konteks persisten
                  untuk OpenClaw.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex gap-3 pt-6">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-medium">Optimistic concurrency</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Perubahan memakai ETag bila disediakan API agar edit paralel
                    tidak saling menimpa.
                  </p>
                </div>
              </CardContent>
            </Card>
          </aside>
        </form>
      )}
    </>
  );
}
