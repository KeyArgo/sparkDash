import { act } from "react";
import { describe, expect, it } from "vitest";
import { LlmHelpPopover } from "./LlmHelpPopover";
import { render } from "../../testing/render";

describe("LlmHelpPopover", () => {
  it("lists every metric in reading order with the green-numbers footnote", () => {
    const { container } = render(<LlmHelpPopover />);
    const trigger = container.querySelector<HTMLElement>('[aria-label="What these mean"]')!;
    expect(trigger).not.toBeNull();
    act(() => trigger.click());
    const panel = container.querySelector("[role=note]")!;
    expect(panel.textContent).toContain("What these mean");
    const terms = [...panel.querySelectorAll("dt")].map((t) => t.textContent);
    expect(terms).toEqual(["tok/s", "prefill", "ttft", "kv %", "running / waiting", "cached"]);
    expect(panel.textContent).toContain("Green numbers are good; prefill and ttft are waits, tok/s is speed.");
    expect(panel.textContent).toContain("Generation speed — tokens written per second while answering.");
  });

  it("closes on Escape", () => {
    const { container } = render(<LlmHelpPopover />);
    const trigger = container.querySelector<HTMLElement>('[aria-label="What these mean"]')!;
    act(() => trigger.click());
    expect(container.querySelector("[role=note]")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[role=note]")).toBeNull();
  });
});
