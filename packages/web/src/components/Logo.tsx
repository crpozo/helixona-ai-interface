import { brand } from "../brand";

interface Props { variant?: "sidebar" | "login"; showTagline?: boolean }

/**
 * Brand logo. Renders the official image when `brand.logoImage` is set (same origin, allowed by
 * the CSP); otherwise a vector recreation of the official HELIXONA wordmark: thin white letters with
 * wide tracking and a hollow gold "X", taller than the letters, crossed by a thin diagonal slash.
 */
export function Logo({ variant = "sidebar", showTagline = false }: Props) {
  return (
    <span className={`logo${variant === "login" ? " logo-login" : ""}`}>
      {brand.logoImage ? <img src={brand.logoImage} alt={brand.name} /> : <Wordmark />}
      {showTagline && <span className="logo-sub">{brand.tagline}</span>}
    </span>
  );
}

function Wordmark() {
  return (
    <span className="wordmark" role="img" aria-label={brand.name}>
      <span aria-hidden="true">HELI</span>
      <svg className="wordmark-x" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="hx-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1d6a0" />
            <stop offset="0.55" stopColor="#d6b981" />
            <stop offset="1" stopColor="#c9a227" />
          </linearGradient>
        </defs>
        {/* thin slash running through the X, longer than the letters */}
        <line x1="21" y1="-6" x2="47" y2="70" stroke="url(#hx-gold)" strokeWidth="1.1" strokeLinecap="round" opacity="0.9" />
        {/* hollow X */}
        <polygon
          points="12,12 21,12 32,27 43,12 52,12 37,32 52,52 43,52 32,37 21,52 12,52 27,32"
          fill="none"
          stroke="url(#hx-gold)"
          strokeWidth="2.4"
          strokeLinejoin="miter"
        />
      </svg>
      <span aria-hidden="true">ONA</span>
    </span>
  );
}
