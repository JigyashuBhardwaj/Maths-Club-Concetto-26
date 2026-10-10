// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContentText, isPreformattedLine, splitBlocks } from "@/components/ui/content-text";

import content from "../../content/concetto26/official-content.json";

const q = (id: string) => content.questions.find((x) => x.id === id)!.question;

describe("isPreformattedLine / splitBlocks", () => {
  it("treats prose as prose and aligned lines (3+ spaces) as preformatted", () => {
    expect(isPreformattedLine("Find the value of x.")).toBe(false);
    expect(isPreformattedLine("two  spaces are still prose")).toBe(false);
    expect(isPreformattedLine("    A[i] = (i^2 + 3*i) (mod 50)")).toBe(true);
    expect(isPreformattedLine("Player A  Bluff (B)      −4           6")).toBe(true);
    expect(isPreformattedLine("")).toBe(false);
  });

  it("keeps every character: joining the blocks again gives the original text", () => {
    for (const x of content.questions) {
      for (const text of [x.question, x.hint1, x.hint2]) {
        const joined = splitBlocks(text)
          .map((b) => b.lines.join("\n"))
          .join("\n");
        expect(joined, x.id).toBe(text);
      }
    }
  });
});

describe("ContentText", () => {
  it("renders E.3's payoff table in a monospace block that keeps its columns", () => {
    const { container } = render(<ContentText text={q("E.3")} />);
    const pre = container.querySelector("pre.content-pre")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("Player A  Bluff (B)      −4           6");
    expect(pre.textContent).toContain("          Play Safe (S)   3          −2");
    expect(pre).toHaveAttribute("tabindex", "0"); // scrollable by keyboard on a narrow screen
    expect(container.querySelector("p.content-p")!.textContent).toContain("Two poker players");
  });

  it("keeps the indented formula and the numbered tasks of A.4 line by line", () => {
    const { container } = render(<ContentText text={q("A.4")} />);
    expect(container.querySelector("pre.content-pre")!.textContent).toBe(
      "    A[i] = (i^2 + 3*i) (mod 50)   for 1 <= i <= 1000",
    );
    expect(container.textContent).toContain("1. Define the prefix sum sequence");
    expect(container.textContent).toContain("2. Let C_r be the frequency");
  });

  it("shows Greek letters, sub/superscripts, roots, integrals and sums exactly as typed", () => {
    const sample = "θ μ σ² Σₙ₌₁^∞ n^(a/2)/2ⁿ ∫₀^1 √x dx x₁ ≤ y ≠ z ∏ ₹ π";
    const { container } = render(<ContentText text={sample} />);
    expect(container.textContent).toBe(sample);
  });

  it("never interprets markup: HTML, Markdown and entities stay literal text", () => {
    const evil =
      '<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold** [l](javascript:alert(3)) &lt;b&gt;';
    const { container } = render(<ContentText text={evil} />);
    expect(container.querySelector("img, script, a, b, strong")).toBeNull();
    expect(container.textContent).toBe(evil);
  });

  it("keeps blank lines and line breaks (pre-wrap prose)", () => {
    const { container } = render(<ContentText text={"first\n\nsecond"} />);
    const p = container.querySelector("p.content-p")!;
    expect(p.textContent).toBe("first\n\nsecond");
  });

  it("renders every official question and hint without markup injection and with all its text", () => {
    for (const x of content.questions) {
      for (const text of [x.question, x.hint1, x.hint2]) {
        const { container, unmount } = render(<ContentText text={text} />);
        const root = container.firstElementChild!;
        const shown = Array.from(root.children)
          .map((c) => c.textContent)
          .join("\n");
        expect(shown, x.id).toBe(text);
        expect(container.querySelector("script, img, iframe, a"), x.id).toBeNull();
        unmount();
      }
    }
  });
});
