import { ResourceManager } from "@/components/features/resource-manager";

export const metadata = { title: "AI Provider" };
export default function AiProviderPage() {
  return (
    <ResourceManager
      title="AI Provider"
      eyebrow="OpenAI-compatible"
      description="Konfigurasi provider yang akan disinkronkan ke OpenClaw. Gateway tidak memanggil model untuk reasoning."
      endpoint="/ai-providers"
      itemName="Provider"
      emptyDescription="Tambahkan 9router, OpenRouter, atau endpoint OpenAI-compatible lainnya."
      action={{ label: "Uji", suffix: "test" }}
      fields={[
        {
          name: "name",
          label: "Nama provider",
          required: true,
          placeholder: "9router",
        },
        {
          name: "providerType",
          label: "Jenis provider",
          type: "select",
          required: true,
          defaultValue: "openai-compatible",
          options: [
            { label: "9router", value: "9router" },
            { label: "OpenRouter", value: "openrouter" },
            { label: "OpenAI-compatible", value: "openai-compatible" },
          ],
        },
        {
          name: "baseUrl",
          label: "Base URL",
          type: "url",
          required: true,
          placeholder: "https://api.example.com/v1",
        },
        {
          name: "apiKey",
          label: "API Key",
          type: "password",
          required: true,
          help: "Disimpan terenkripsi dan tidak dikirim kembali ke browser.",
        },
        { name: "model", label: "Model", required: true, placeholder: "gpt-5" },
        {
          name: "temperature",
          label: "Temperature",
          type: "number",
          min: 0,
          max: 2,
          step: 0.1,
          defaultValue: 0.7,
        },
        {
          name: "maxTokens",
          label: "Max Token",
          type: "number",
          min: 1,
          max: 1000000,
          step: 1,
          defaultValue: 4096,
        },
        { name: "isActive", label: "Provider aktif", type: "checkbox" },
      ]}
      columns={[
        { key: "name", label: "Provider" },
        { key: "providerType", label: "Jenis" },
        { key: "baseUrl", label: "Base URL" },
        { key: "model", label: "Model" },
        { key: "isActive", label: "Status", format: "boolean" },
      ]}
    />
  );
}
