import type { ReactNode } from "react";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </span>
      {children}
    </div>
  );
}
