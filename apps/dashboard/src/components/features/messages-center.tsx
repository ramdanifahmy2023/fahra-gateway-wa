"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  SmilePlus,
} from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  formatDateTime,
  formatNumber,
  getRecordId,
  getString,
  responseMeta,
  unwrapCollection,
  unwrapRecord,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";

export function MessagesCenter() {
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [needsAdminOnly, setNeedsAdminOnly] = useState(false);
  const [jidFilter, setJidFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [page, setPage] = useState(1);
  const search = new URLSearchParams();
  if (query) search.set("search", query);
  if (direction) search.set("direction", direction);
  if (statusFilter) search.set("status", statusFilter);
  if (needsAdminOnly) search.set("needsAdminReply", "true");
  if (jidFilter) search.set("jid", jidFilter);
  if (fromFilter) search.set("from", fromFilter);
  if (toFilter) search.set("to", toFilter);
  search.set("page", String(page));
  search.set("limit", "50");
  const resource = useApiResource<unknown>(
    `/api/gateway/messages/conversations?${search.toString()}`,
    { pollMs: 10_000 },
  );
  const conversations = useMemo(
    () => unwrapCollection(resource.data),
    [resource.data],
  );
  const [selectedJid, setSelectedJid] = useState("");
  const selectedConversation = conversations.find((conversation) => getString(conversation, "remoteJid", "remote_jid") === selectedJid);
  const aiPausedUntil = getString(selectedConversation ?? {}, "aiPausedUntil", "ai_paused_until");
  const manualMode = Boolean(aiPausedUntil && new Date(aiPausedUntil) > new Date());
  const needsAdminReply = getString(selectedConversation ?? {}, "needsAdminReply", "needs_admin_reply") === "true";
  const historyParams = new URLSearchParams();
  if (selectedJid) historyParams.set("jid", selectedJid);
  historyParams.set("page", "1");
  historyParams.set("limit", "100");
  const historyResource = useApiResource<unknown>(
    selectedJid ? `/api/gateway/messages?${historyParams.toString()}` : "/api/gateway/messages?page=1&limit=1",
    { pollMs: 10_000, enabled: Boolean(selectedJid) },
  );
  const messages = useMemo(
    () => unwrapCollection(historyResource.data).slice().reverse(),
    [historyResource.data],
  );
  const latestInboundMessageId = useMemo(() => {
    const latest = messages
      .slice()
      .reverse()
      .find((message) => getString(message, "direction") === "inbound");
    return latest ? getRecordId(latest) : "";
  }, [messages]);
  const meta = useMemo(() => responseMeta(resource.data), [resource.data]);
  const total = Number(meta.total ?? conversations.length);
  const [recipient, setRecipient] = useState("");
  const [replyTarget, setReplyTarget] = useState<{ waMessageId: string; participantJid?: string; text: string } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [type, setType] = useState("text");
  const [text, setText] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [voiceNote, setVoiceNote] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingSend = useRef<{
    fingerprint: string;
    file: File | null;
    idempotencyKey: string;
    uploadId?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const analyticsResource = useApiResource<unknown>("/api/gateway/messages/analytics/receipts?days=1", { pollMs: 30_000 });
  const analytics = useMemo(() => unwrapRecord(analyticsResource.data), [analyticsResource.data]);
  const failedQueueResource = useApiResource<unknown>("/api/gateway/messages/queue/failed?hours=24&limit=50", { pollMs: 30_000 });
  const failedQueue = useMemo(() => unwrapCollection(failedQueueResource.data), [failedQueueResource.data]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reacting, setReacting] = useState<string | null>(null);
  const [markingRead, setMarkingRead] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typingDuration, setTypingDuration] = useState(10);
  const [customEmojiFor, setCustomEmojiFor] = useState<string | null>(null);
  const [customEmoji, setCustomEmoji] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const node = chatScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [selectedJid, messages.length]);

  async function openDetail(id: string) {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(unwrapRecord(await apiFetch(`/api/gateway/messages/${encodeURIComponent(id)}`)));
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : "Detail gagal dimuat.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const fingerprint = JSON.stringify({
        recipient: recipient.trim(),
        type,
        text: text.trim(),
        fileName: fileName.trim(),
        voiceNote,
        replyTo: replyTarget?.waMessageId ?? null,
        replyToParticipant: replyTarget?.participantJid ?? null,
      });
      if (
        !pendingSend.current ||
        pendingSend.current.fingerprint !== fingerprint ||
        pendingSend.current.file !== mediaFile
      ) {
        pendingSend.current = {
          fingerprint,
          file: mediaFile,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      const operation = pendingSend.current;

      if (type !== "text") {
        if (!mediaFile) throw new Error("Pilih file media yang akan dikirim.");
        if (!operation.uploadId) {
          const uploadBody = new FormData();
          uploadBody.set("file", mediaFile);
          uploadBody.set("purpose", type);
          const upload = unwrapRecord(
            await apiFetch("/api/gateway/uploads", {
              method: "POST",
              body: uploadBody,
            }),
          );
          operation.uploadId = getString(upload, "uploadId", "id");
          if (!operation.uploadId)
            throw new Error("Gateway tidak mengembalikan ID upload.");
        }
      }

      await apiFetch("/api/gateway/messages/send", {
        method: "POST",
        headers: { "idempotency-key": operation.idempotencyKey },
        body: {
          to: recipient.trim(),
          type,
          text: text.trim() || undefined,
          caption:
            type === "image" || type === "document" || type === "video"
              ? text.trim() || undefined
              : undefined,
          voiceNote: type === "audio" ? voiceNote : undefined,
          uploadId: operation.uploadId,
          fileName:
            type !== "text"
              ? fileName.trim() || mediaFile?.name
              : undefined,
          replyTo: replyTarget?.waMessageId,
          replyToParticipant: replyTarget?.participantJid,
        },
      });
      setText("");
      setMediaFile(null);
      pendingSend.current = null;
      if (fileInput.current) fileInput.current.value = "";
      setFileName("");
      setVoiceNote(false);
      setReplyTarget(null);
      setNotice({
        tone: "success",
        text: "Pesan masuk ke persistent queue dan akan dikirim oleh Baileys service.",
      });
      void resource.reload(true);
      void historyResource.reload(true);
      void analyticsResource.reload(true);
      void failedQueueResource.reload(true);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : "Pesan gagal dimasukkan ke queue.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function setManualMode(durationMinutes?: number) {
    if (!selectedJid) return;
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/contact-memory/${encodeURIComponent(selectedJid)}/manual-mode`, {
        method: "POST",
        body: { durationMinutes, reason: durationMinutes ? "manual sementara" : "manual permanen" },
      });
      setNotice({ tone: "success", text: durationMinutes ? `AI dipause ${durationMinutes} menit.` : "Manual mode aktif untuk chat ini." });
      void resource.reload(true);
      void analyticsResource.reload(true);
      void failedQueueResource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Manual mode gagal diubah." });
    }
  }

  async function setAiMode() {
    if (!selectedJid) return;
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/contact-memory/${encodeURIComponent(selectedJid)}/ai-mode`, { method: "POST" });
      setNotice({ tone: "success", text: "AI aktif lagi untuk chat ini." });
      void resource.reload(true);
      void historyResource.reload(true);
      void analyticsResource.reload(true);
      void failedQueueResource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "AI mode gagal diubah." });
    }
  }

  async function sendTyping() {
    if (!latestInboundMessageId) {
      setNotice({ tone: "danger", text: "Belum ada pesan inbound yang bisa menjadi target typing." });
      return;
    }
    setTyping(true);
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/messages/${encodeURIComponent(latestInboundMessageId)}/typing`, {
        method: "POST",
        body: { durationSeconds: typingDuration },
      });
      setNotice({ tone: "success", text: `Typing dijadwalkan ${typingDuration} detik.` });
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Typing gagal dikirim." });
    } finally {
      setTyping(false);
    }
  }

  async function reactToMessage(id: string, emoji: string) {
    setReacting(id);
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/messages/${encodeURIComponent(id)}/reaction`, {
        method: "POST",
        body: { emoji },
      });
      setNotice({ tone: "success", text: "Reaction dikirim." });
      setCustomEmojiFor(null);
      setCustomEmoji("");
      void historyResource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Reaction gagal dikirim." });
    } finally {
      setReacting(null);
    }
  }

  async function markRead(id: string) {
    setMarkingRead(id);
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/messages/${encodeURIComponent(id)}/mark-read`, { method: "POST" });
      setNotice({ tone: "success", text: "Pesan ditandai read." });
      void resource.reload(true);
      void historyResource.reload(true);
      void analyticsResource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Mark read gagal." });
    } finally {
      setMarkingRead(null);
    }
  }

  async function retry(id: string, requireConfirmation = false) {
    const target = messages.find((message) => getRecordId(message) === id);
    if (requireConfirmation || getString(target ?? {}, "direction") === "outbound") {
      const ok = window.confirm(
        "Retry outbound bisa mengirim pesan duplikat kalau WhatsApp sebenarnya sudah menerima pesan sebelumnya. Lanjutkan?",
      );
      if (!ok) return;
    }
    setRetrying(id);
    try {
      await apiFetch(`/api/gateway/messages/${encodeURIComponent(id)}/retry`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setNotice({
        tone: "success",
        text: "Pesan dijadwalkan ulang dengan kebijakan retry service.",
      });
      void resource.reload(true);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error ? caught.message : "Retry gagal dijadwalkan.",
      });
    } finally {
      setRetrying(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Message operations"
        title="Messages Center"
        description="Kirim pesan melalui durable queue dan telusuri status inbound/outbound tanpa kehilangan event saat koneksi terputus."
        actions={
          <Button variant="outline" onClick={() => void resource.reload()}>
            <RefreshCw className="h-4 w-4" />
            Muat ulang
          </Button>
        }
      />
      {notice ? (
        <div className="mb-5">
          <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
        </div>
      ) : null}
      <section className="grid min-w-0 gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Receipt 24 jam</CardTitle>
            <CardDescription>Ringkasan acknowledgement dan queue tanpa payload mentah.</CardDescription>
          </CardHeader>
          <CardContent>
            {analyticsResource.error ? (
              <ErrorState message={analyticsResource.error} onRetry={() => void analyticsResource.reload()} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {["sent", "delivered", "read", "failed", "retrying", "dead"].map((key) => (
                  <div key={key} className="rounded-xl border border-border p-3">
                    <p className="text-xs capitalize text-muted-foreground">{key}</p>
                    <p className="mt-1 text-2xl font-semibold">{formatNumber(analytics[key])}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Failed queue 24 jam</CardTitle>
                <CardDescription>Alasan aman saja: status, attempts, waktu, tipe. Isi pesan tidak ditampilkan.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void failedQueueResource.reload()}>
                <RefreshCw className="h-4 w-4" />
                Muat ulang
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {failedQueueResource.loading ? (
              <LoadingState />
            ) : failedQueueResource.error ? (
              <ErrorState message={failedQueueResource.error} onRetry={() => void failedQueueResource.reload()} />
            ) : !failedQueue.length ? (
              <EmptyState title="Tidak ada failed queue" description="Tidak ada pesan gagal dalam 24 jam terakhir." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2">Waktu</th>
                      <th className="p-2">Tipe</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Attempts</th>
                      <th className="p-2">Reason aman</th>
                      <th className="p-2">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedQueue.map((entry, index) => {
                      const id = getString(entry, "jobId", "job_id") || getRecordId(entry);
                      const retryId = getString(entry, "messageId", "message_id");
                      return (
                        <tr key={id || index} className="border-t border-border">
                          <td className="p-2 text-xs">{formatDateTime(entry.failedAt ?? entry.updatedAt ?? entry.createdAt)}</td>
                          <td className="p-2">{getString(entry, "jobType", "job_type") || "message"}</td>
                          <td className="p-2"><StatusBadge value={getString(entry, "status", "processingState") || "failed"} /></td>
                          <td className="p-2">{getString(entry, "attempts", "attemptCount") || "0"}</td>
                          <td className="max-w-[280px] truncate p-2 text-muted-foreground">{getString(entry, "safeReason", "reason", "errorCode") || "Tidak tersedia"}</td>
                          <td className="p-2">
                            {retryId ? (
                              <Button size="sm" variant="outline" disabled={retrying === retryId} onClick={() => void retry(retryId, true)}>
                                {retrying === retryId ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                                Retry
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">Tidak retryable dari pesan</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="hidden">
          <CardHeader>
            <CardTitle>Kirim pesan</CardTitle>
            <CardDescription>
              Nomor DM atau JID grup harus sudah valid di WhatsApp.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={sendMessage} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="recipient">Nomor / JID penerima</Label>
                <Input
                  id="recipient"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="62812… atau 12036…@g.us"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="message-type">Tipe pesan</Label>
                <select
                  id="message-type"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    setVoiceNote(false);
                    setMediaFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
                >
                  <option value="text">Teks</option>
                  <option value="image">Gambar</option>
                  <option value="document">Dokumen</option>
                  <option value="video">Video MP4</option>
                  <option value="audio">Audio / voice note</option>
                </select>
              </div>
              {type !== "text" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="media-file">
                      File {type === "image" ? "gambar" : type === "video" ? "video" : type === "audio" ? "audio" : "dokumen"}
                    </Label>
                    <Input
                      ref={fileInput}
                      id="media-file"
                      type="file"
                      accept={
                        type === "image"
                          ? "image/jpeg,image/png,image/webp"
                          : type === "video"
                            ? "video/mp4,.mp4"
                            : type === "audio"
                              ? "audio/ogg,audio/mpeg,.ogg,.opus,.mp3"
                          : ".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,application/pdf"
                      }
                      onChange={(event) =>
                        setMediaFile(event.target.files?.[0] ?? null)
                      }
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      File diunggah ke penyimpanan workspace melalui Gateway API
                      sebelum masuk queue.
                    </p>
                  </div>
                  {type === "document" ? (
                    <div className="space-y-2">
                      <Label htmlFor="file-name">Nama file saat dikirim</Label>
                      <Input
                        id="file-name"
                        value={fileName}
                        onChange={(event) => setFileName(event.target.value)}
                        placeholder={mediaFile?.name || "dokumen.pdf"}
                      />
                    </div>
                  ) : null}
                  {type === "audio" ? (
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={voiceNote}
                        onChange={(event) => setVoiceNote(event.target.checked)}
                      />
                      Kirim sebagai voice note (wajib OGG Opus)
                    </label>
                  ) : null}
                </>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="message-text">
                  {type === "text" ? "Isi pesan" : type === "audio" ? "Audio tanpa caption" : "Caption"}
                </Label>
                <Textarea
                  id="message-text"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  required={type === "text"}
                  disabled={type === "audio"}
                  placeholder={
                    type === "text" ? "Tulis pesan…" : type === "audio" ? "Caption tidak didukung untuk audio" : "Caption opsional…"
                  }
                />
              </div>
              <Button className="w-full" disabled={submitting}>
                {submitting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {submitting ? "Memasukkan ke queue…" : "Kirim melalui queue"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="order-1 min-w-0 overflow-hidden xl:order-2">
          <CardHeader>
            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <CardTitle>Riwayat pesan</CardTitle>
                <CardDescription>
                  Status berasal dari database dan acknowledgement WhatsApp.
                </CardDescription>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
                <div className="relative min-w-0 lg:w-56">
                  <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    aria-label="Cari pesan"
                    className="pl-9"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                    placeholder="Cari pesan…"
                  />
                </div>
                <select
                  aria-label="Filter arah pesan"
                  value={direction}
                  onChange={(event) => {
                    setDirection(event.target.value);
                    setPage(1);
                  }}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring lg:w-auto"
                >
                  <option value="">Semua arah</option>
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                </select>
                <Input
                  aria-label="Filter berdasarkan JID atau nomor"
                  className="w-full lg:w-36"
                  value={jidFilter}
                  onChange={(event) => {
                    setJidFilter(event.target.value);
                    setPage(1);
                  }}
                  placeholder="JID/nomor"
                />
                <Input
                  className="w-full lg:w-36"
                  type="date"
                  value={fromFilter}
                  onChange={(event) => {
                    setFromFilter(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter tanggal mulai"
                />
                <Input
                  className="w-full lg:w-36"
                  type="date"
                  value={toFilter}
                  onChange={(event) => {
                    setToFilter(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Filter tanggal akhir"
                />
                <select
                  aria-label="Filter status pesan"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setPage(1);
                  }}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring lg:w-auto"
                >
                  <option value="">Semua status</option>
                  <option value="queued">Queued</option>
                  <option value="sent">Sent</option>
                  <option value="responded">Responded</option>
                  <option value="ignored">Ignored</option>
                  <option value="failed">Failed</option>
                  <option value="dead_letter">Dead letter</option>
                </select>
                <Button
                  type="button"
                  variant={needsAdminOnly ? "default" : "outline"}
                  onClick={() => { setNeedsAdminOnly((value) => !value); setPage(1); }}
                >
                  Butuh balasan admin
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {resource.loading ? (
              <LoadingState />
            ) : resource.error ? (
              <ErrorState
                message={resource.error}
                onRetry={() => void resource.reload()}
              />
            ) : !conversations.length ? (
              <EmptyState
                title="Belum ada percakapan"
                description="Riwayat akan muncul setelah pesan masuk atau dikirim melalui gateway."
              />
            ) : (
              <div className="grid min-w-0 gap-4 lg:h-[calc(100vh-260px)] lg:min-h-[520px] lg:grid-cols-[340px_minmax(0,1fr)]">
                <div className="min-w-0 space-y-3 overflow-y-auto pr-1 lg:h-full">
                  {conversations.map((conversation, index) => {
                    const jid = getString(conversation, "remoteJid");
                    const status =
                      getString(conversation, "status") ||
                      getString(conversation, "processingState") ||
                      "unknown";
                    const selected = jid && jid === selectedJid;
                    return (
                      <button
                        key={jid || index}
                        type="button"
                        onClick={() => { setSelectedJid(jid); setRecipient(jid); setReplyTarget(null); }}
                        className={`w-full rounded-xl border p-4 text-left transition ${
                          selected
                            ? "border-primary/60 bg-primary/5"
                            : "border-border bg-card hover:border-primary/40"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">
                              {getString(conversation, "candidateName") ||
                                jid.replace("@s.whatsapp.net", "") ||
                                "Nomor tidak dikenal"}
                            </p>
                            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                              {jid || "Tidak tersedia"}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <StatusBadge value={status} />
                            {getString(conversation, "needsAdminReply", "needs_admin_reply") === "true" ? <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">butuh admin</span> : null}
                            {getString(conversation, "aiPausedUntil", "ai_paused_until") ? <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300">manual</span> : null}
                          </div>
                        </div>
                        <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                          {getString(conversation, "lastText") ||
                            `[${getString(conversation, "lastMessageType") || "message"}]`}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{formatDateTime(getString(conversation, "lastAt"))}</span>
                          <span>• {getString(conversation, "totalMessages") || "0"} pesan</span>
                          {Number(getString(conversation, "failedMessages") || 0) > 0 ? (
                            <span className="text-destructive">
                              • {getString(conversation, "failedMessages")} gagal
                            </span>
                          ) : null}
                          {getString(conversation, "formSubmitted") === "true" ? (
                            <span>• form submitted</span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background lg:h-full lg:min-h-[420px]">
                  {!selectedJid ? (
                    <EmptyState
                      title="Pilih nomor"
                      description="Klik satu box percakapan untuk membaca history chat lengkap."
                    />
                  ) : historyResource.loading ? (
                    <LoadingState />
                  ) : historyResource.error ? (
                    <ErrorState
                      message={historyResource.error}
                      onRetry={() => void historyResource.reload()}
                    />
                  ) : !messages.length ? (
                    <EmptyState
                      title="History kosong"
                      description="Belum ada pesan untuk nomor ini."
                    />
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="border-b border-border bg-background p-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="break-all font-mono text-xs text-muted-foreground">{selectedJid}</p>
                            <p className="mt-1 text-xs">{manualMode ? "Manual mode aktif. AI tidak membalas chat ini." : "AI aktif. Admin tetap bisa membalas manual."}</p>
                            {needsAdminReply ? <p className="mt-1 text-xs text-amber-300">Butuh balasan admin.</p> : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Input
                              aria-label="Durasi typing dalam detik"
                              className="h-9 w-20"
                              type="number"
                              min={1}
                              max={15}
                              value={typingDuration}
                              onChange={(event) =>
                                setTypingDuration(
                                  Math.min(15, Math.max(1, Number(event.target.value) || 1)),
                                )
                              }
                            />
                            {manualMode ? (
                              <>
                                <Button size="sm" variant="default" onClick={() => void setAiMode()}>Aktifkan AI lagi</Button>
                                <Button size="sm" variant="outline" disabled={typing || !latestInboundMessageId} onClick={() => void sendTyping()}>{typing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Typing {typingDuration}d</Button>
                              </>
                            ) : (
                              <>
                                <Button size="sm" variant="default" onClick={() => void setManualMode()}>Ambil alih manual</Button>
                                <Button size="sm" variant="outline" onClick={() => void setManualMode(30)}>30m</Button>
                                <Button size="sm" variant="outline" onClick={() => void setManualMode(60)}>1j</Button>
                                <Button size="sm" variant="outline" onClick={() => void setManualMode(1440)}>24j</Button>
                                <Button size="sm" variant="outline" disabled={typing || !latestInboundMessageId} onClick={() => void sendTyping()}>{typing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Typing {typingDuration}d</Button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                      {messages.map((message, index) => {
                        const id = getRecordId(message);
                        const directionValue = getString(message, "direction");
                        const outbound = directionValue === "outbound";
                        const messageType = getString(message, "messageType") || "text";
                        const waMessageId = getString(message, "waMessageId", "wa_message_id");
                        const participantJid = getString(message, "participantJid", "participant_jid");
                        const status = outbound
                          ? getString(message, "status", "deliveryStatus") || "unknown"
                          : getString(message, "processingState", "status") || "unknown";
                        return (
                          <div key={id || index} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                            <div className={`max-w-[86%] rounded-2xl px-3 py-2 text-sm ${outbound ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                              <p className="whitespace-pre-wrap break-words">
                                {getString(message, "textBody", "text", "caption") || `[${messageType}]`}
                              </p>
                              <div className={`mt-1 flex flex-wrap items-center gap-2 text-[10px] ${outbound ? "text-primary-foreground" : "text-muted-foreground"}`}>
                                <span>{formatDateTime(message.createdAt ?? message.timestamp)}</span>
                                <span>{status}</span>
                                {id ? (
                                  <button className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void openDetail(id)}>
                                    detail
                                  </button>
                                ) : null}
                                {id && !outbound ? (
                                  <>
                                    <button className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={markingRead === id} onClick={() => void markRead(id)}>
                                      read
                                    </button>
                                    <span className="inline-flex items-center gap-1">
                                      {['👍', '❤️', '🙏'].map((emoji) => (
                                        <button key={emoji} className="inline-flex min-h-11 items-center rounded px-1 hover:bg-background/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={reacting === id} onClick={() => void reactToMessage(id, emoji)} type="button">
                                          {emoji}
                                        </button>
                                      ))}
                                      <button className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={() => setCustomEmojiFor(customEmojiFor === id ? null : id)}>
                                        <SmilePlus className="h-3 w-3" />
                                      </button>
                                    </span>
                                  </>
                                ) : null}
                                {waMessageId && !outbound ? (
                                  <button className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setRecipient(selectedJid); setReplyTarget({ waMessageId, participantJid: participantJid || undefined, text: getString(message, "textBody", "text", "caption") || `[${messageType}]` }); }}>
                                    balas
                                  </button>
                                ) : null}
                                {['failed', 'dead', 'dead_letter'].includes(status.toLowerCase()) && id ? (
                                  <button className="inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={retrying === id} onClick={() => void retry(id)}>
                                    retry
                                  </button>
                                ) : null}
                              </div>
                              {customEmojiFor === id ? (
                                <form
                                  className="mt-2 flex gap-1"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    if (customEmoji.trim()) void reactToMessage(id, customEmoji.trim());
                                  }}
                                >
                                  <Input
                                    aria-label="Emoji custom"
                                    className="h-8 w-20 bg-background text-foreground"
                                    maxLength={16}
                                    value={customEmoji}
                                    onChange={(event) => setCustomEmoji(event.target.value)}
                                    placeholder="Emoji"
                                  />
                                  <Button size="sm" variant="outline" disabled={!customEmoji.trim() || reacting === id}>Kirim</Button>
                                  <Button size="sm" variant="outline" type="button" disabled={reacting === id} onClick={() => void reactToMessage(id, "")}>Hapus</Button>
                                </form>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      </div>
                      <form onSubmit={sendMessage} className="border-t border-border bg-card/95 p-3">
                        {replyTarget ? (
                          <div className="mb-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">Membalas pesan</span>
                              <button type="button" className="inline-flex min-h-11 items-center text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setReplyTarget(null)}>Batal</button>
                            </div>
                            <p className="mt-1 line-clamp-2 text-muted-foreground">{replyTarget.text}</p>
                          </div>
                        ) : null}
                        <div className="mb-2 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)]">
                          <select
                            aria-label="Tipe balasan"
                            value={type}
                            onChange={(event) => {
                              setType(event.target.value);
                              setVoiceNote(false);
                              setMediaFile(null);
                              pendingSend.current = null;
                              if (fileInput.current) fileInput.current.value = "";
                            }}
                            className="h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
                          >
                            <option value="text">Teks</option>
                            <option value="image">Gambar</option>
                            <option value="document">Dokumen</option>
                            <option value="video">Video MP4</option>
                            <option value="audio">Audio / voice note</option>
                          </select>
                          {type !== "text" ? (
                            <Input
                              ref={fileInput}
                              aria-label="File media balasan"
                              type="file"
                              accept={
                                type === "image"
                                  ? "image/jpeg,image/png,image/webp"
                                  : type === "video"
                                    ? "video/mp4,.mp4"
                                    : type === "audio"
                                      ? "audio/ogg,audio/mpeg,.ogg,.opus,.mp3"
                                      : ".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,application/pdf"
                              }
                              onChange={(event) => {
                                setMediaFile(event.target.files?.[0] ?? null);
                                pendingSend.current = null;
                              }}
                              required
                            />
                          ) : null}
                        </div>
                        {type === "audio" ? (
                          <label className="mb-2 flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={voiceNote}
                              onChange={(event) => {
                                setVoiceNote(event.target.checked);
                                pendingSend.current = null;
                              }}
                            />
                            Kirim sebagai voice note (OGG Opus saja)
                          </label>
                        ) : null}
                        <div className="flex gap-2">
                          <Textarea
                            aria-label="Balasan manual"
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            placeholder={
                              type === "text"
                                ? "Tulis balasan manual…"
                                : type === "audio"
                                  ? "Audio tidak mendukung caption"
                                  : "Caption opsional…"
                            }
                            required={type === "text"}
                            disabled={type === "audio"}
                            className="min-h-11 flex-1 resize-none"
                          />
                          <Button disabled={submitting || !selectedJid} className="self-end">
                            {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            Kirim
                          </Button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            )}
            {conversations.length ? (
              <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Halaman {page} • total {total}
                </span>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    Sebelumnya
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page * 50 >= total}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Berikutnya
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent title="Detail pesan" description={getRecordId(detail ?? {}) || undefined}>
          {detailLoading ? (
            <LoadingState />
          ) : detailError ? (
            <ErrorState message={detailError} onRetry={() => void (detail ? openDetail(getRecordId(detail)) : Promise.resolve())} />
          ) : detail ? (
            <div className="grid gap-3 text-sm md:grid-cols-2">
              {[
                ["Remote JID", getString(detail, "remoteJid")],
                ["Participant", getString(detail, "participantJid") || "Tidak tersedia"],
                ["WA message ID", getString(detail, "waMessageId") || "Tidak tersedia"],
                ["Queue job", getString(detail, "queueJobId") || "Tidak tersedia"],
                ["Direction", getString(detail, "direction")],
                ["Type", getString(detail, "messageType")],
                ["Status", getString(detail, "status")],
                ["Processing", getString(detail, "processingState")],
                ["Attempts", getString(detail, "attempts") || "0"],
                ["Received", formatDateTime(detail.receivedAt)],
                ["Sent", formatDateTime(detail.sentAt)],
                ["Delivered", formatDateTime(detail.deliveredAt)],
                ["Read", formatDateTime(detail.readAt)],
                ["Created", formatDateTime(detail.createdAt)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 break-all font-mono text-xs">{value}</p>
                </div>
              ))}
              <div className="rounded-md border border-border p-3 md:col-span-2">
                <p className="text-xs text-muted-foreground">Text / caption</p>
                <p className="mt-1 whitespace-pre-wrap break-words">{getString(detail, "textBody") || "Tidak tersedia"}</p>
              </div>
              <div className="rounded-md border border-border p-3 md:col-span-2">
                <p className="text-xs text-muted-foreground">Media metadata</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(detail.media ?? {}, null, 2)}</pre>
              </div>
              <div className="rounded-md border border-border p-3 md:col-span-2">
                <p className="text-xs text-muted-foreground">Error</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-destructive">{getString(detail, "error") || "Tidak tersedia"}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
