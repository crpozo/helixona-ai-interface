/**
 * Clinic brand. To use the official logo file from helixona.com:
 *  1. Put it in `public/brand/` (e.g. `Helixona-Logo.png`, white wordmark on transparent).
 *  2. Set `logoImage` below to `${import.meta.env.BASE_URL}brand/Helixona-Logo.png`.
 * While `logoImage` is null the app renders the HELIXONA wordmark with the gold "X" in CSS/SVG.
 * Colors and typography live in `src/brand.css` (one file). Fonts are self-hosted in `public/fonts/`
 * because the CSP does not allow remote fonts.
 */
export const brand = {
  name: "Helixona",
  productName: "Helixona Assistant",
  tagline: "Internal use · authorized staff only",
  // Official wordmark from the clinic (white letters, gold X, transparent background).
  logoImage: `${import.meta.env.BASE_URL}brand/Helixona-Logo.png` as string | null,
} as const;
