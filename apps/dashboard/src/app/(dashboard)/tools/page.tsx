import { ResourceManager } from "@/components/features/resource-manager";

export const metadata = { title: "Tools" };
export default function ToolsPage() {
  return (
    <ResourceManager
      title="Tools"
      eyebrow="OpenClaw capabilities"
      description="Daftarkan endpoint tool yang boleh digunakan OpenClaw; Gateway hanya menyimpan definisinya."
      endpoint="/tools"
      itemName="Tool"
      emptyDescription="Belum ada tool yang didaftarkan untuk agent."
      fields={[
        {
          name: "name",
          label: "Nama tool",
          required: true,
          placeholder: "cek_stok",
        },
        {
          name: "endpoint",
          label: "Endpoint",
          type: "url",
          required: true,
          placeholder: "https://internal.example/api",
        },
        {
          name: "description",
          label: "Deskripsi",
          type: "textarea",
          placeholder: "Kapan dan untuk apa tool digunakan…",
        },
        {
          name: "method",
          label: "HTTP method",
          type: "select",
          required: true,
          options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({
            label: value,
            value,
          })),
        },
        {
          name: "secret",
          label: "Secret / API key",
          type: "password",
          help: "Disimpan terenkripsi; nilai lama tidak pernah ditampilkan kembali.",
        },
        { name: "enabled", label: "Aktif", type: "checkbox" },
      ]}
      columns={[
        { key: "name", label: "Nama" },
        { key: "method", label: "Method" },
        { key: "endpoint", label: "Endpoint" },
        { key: "enabled", label: "Status", format: "boolean" },
      ]}
    />
  );
}
