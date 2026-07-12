import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { RiArrowDownSLine, RiCheckLine } from "react-icons/ri";

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

type MenuPos = {
  top: number;
  left: number;
  width: number;
  side: "top" | "bottom";
};

/**
 * Custom select (no native <select>). Matches the app chrome:
 * dark elevated panel, keyboard nav, click-outside / Escape to close.
 *
 * The menu is portaled to document.body with fixed positioning so it is
 * never clipped by overflow:hidden ancestors (e.g. modal dialogs).
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
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);

  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setHighlight(-1);
    setMenuPos(null);
  }, []);

  const enabledIndexes = useCallback(() => {
    return options
      .map((o, i) => (o.disabled ? -1 : i))
      .filter((i) => i >= 0);
  }, [options]);

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) return;
    setOpen(true);
    const selectedIdx = options.findIndex((o) => o.value === value && !o.disabled);
    if (selectedIdx >= 0) {
      setHighlight(selectedIdx);
    } else {
      setHighlight(enabledIndexes()[0] ?? -1);
    }
  }, [disabled, options, value, enabledIndexes]);

  // Click outside (menu is portaled, so check both trigger root and list)
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, close]);

  // Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // Position menu with fixed coords; flip above if not enough room below.
  // Recompute on open, scroll, and resize so it stays anchored to the trigger.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const estimatedMenuH = Math.min(options.length * 36 + 8, 240);
      const gap = 4;
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;

      let side: "top" | "bottom";
      if (placement === "top" || placement === "bottom") {
        side = placement;
      } else {
        side =
          spaceBelow < estimatedMenuH && spaceAbove > spaceBelow
            ? "top"
            : "bottom";
      }

      const top =
        side === "bottom" ? rect.bottom + gap : rect.top - gap - estimatedMenuH;

      // Keep the menu within the viewport horizontally.
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const left = Math.min(Math.max(8, rect.left), maxLeft);

      setMenuPos({
        top: Math.max(8, top),
        left,
        width: rect.width,
        side,
      });
    };

    update();
    window.addEventListener("resize", update);
    // Capture scroll from any scrollable ancestor.
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, placement, options.length]);

  // After first paint of the menu, refine top placement with real height
  // so "open above" aligns flush with the trigger instead of using estimate.
  useLayoutEffect(() => {
    if (!open || !listRef.current || !triggerRef.current || !menuPos) return;
    if (menuPos.side !== "top") return;
    const rect = triggerRef.current.getBoundingClientRect();
    const h = listRef.current.getBoundingClientRect().height;
    const top = Math.max(8, rect.top - 4 - h);
    if (Math.abs(top - menuPos.top) > 1) {
      setMenuPos((p) => (p ? { ...p, top } : p));
    }
  }, [open, menuPos?.side, options.length]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (!open || highlight < 0 || !listRef.current) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    close();
  };

  const moveHighlight = (dir: 1 | -1) => {
    const idxs = enabledIndexes();
    if (idxs.length === 0) return;
    const pos = idxs.indexOf(highlight);
    let next: number;
    if (pos < 0) {
      next = dir === 1 ? idxs[0]! : idxs[idxs.length - 1]!;
    } else {
      const n = (pos + dir + idxs.length) % idxs.length;
      next = idxs[n]!;
    }
    setHighlight(next);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) openMenu();
        else if (e.key === "Enter" || e.key === " ") {
          const opt = options[highlight];
          if (opt) pick(opt);
        } else if (e.key === "ArrowDown") moveHighlight(1);
        else moveHighlight(-1);
        break;
      case "Home": {
        const first = enabledIndexes()[0];
        if (open && first != null) {
          e.preventDefault();
          setHighlight(first);
        }
        break;
      }
      case "End": {
        const idxs = enabledIndexes();
        if (open && idxs.length) {
          e.preventDefault();
          setHighlight(idxs[idxs.length - 1]!);
        }
        break;
      }
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveHighlight(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveHighlight(-1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) pick(opt);
        break;
      }
      case "Home": {
        e.preventDefault();
        const first = enabledIndexes()[0];
        if (first != null) setHighlight(first);
        break;
      }
      case "End": {
        e.preventDefault();
        const idxs = enabledIndexes();
        if (idxs.length) setHighlight(idxs[idxs.length - 1]!);
        break;
      }
      case "Tab":
        close();
        break;
    }
  };

  const menu =
    open && menuPos
      ? createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={
              highlight >= 0 ? `${listboxId}-opt-${highlight}` : undefined
            }
            onKeyDown={onListKeyDown}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              zIndex: 100,
            }}
            className="max-h-60 overflow-y-auto rounded-lg border border-[#3a3a3a] bg-[#1e1e1e] py-1 shadow-xl"
          >
            {options.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">No options</li>
            ) : (
              options.map((opt, i) => {
                const isSelected = opt.value === value;
                const isActive = i === highlight;
                return (
                  <li
                    key={opt.value}
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    onMouseEnter={() => {
                      if (!opt.disabled) setHighlight(i);
                    }}
                    onMouseDown={(e) => {
                      // Prevent button blur before click registers
                      e.preventDefault();
                    }}
                    onClick={() => pick(opt)}
                    className={[
                      "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm",
                      opt.disabled
                        ? "cursor-not-allowed text-gray-600"
                        : isActive
                          ? "bg-[#2a2a2a] text-gray-100"
                          : isSelected
                            ? "text-gray-200"
                            : "text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200",
                    ].join(" ")}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected && (
                      <RiCheckLine
                        className="h-3.5 w-3.5 shrink-0 text-gray-300"
                        aria-hidden
                      />
                    )}
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={[
          "flex w-full items-center justify-between gap-2 rounded-md border border-[#333] bg-[#121212] px-2 py-1.5 text-left text-sm text-gray-200",
          "hover:border-[#444] focus:outline-none focus:ring-1 focus:ring-gray-500",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open ? "border-gray-500 ring-1 ring-gray-500" : "",
          triggerClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className={selected ? "truncate" : "truncate text-gray-500"}>
          {selected?.label ?? placeholder}
        </span>
        <RiArrowDownSLine
          className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {menu}
    </div>
  );
}
