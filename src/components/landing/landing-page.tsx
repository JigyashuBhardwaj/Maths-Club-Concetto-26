import Image from "next/image";

import { cssVars } from "@/lib/css";

import { LandingStage } from "./landing-stage";
import { RoleSelector } from "./role-selector";

/**
 * The portal landing page. Layout, copy and assets reproduce the supplied
 * "Mathematics Club Portal" design; see docs/VISUAL_FOUNDATION.md.
 * Images are pre-optimised WebP served as-is (`unoptimized`) — no image-optimizer
 * dependency or quota on the venue day.
 */
export function LandingPage() {
  return (
    <LandingStage>
      {/* primary event mark */}
      <div className="mark par reveal" style={cssVars({ "--rd": "0.5s" })}>
        <div className="float" style={cssVars({ "--dur": "10s" })}>
          <Image
            src="/brand/event-mark.webp"
            alt="Event mark"
            width={480}
            height={489}
            priority
            unoptimized
          />
        </div>
      </div>

      {/* role selection */}
      <div className="panel-wrap reveal" style={cssVars({ "--rd": "0.9s" })}>
        <RoleSelector />
      </div>

      {/* institute + club identity */}
      <div className="id left par reveal" style={cssVars({ "--rd": "1.3s" })}>
        <div className="float" style={cssVars({ "--dur": "11s", "--delay": "-3s" })}>
          <Image
            src="/brand/iit-ism.webp"
            alt="IIT (ISM) Dhanbad"
            width={320}
            height={340}
            unoptimized
          />
        </div>
      </div>
      <div className="id right par reveal" style={cssVars({ "--rd": "1.5s" })}>
        <div className="float" style={cssVars({ "--dur": "12s", "--delay": "-6s" })}>
          <Image
            src="/brand/math-club.webp"
            alt="Mathematics Club IIT (ISM)"
            width={320}
            height={320}
            unoptimized
          />
        </div>
      </div>
    </LandingStage>
  );
}
