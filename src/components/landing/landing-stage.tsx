"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { startLiquidBackground } from "@/lib/webgl/liquid-background";

/**
 * Client boundary for the landing page. It owns only the WebGL canvas lifecycle;
 * everything rendered inside (logos, role selector) is passed in as server-rendered
 * children, so the interactive JS stays minimal.
 */
export function LandingStage({ children }: { children: ReactNode }) {
  const stageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    return startLiquidBackground(canvas, {
      stage,
      onFallback: () => stage.setAttribute("data-fallback", "true"),
    });
  }, []);

  return (
    <main ref={stageRef} className="landing-stage" data-fallback="false">
      <h1 className="sr-only">Mathematics Club, IIT (ISM) Dhanbad — Competition Portal</h1>
      <canvas ref={canvasRef} className="scene" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
      {children}
    </main>
  );
}
