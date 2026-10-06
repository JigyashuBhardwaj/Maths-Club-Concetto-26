"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { startLiquidBackground } from "@/lib/webgl/liquid-background";

/**
 * Client boundary for the participant home page. Same liquid WebGL background as the landing page
 * (shared module, shared shader), pinned to the viewport; everything inside is server-rendered children.
 */
export function HomeStage({ children }: { children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
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
    <div ref={stageRef} className="home-stage" data-fallback="false">
      <canvas ref={canvasRef} className="scene" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
      {children}
    </div>
  );
}
