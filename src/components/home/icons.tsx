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

/** Analog clock (question timer). */
export function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 56" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="clock-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c9d2e0" />
          <stop offset="1" stopColor="#6b7a93" />
        </linearGradient>
      </defs>
      <circle
        cx="28"
        cy="28"
        r="25"
        fill="rgb(255 255 255 / .06)"
        stroke="url(#clock-rim)"
        strokeWidth="4.5"
      />
      {[0, 90, 180, 270].map((deg) => (
        <line
          key={deg}
          x1="28"
          y1="8.5"
          x2="28"
          y2="12.5"
          stroke="#c9d2e0"
          strokeWidth="2"
          strokeLinecap="round"
          transform={`rotate(${deg} 28 28)`}
        />
      ))}
      <path
        d="M28 15v13.5l9 5"
        fill="none"
        stroke="#e9eef7"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="28" cy="28" r="2.4" fill="#ff8a3d" />
    </svg>
  );
}

/** Small gold coin used by the wallet and the reward icon. */
function SmallCoin({ cx, cy, r = 7 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#f2c14e" stroke="#7a4d08" strokeWidth=".9" />
      <circle cx={cx} cy={cy} r={r * 0.62} fill="none" stroke="#b97a14" strokeWidth=".9" />
    </g>
  );
}

/** Wallet with coins dropping in (buy time). */
export function WalletIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 56" className={className} aria-hidden="true" focusable="false">
      <SmallCoin cx={34} cy={9} />
      <SmallCoin cx={46} cy={15} r={6} />
      <path
        d="M6 22a5 5 0 0 1 5-5h38a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5Z"
        fill="#9a5b2a"
        stroke="#5c3213"
        strokeWidth="1.6"
      />
      <path d="M6 28h48" stroke="#5c3213" strokeWidth="1.4" />
      <path
        d="M40 33h18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H40a6.5 6.5 0 0 1 0-13Z"
        fill="#c98240"
        stroke="#5c3213"
        strokeWidth="1.6"
      />
      <circle cx="42" cy="39.5" r="2.2" fill="#ffd36b" stroke="#5c3213" strokeWidth=".9" />
    </svg>
  );
}

/** Loose pile of coins (reward for an approved answer). */
export function CoinPileIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 44" className={className} aria-hidden="true" focusable="false">
      <SmallCoin cx={14} cy={32} r={9} />
      <SmallCoin cx={32} cy={34} r={9} />
      <SmallCoin cx={44} cy={26} r={8} />
      <SmallCoin cx={24} cy={19} r={9} />
      <SmallCoin cx={38} cy={12} r={8} />
    </svg>
  );
}

/** Arrow used by the question navigation buttons. Points right; mirrored with CSS for "back". */
export function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M4 12h15M13 5.5 19.5 12 13 18.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
