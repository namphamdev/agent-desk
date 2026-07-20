import { useEffect, useMemo, useRef, useState } from "react";
import type { UserQuestionRequest } from "../../shared/rpc";
import { Button } from "@/components/ui/button";

export type UserQuestionReply =
  | {
      action: "accepted";
      answers: Record<string, string>;
      partialAnswers?: boolean;
    }
  | { action: "skip_interview" }
  | { action: "chat_about_this"; message?: string };

type Props = {
  request: UserQuestionRequest;
  onRespond: (decision: UserQuestionReply) => void;
};

/**
 * Grok `_x.ai/ask_user_question` questionnaire. Answers are keyed by the
 * full question text (agent wire format).
 */
export function UserQuestionPrompt({ request, onRespond }: Props) {
  const firstBtn = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState("");
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());

  const questions = request.questions;
  const current = questions[index];
  const total = questions.length;

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setOtherText("");
    setMultiSelected(new Set());
  }, [request.requestId]);

  useEffect(() => {
    firstBtn.current?.focus();
    setOtherText("");
    setMultiSelected(new Set());
  }, [index, request.requestId]);

  const progress = useMemo(
    () => (total > 1 ? `${index + 1} / ${total}` : null),
    [index, total],
  );

  if (!current) return null;

  const commitAnswer = (value: string) => {
    const next = { ...answers, [current.question]: value };
    setAnswers(next);
    if (index + 1 < total) {
      setIndex(index + 1);
      return;
    }
    onRespond({ action: "accepted", answers: next });
  };

  const toggleMulti = (label: string) => {
    setMultiSelected((prev) => {
      const n = new Set(prev);
      if (n.has(label)) n.delete(label);
      else n.add(label);
      return n;
    });
  };

  const submitMulti = () => {
    const labels = [...multiSelected];
    if (labels.length === 0 && !otherText.trim()) return;
    const value = [
      ...labels,
      ...(otherText.trim() ? [otherText.trim()] : []),
    ].join(", ");
    commitAnswer(value);
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center px-6 md:left-64"
      role="alertdialog"
      aria-labelledby="uq-title"
      aria-describedby="uq-desc"
    >
      <div className="pointer-events-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-sky-700/50 bg-[#0f1720] shadow-2xl dark:bg-[#0f1720]">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-900/50 text-sky-300">
            ?
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="uq-title" className="text-sm font-semibold text-sky-100">
                {current.header ?? "Question from agent"}
              </h2>
              {progress && (
                <span className="text-[11px] text-muted-foreground">
                  {progress}
                </span>
              )}
            </div>
            <p id="uq-desc" className="mt-1 text-sm text-foreground">
              {current.question}
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-sky-900/40 px-4 py-3">
          {current.multiSelect ? (
            <>
              <div className="flex flex-col gap-1.5">
                {current.options.map((opt, i) => {
                  const on = multiSelected.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      ref={i === 0 ? firstBtn : undefined}
                      type="button"
                      onClick={() => toggleMulti(opt.label)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        on
                          ? "border-sky-500/70 bg-sky-900/40 text-sky-50"
                          : "border-border/60 bg-background/40 text-foreground hover:border-sky-700/50"
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      {opt.description && (
                        <div className="mt-0.5 text-[12px] text-muted-foreground">
                          {opt.description}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <input
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="Other (optional free text)"
                className="w-full rounded-md border border-border/60 bg-background/50 px-3 py-2 text-sm outline-none focus:border-sky-600"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={multiSelected.size === 0 && !otherText.trim()}
                  onClick={submitMulti}
                >
                  {index + 1 < total ? "Next" : "Submit"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                {current.options.map((opt, i) => (
                  <button
                    key={opt.label}
                    ref={i === 0 ? firstBtn : undefined}
                    type="button"
                    onClick={() => commitAnswer(opt.label)}
                    className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-left text-sm text-foreground transition-colors hover:border-sky-700/50 hover:bg-sky-950/30"
                  >
                    <div className="font-medium">{opt.label}</div>
                    {opt.description && (
                      <div className="mt-0.5 text-[12px] text-muted-foreground">
                        {opt.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && otherText.trim()) {
                      commitAnswer(otherText.trim());
                    }
                  }}
                  placeholder="Or type your own answer…"
                  className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-sm outline-none focus:border-sky-600"
                />
                <Button
                  size="sm"
                  disabled={!otherText.trim()}
                  onClick={() => commitAnswer(otherText.trim())}
                >
                  {index + 1 < total ? "Next" : "Submit"}
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-sky-900/40 px-4 py-2.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onRespond({
                action: "chat_about_this",
                message: "I'd like to discuss these options further.",
              })
            }
          >
            Chat about this
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRespond({ action: "skip_interview" })}
          >
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}
