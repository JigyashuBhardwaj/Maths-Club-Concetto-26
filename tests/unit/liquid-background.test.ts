// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { startLiquidBackground } from "@/lib/webgl/liquid-background";

describe("startLiquidBackground", () => {
  it("falls back cleanly when WebGL is unavailable", () => {
    const canvas = document.createElement("canvas");
    // jsdom has no WebGL: getContext returns null.
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    const onFallback = vi.fn();
    const stop = startLiquidBackground(canvas, {
      stage: document.createElement("main"),
      onFallback,
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });
});
