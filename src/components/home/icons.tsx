/** Inline SVG icons for the home header. Decorative: the adjacent text carries the meaning. */

export function HourglassIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hg-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="1" stopColor="#c98a1c" />
        </linearGradient>
        <linearGradient id="hg-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd36b" />
          <stop offset="1" stopColor="#ff9a2e" />
        </linearGradient>
      </defs>
      {/* glass */}
      <path
        d="M10 8h28c0 12-8 17-11 24 3 7 11 12 11 24H10c0-12 8-17 11-24-3-7-11-12-11-24Z"
        fill="rgb(255 255 255 / .06)"
        stroke="url(#hg-gold)"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* sand: upper chamber, stream, lower pile */}
      <path d="M15 11h18c-.6 7-5.2 10.5-9 14.5C20.2 21.5 15.6 18 15 11Z" fill="url(#hg-sand)" />
      <rect x="23.2" y="26" width="1.6" height="13" fill="url(#hg-sand)" />
      <path d="M14.6 53c1.4-6.5 6-10.5 9.4-10.5s8 4 9.4 10.5Z" fill="url(#hg-sand)" />
      {/* caps */}
      <rect x="6" y="2" width="36" height="6" rx="2.4" fill="url(#hg-gold)" />
      <rect x="6" y="56" width="36" height="6" rx="2.4" fill="url(#hg-gold)" />
    </svg>
  );
}

function Coin({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <path
        d={`M${cx - 13} ${cy}v5a13 5 0 0 0 26 0v-5Z`}
        fill="#b97a14"
        stroke="#7a4d08"
        strokeWidth=".8"
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx="13"
        ry="5"
        fill="url(#coin-gold)"
        stroke="#7a4d08"
        strokeWidth=".8"
      />
      <ellipse cx={cx} cy={cy} rx="8.5" ry="3" fill="none" stroke="#b97a14" strokeWidth=".9" />
    </g>
  );
}

export function CoinsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 56" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="coin-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe9a3" />
          <stop offset="1" stopColor="#e2a52b" />
        </linearGradient>
      </defs>
      {/* back-left stack */}
      <Coin cx={19} cy={42} />
      <Coin cx={19} cy={36} />
      {/* tall centre stack */}
      <Coin cx={38} cy={44} />
      <Coin cx={38} cy={38} />
      <Coin cx={38} cy={32} />
      <Coin cx={38} cy={26} />
      <Coin cx={38} cy={20} />
      <Coin cx={38} cy={14} />
      {/* right stack */}
      <Coin cx={53} cy={46} />
      <Coin cx={53} cy={40} />
    </svg>
  );
}

export function InfoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="24" cy="14.5" r="2.8" fill="currentColor" />
      <path d="M24 21.5v14" stroke="currentColor" strokeWidth="4.2" strokeLinecap="round" />
    </svg>
  );
}
