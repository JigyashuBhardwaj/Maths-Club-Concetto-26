// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";

describe("ui primitives", () => {
  it("Button defaults to type=button and merges className", () => {
    render(<Button className="w-full">Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("w-full");
  });

  it("GlassPanel forwards props", () => {
    render(<GlassPanel data-testid="p" className="extra" />);
    expect(screen.getByTestId("p")).toHaveClass("extra", "bg-glass");
  });
});
