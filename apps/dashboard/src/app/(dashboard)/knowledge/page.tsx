import { ResourceManager } from "@/components/features/resource-manager";

export const metadata = { title: "Knowledge" };
export default function KnowledgePage() {
  return (
    <ResourceManager
      title="Knowledge"
      eyebrow="Agent context"
      description="Kelola sumber pengetahuan persisten yang disertakan dalam konteks OpenClaw."
      endpoint="/knowledge"
      itemName="Knowledge"
      emptyDescription="Tambahkan knowledge pertama untuk memperkaya konteks agent."
      fields={[
        {
          name: "title",
          label: "Judul",
          required: true,
          placeholder: "Panduan produk",
        },
        {
          name: "category",
          label: "Kategori",
          required: true,
          placeholder: "operasional",
        },
        {
          name: "content",
          label: "Konten",
          type: "textarea",
          required: true,
          placeholder: "Isi pengetahuan…",
        },
        {
          name: "enabled",
          label: "Aktif",
          type: "checkbox",
          help: "Hanya knowledge aktif yang diteruskan ke OpenClaw.",
        },
      ]}
      columns={[
        { key: "title", label: "Judul" },
        { key: "category", label: "Kategori" },
        { key: "enabled", label: "Status", format: "boolean" },
        { key: "updatedAt", label: "Diperbarui", format: "date" },
      ]}
    />
  );
}
