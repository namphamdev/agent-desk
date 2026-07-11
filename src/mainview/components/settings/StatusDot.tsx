export function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          ok ? "bg-emerald-500" : "bg-red-500"
        }`}
        aria-hidden
      />
      <span className={ok ? "text-emerald-400" : "text-red-300"}>{label}</span>
    </span>
  );
}
