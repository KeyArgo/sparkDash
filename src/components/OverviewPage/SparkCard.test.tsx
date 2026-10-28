import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

function worker(): SparkSnapshot {
  return { ...makeSpark("w"), role: "worker", workerNode: true, workerHeadId: "h", workerLabel: "cfg-label" } as SparkSnapshot;
}
function head(online: boolean): SparkSnapshot {
  const h = makeSpark("h", online);
  return {
    ...h,
    role: "head",
    metrics: { ...h.metrics, llm: [{ available: true, backend: "vllm", modelId: "big-model", generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}

describe("SparkCard", () => {
  it.each([null, undefined, 0, 2])("renders queue %s without inventing a zero", (waiting) => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: 8, slotsTotal: 8,
      requestsRunning: 8, requestsWaiting: waiting,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain(
      waiting == null ? "8 running · queue unknown" : `8 running · ${waiting} queued`
    );
  });

  it("renders unknown slot occupancy without presenting it as zero", () => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: null, slotsTotal: 8, requestsRunning: null,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain("?/8 slots");
  });

  it("names the parallel capacity next to running and queued, so --parallel 4 and 8 read differently", () => {
    for (const total of [4, 8]) {
      const spark = makeSpark("fixture");
      Object.assign(spark.metrics.llm[0], {
        backend: "tensorfold", slotsActive: 1, slotsTotal: total, requestsRunning: 1, requestsWaiting: 0,
      });
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const chip = container.querySelector(".ov-chips")!;
      expect(chip.textContent).toContain(`1 running · 0 queued · ${total} slots`);
      expect(chip.querySelector(`[title="${total} requests decode in parallel on this engine · Requests being served / requests in queue. Waiting > 0 means someone is queued."]`)).not.toBeNull();
    }
  });

  it("adds no slot count when the engine reports no capacity", () => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "vllm", slotsActive: 0, slotsTotal: 0, requestsRunning: 2, requestsWaiting: 1,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const text = container.querySelector(".ov-chips")!.textContent!;
    expect(text).toContain("2 running · 1 queued");
    expect(text).not.toContain("slots");
  });
  it("lists private loaded models alongside the monitored model without duplicates", () => {
    const spark = head(true);
    spark.metrics.residentModels = [
      { modelId: "big-model", container: "primary-vllm" },
      { modelId: "datalab-to/surya-ocr-2", container: "surya-vllm" },
    ];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const rows = [...container.querySelectorAll(".ov-modelrow code")].map((row) => row.textContent);
    expect(rows).toEqual(["big-model", "datalab-to/surya-ocr-2"]);
    expect(container.querySelectorAll(".ov-modelrow")[1].textContent).toContain("Loaded");
  });

  it("does not present an offline unit's discovered models as loaded", () => {
    const spark = head(false);
    spark.metrics.residentModels = [{ modelId: "surya-private", container: "surya-vllm" }];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("surya-private");
  });
  it("is a plain container whose name is the only link; no interactive element nests another", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    const card = container.querySelector(".ov-sc")!;
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>("a.ov-sc__link")!;
    expect(link.textContent).toBe("Spark a");
    for (const el of card.querySelectorAll("button, a, [role=button]")) {
      expect(el.querySelector("button, a, [role=button]")).toBeNull();
    }
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("does not select when clicking the card body (only the stretched name does)", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    act(() => container.querySelector<HTMLElement>(".ov-sc__body")?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a worker shows its online head's model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(true)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("big-model");
  });

  it("a worker does not show an offline head's stale model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(false)} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("big-model");
    expect(container.textContent).toContain("cfg-label");
    expect(container.textContent).toContain("Head is offline");
  });

  it("an online head with no available probe is unready, not known to have no model", () => {
    // A head that is cold-starting or switching model produces the same empty probe
    // state as an idle one, so residency is unknown and must not be asserted.
    const unready = { ...head(true) } as SparkSnapshot;
    unready.metrics = {
      ...unready.metrics,
      llm: [{ available: false, backend: "vllm", modelId: null, generationTps: 0, prefillTps: 0, contextLength: null }],
    } as unknown as SparkSnapshot["metrics"];
    const bare = { ...worker(), workerLabel: "", workerDerivedLabel: "" } as SparkSnapshot;
    const { container } = render(<SparkCard spark={bare} headSpark={unready} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("No model");
    expect(container.textContent).toContain("not ready");
  });

  it("says when no LLM port is watched on the head instead of claiming no model", () => {
    const unwatched = { ...head(true) } as SparkSnapshot;
    unwatched.metrics = { ...unwatched.metrics, llm: [] } as unknown as SparkSnapshot["metrics"];
    const bare = { ...worker(), workerLabel: "", workerDerivedLabel: "" } as SparkSnapshot;
    const { container } = render(<SparkCard spark={bare} headSpark={unwatched} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("No model");
    expect(container.textContent).toContain("No LLM port is watched on the head");
  });
});

describe("SparkCard per-stream decode rate", () => {
  it("shows the per-stream rate when the engine reports one", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { generationTps: 40, perStreamTps: 18.5 });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("18.5 tok/s per stream");
  });
  it("omits the per-stream line when the engine has no histogram", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { generationTps: 40, perStreamTps: null });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("per stream");
  });
});

describe("SparkCard effective prefill rate", () => {
  it("labels the per-request prefill as effective (incl. cached tokens)", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { prefillTps: 2813, perStreamPrefillTps: 2813 });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("2,813 tok/s per request — effective (incl. cached tokens)");
  });
  it("omits the prefill line when no request has finished", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { prefillTps: 0, perStreamPrefillTps: null });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("effective (incl. cached tokens)");
  });
});

describe("SparkCard muted LLM telemetry line", () => {
  function telemetrySpark(): SparkSnapshot {
    const spark = makeSpark("t") as SparkSnapshot & { llm?: unknown };
    spark.id = "t";
    spark.name = "Spark t";
    spark.llm = {
      serving: true,
      model: "qwen-35b",
      tok_per_s: 48.5,
      decode_tps: 48.5,
      prefill_s: 1.25,
      ttft_s: 0.8,
      kv_pct: 62.4,
      running: 2,
      waiting: 1,
      clients: [],
      guests: {},
    };
    return spark as unknown as SparkSnapshot;
  }

  it("gives each metric on the muted line a plain-language hover tooltip", () => {
    const { container } = render(<SparkCard spark={telemetrySpark()} temperatureUnit="celsius" />);
    const line = container.querySelector(".ov-sc__llm")!;
    expect(line.textContent).toContain("48.5 tok/s");
    const spanTitle = (text: string) =>
      [...line.querySelectorAll("span")].find((s) => s.textContent?.includes(text))?.getAttribute("title") ?? null;
    expect(spanTitle("48.5 tok/s")).toBe("Generation speed — tokens written per second while answering.");
    expect(spanTitle("prefill 1.3s")).toBe("Seconds spent reading the prompt before the first word. Long = huge context or a cold cache.");
    expect(spanTitle("ttft 800ms")).toBe("Time to first token — total wait before the answer starts (queue + prefill).");
    expect(spanTitle("kv 62%")).toBe("How full the context memory is. Near 100% = oldest conversations get evicted.");
  });

  it("splits the muted line into segments with the same ' · ' joins", () => {
    const { container } = render(<SparkCard spark={telemetrySpark()} temperatureUnit="celsius" />);
    const line = container.querySelector(".ov-sc__llm")!;
    expect(line.textContent).toContain("LLM qwen-35b · 48.5 tok/s · prefill 1.3s · ttft 800ms · kv 62%");
  });

  it("opens the 'What these mean' popover from the line's ? icon", () => {
    const { container } = render(<SparkCard spark={telemetrySpark()} temperatureUnit="celsius" />);
    const trigger = container.querySelector<HTMLElement>('[aria-label="What these mean"]')!;
    expect(trigger).not.toBeNull();
    expect(container.textContent).not.toContain("running / waiting");
    act(() => trigger.click());
    expect(container.textContent).toContain("What these mean");
    expect(container.textContent).toContain("Requests being served / requests in queue. Waiting > 0 means someone is queued.");
    expect(container.textContent).toContain("Green numbers are good; prefill and ttft are waits, tok/s is speed.");
  });

  it("shows no ? icon when there is no LLM telemetry", () => {
    const { container } = render(<SparkCard spark={makeSpark("t")} temperatureUnit="celsius" />);
    expect(container.querySelector('[aria-label="What these mean"]')).toBeNull();
  });
});
