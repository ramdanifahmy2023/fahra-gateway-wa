import { ResourceManager } from "@/components/features/resource-manager";

export const metadata = { title: "Jobs" };
export default function JobsPage() {
  return (
    <ResourceManager
      title="Jobs"
      eyebrow="Scheduled workflows"
      description="Kelola definisi instruksi dan jadwal yang dibaca OpenClaw melalui context API. Gateway tidak menjadi workflow executor."
      endpoint="/jobs"
      itemName="Job"
      emptyDescription="Belum ada job terjadwal untuk agent."
      action={{
        label: "Jalankan",
        suffix: "run",
        confirm: "Jalankan job ini sekarang melalui OpenClaw?",
      }}
      fields={[
        {
          name: "name",
          label: "Nama job",
          required: true,
          placeholder: "Ringkasan harian",
        },
        {
          name: "instruction",
          label: "Instruksi",
          type: "textarea",
          required: true,
          placeholder: "Buat ringkasan…",
        },
        {
          name: "schedule",
          label: "Jadwal cron",
          required: true,
          placeholder: "0 8 * * *",
          help: "Jadwal disimpan untuk scheduler OpenClaw; Gateway hanya meneruskan context dan permintaan jalankan manual.",
        },
        { name: "enabled", label: "Aktif", type: "checkbox" },
      ]}
      columns={[
        { key: "name", label: "Nama" },
        { key: "schedule", label: "Jadwal" },
        { key: "enabled", label: "Status", format: "boolean" },
        { key: "lastRunAt", label: "Terakhir diminta", format: "date" },
      ]}
    />
  );
}
