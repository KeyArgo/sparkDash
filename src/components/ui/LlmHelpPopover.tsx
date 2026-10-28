import { useEffect, useRef, useState } from "react";
import { HelpIcon } from "./icons";
import { LLM_METRIC_HELP_ENTRIES, LLM_HELP_FOOTNOTE } from "../../shared/llmHelp";

/**
 * Subtle "(i)" trigger that opens a plain-language definition list of the LLM
 * telemetry terms. Icon-only trigger, so the accessible label carries the
 * meaning ("What these mean").
 */
export function LlmHelpPopover({ align = "end" }: { align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="relative inline-flex" ref={root}>
      <button
        type="button"
        className="cursor-pointer opacity-60 hover:opacity-100"
        aria-label="What these mean"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <HelpIcon className="h-2.5 w-2.5 align-middle" />
      </button>
      {open ? (
        <div
          role="note"
          aria-label="What these mean"
          className={`absolute top-full z-30 mt-1 w-72 max-w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-border-strong bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${
            align === "end" ? "right-0 left-auto" : "left-0 right-auto"
          }`}
        >
          <div className="mb-1 font-semibold">What these mean</div>
          <dl>
            {LLM_METRIC_HELP_ENTRIES.map((e) => (
              <div key={e.term} className="mt-1 first:mt-0">
                <dt className="font-semibold">{e.term}</dt>
                <dd>{e.text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-muted">{LLM_HELP_FOOTNOTE}</p>
        </div>
      ) : null}
    </span>
  );
}
