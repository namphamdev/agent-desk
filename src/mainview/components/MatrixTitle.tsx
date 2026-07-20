import { useEffect, useState } from "react";

const MATRIX_TITLE = "Agent Desk";
const MATRIX_GLYPHS =
  "01ABCDEFGHIJKLMNOPQRSTUVWXYZアカサタナハマヤラワ#$%&@*+";

/** Matrix-style glyph scramble that settles into "Agent Desk". */
export function MatrixTitle({
  className = "font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-500 dark:text-emerald-400",
}: {
  className?: string;
}) {
  const [chars, setChars] = useState<string[]>(() =>
    MATRIX_TITLE.split("").map((c) => (c === " " ? " " : "·")),
  );

  useEffect(() => {
    let frame = 0;
    let settleAt = 0;
    let holdUntil = 0;
    let phase: "scramble" | "hold" = "scramble";
    let raf = 0;
    let last = 0;

    const tick = (now: number) => {
      if (now - last < 40) {
        raf = requestAnimationFrame(tick);
        return;
      }
      last = now;

      if (phase === "hold") {
        if (now >= holdUntil) {
          phase = "scramble";
          frame = 0;
          settleAt = 0;
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      frame += 1;
      // Cascade settle left → right, matrix-style.
      if (frame % 3 === 0) settleAt = Math.min(MATRIX_TITLE.length, settleAt + 1);

      setChars(
        MATRIX_TITLE.split("").map((target, i) => {
          if (target === " ") return " ";
          if (i < settleAt) return target;
          return MATRIX_GLYPHS[(Math.random() * MATRIX_GLYPHS.length) | 0]!;
        }),
      );

      if (settleAt >= MATRIX_TITLE.length) {
        phase = "hold";
        holdUntil = now + 2800;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span
      aria-label="Agent Desk"
      className={className}
      style={{
        textShadow:
          "0 0 8px color-mix(in oklab, var(--color-emerald-400) 55%, transparent)",
      }}
    >
      {chars.map((c, i) => (
        <span
          key={i}
          className={
            MATRIX_TITLE[i] === c || MATRIX_TITLE[i] === " "
              ? "opacity-100"
              : "opacity-55"
          }
        >
          {c === " " ? "\u00a0" : c}
        </span>
      ))}
    </span>
  );
}
