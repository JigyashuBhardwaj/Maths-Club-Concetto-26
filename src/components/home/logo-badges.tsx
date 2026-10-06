import Image from "next/image";

import { cssVars } from "@/lib/css";

/**
 * The three logos as slightly overlapping circular badges, top-left. They keep the landing page's
 * motion: a gentle float plus pointer parallax (driven by --px/--py on the stage).
 */
export function LogoBadges() {
  return (
    <div className="logo-badges">
      <div className="badge par" style={cssVars({ "--k": 6 })}>
        <div className="float" style={cssVars({ "--dur": "11s", "--delay": "-3s" })}>
          <span className="badge-disc">
            <Image
              src="/brand/iit-ism.webp"
              alt="IIT (ISM) Dhanbad"
              width={320}
              height={340}
              unoptimized
              priority
            />
          </span>
        </div>
      </div>
      <div className="badge par" style={cssVars({ "--k": -6 })}>
        <div className="float" style={cssVars({ "--dur": "10s" })}>
          <span className="badge-disc badge-mark">
            <Image
              src="/brand/event-mark.webp"
              alt="Event mark"
              width={480}
              height={489}
              unoptimized
              priority
            />
          </span>
        </div>
      </div>
      <div className="badge par" style={cssVars({ "--k": 6 })}>
        <div className="float" style={cssVars({ "--dur": "12s", "--delay": "-6s" })}>
          <span className="badge-disc badge-club">
            <Image
              src="/brand/math-club.webp"
              alt="Mathematics Club IIT (ISM)"
              width={320}
              height={320}
              unoptimized
              priority
            />
          </span>
        </div>
      </div>
    </div>
  );
}
