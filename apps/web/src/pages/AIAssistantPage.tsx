import { SecurityAssistant } from "@/components/custom/security-assistant";

export default function AIAssistantPage() {
  return (
    <div
      data-ai-page-canvas
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#f6f8fd] text-slate-900"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-65"
        style={{
          backgroundImage: [
            "radial-gradient(circle at 12% 8%, rgba(59, 130, 246, 0.20), transparent 31%)",
            "radial-gradient(circle at 84% 13%, rgba(20, 184, 166, 0.15), transparent 28%)",
            "radial-gradient(circle at 72% 88%, rgba(168, 85, 247, 0.10), transparent 25%)",
          ].join(","),
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent_82%)]"
        style={{
          backgroundImage: [
            "linear-gradient(rgba(83, 101, 132, 0.055) 1px, transparent 1px)",
            "linear-gradient(90deg, rgba(83, 101, 132, 0.055) 1px, transparent 1px)",
          ].join(","),
          backgroundSize: "34px 34px",
        }}
      />
      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto px-5 py-4 xl:px-7">
        <div className="mx-auto min-h-full w-full max-w-[1680px]">
          <SecurityAssistant mode="embedded" />
        </div>
      </main>
    </div>
  );
}
