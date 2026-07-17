import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown when value is empty / unmatched. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Extra classes on the trigger button. */
  triggerClassName?: string;
  /** Preferred menu open direction. Defaults to "auto". */
  placement?: "auto" | "top" | "bottom";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

const EMPTY = "__empty__";

/**
 * App select API backed by shadcn/Radix Select.
 * Keeps the previous props surface used across settings and dialogs.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled = false,
  className = "",
  triggerClassName = "",
  placement = "auto",
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: Props) {
  const selected = options.find((o) => o.value === value);
  const radixValue = value === "" ? EMPTY : value;

  return (
    <SelectRoot
      value={selected ? radixValue : undefined}
      onValueChange={(next) => onChange(next === EMPTY ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn("w-full", className, triggerClassName)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        side={placement === "auto" ? undefined : placement}
        className="z-[100]"
      >
        {options.map((opt) => (
          <SelectItem
            key={opt.value === "" ? EMPTY : opt.value}
            value={opt.value === "" ? EMPTY : opt.value}
            disabled={opt.disabled}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
