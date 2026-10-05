import { describe, expect, it } from "vitest";

import { cssVars } from "@/lib/css";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins and drops falsy values", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });
  it("lets later Tailwind utilities win", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

describe("cssVars", () => {
  it("passes custom properties through unchanged", () => {
    expect(cssVars({ "--rd": "0.5s", "--k": -10 })).toEqual({ "--rd": "0.5s", "--k": -10 });
  });
});
