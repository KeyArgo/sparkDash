/**
 * Plain-language explanations for the LLM telemetry a non-expert sees on the
 * overview card's muted LLM line and the detailed metrics tiles. Shared so the
 * wording stays identical everywhere.
 */
export const LLM_METRIC_HELP = {
  tokPerS: "Generation speed — tokens written per second while answering.",
  prefill: "Seconds spent reading the prompt before the first word. Long = huge context or a cold cache.",
  ttft: "Time to first token — total wait before the answer starts (queue + prefill).",
  kv: "How full the context memory is. Near 100% = oldest conversations get evicted.",
  runningWaiting: "Requests being served / requests in queue. Waiting > 0 means someone is queued.",
  cached: "Share of prompt read from cache instead of recomputed. Higher = cheaper and faster.",
} as const;

export type LlmMetricHelpKey = keyof typeof LLM_METRIC_HELP;

/** Popover listing in reading order: term + plain-language explanation. */
export const LLM_METRIC_HELP_ENTRIES: { term: string; text: string }[] = [
  { term: "tok/s", text: LLM_METRIC_HELP.tokPerS },
  { term: "prefill", text: LLM_METRIC_HELP.prefill },
  { term: "ttft", text: LLM_METRIC_HELP.ttft },
  { term: "kv %", text: LLM_METRIC_HELP.kv },
  { term: "running / waiting", text: LLM_METRIC_HELP.runningWaiting },
  { term: "cached", text: LLM_METRIC_HELP.cached },
];

export const LLM_HELP_FOOTNOTE = "Green numbers are good; prefill and ttft are waits, tok/s is speed.";
