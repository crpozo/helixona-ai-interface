/**
 * Marca de la clínica. Para aplicar la identidad de helixona.com:
 *  1. Reemplaza `public/brand/logo.svg` (y opcionalmente `logo-mark.svg`) por los archivos oficiales.
 *  2. Ajusta los tokens de color y tipografía en `src/brand.css` (un solo archivo).
 *  3. Si la tipografía es de pago o web, colócala en `public/fonts/` y decláralo con @font-face en brand.css
 *     (la CSP no permite fuentes remotas; deben servirse desde el mismo origen).
 */
export const brand = {
  name: "Helixona",
  productName: "Asistente Helixona",
  tagline: "Uso interno · personal autorizado",
  logoUrl: "/brand/logo.svg",
  logoMarkUrl: "/brand/logo-mark.svg",
} as const;
