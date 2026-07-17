import { useEffect, useRef } from "react";
import type { PermissionRequest } from "../../shared/rpc";
import { Button } from "@/components/ui/button";

type Props = {
  request: PermissionRequest;
  onRespond: (optionId: string) => void;
};

/**
 * Inline card asking the user to approve/deny a tool call. Focus is trapped
 * on the first option for accessibility.
 */
export function PermissionPrompt({ request, onRespond }: Props) {
  const firstBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstBtn.current?.focus();
  }, [request.requestId]);

  const kindLabel = request.toolCall.kind ?? "tool";
  const loc = request.toolCall.locations?.[0];

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center px-6 md:left-64"
      role="alertdialog"
      aria-labelledby="perm-title"
      aria-describedby="perm-desc"
    >
      <div className="pointer-events-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-amber-700/50 bg-[#1a1510] shadow-2xl dark:bg-[#1a1510]">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-900/50 text-amber-300">
            ⚠
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="perm-title" className="text-sm font-semibold text-amber-100">
              Permission required
            </h2>
            <p id="perm-desc" className="mt-0.5 text-sm text-muted-foreground">
              Agent wants to run{" "}
              <span className="font-medium text-foreground">{kindLabel}</span>
              : {request.toolCall.title}
            </p>
            {loc && (
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {loc.path}
                {loc.line ? `:${loc.line}` : ""}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-amber-900/40 px-4 py-2.5">
          {request.options.map((opt, i) => {
            const isAllow = opt.kind.startsWith("allow");
            const isAlways = opt.kind.endsWith("always");
            return (
              <Button
                key={opt.optionId}
                ref={i === 0 ? firstBtn : undefined}
                size="sm"
                variant={
                  isAllow ? "default" : isAlways ? "destructive" : "secondary"
                }
                className={
                  isAllow
                    ? isAlways
                      ? "bg-emerald-700 text-emerald-50 hover:bg-emerald-600"
                      : "bg-emerald-900/70 text-emerald-100 hover:bg-emerald-800"
                    : undefined
                }
                onClick={() => onRespond(opt.optionId)}
              >
                {opt.name}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
