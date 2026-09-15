import { brand } from "../brand";

interface Props { variant?: "sidebar" | "login"; showTagline?: boolean }

/**
 * Brand logo. Renders the official image when `brand.logoImage` is set (same origin, allowed by
 * the CSP); otherwise the HELIXONA wordmark with the gold helix "X", as on helixona.com.
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
      <svg className="wordmark-x" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="hx-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1d6a0" />
            <stop offset="1" stopColor="#c9a227" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#hx-gold)" strokeLinecap="round">
          <path d="M6 4 C 20 13, 20 27, 34 36" strokeWidth="3.6" />
          <path d="M34 4 C 20 13, 20 27, 6 36" strokeWidth="3.6" />
          <path d="M13.5 11.5 H 26.5 M13.5 28.5 H 26.5" strokeWidth="2" opacity="0.75" />
        </g>
      </svg>
      <span aria-hidden="true">ONA</span>
    </span>
  );
}
