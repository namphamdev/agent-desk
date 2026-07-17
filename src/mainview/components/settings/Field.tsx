import type { ReactNode } from "react";
import { Field as UiField, FieldLabel } from "@/components/ui/field";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <UiField>
      <FieldLabel className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </FieldLabel>
      {children}
    </UiField>
  );
}
