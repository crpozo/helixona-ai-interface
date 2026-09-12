import { useState } from "react";
import { brand } from "../brand";

interface Props { variant?: "sidebar" | "login"; showTagline?: boolean }

/** Logo de la marca: usa /brand/logo.svg (mismo origen, permitido por la CSP) y cae al nombre en texto si no existe. */
export function Logo({ variant = "sidebar", showTagline = false }: Props) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`logo${variant === "login" ? " logo-login" : ""}`}>
      {!failed ? (
        <img src={brand.logoUrl} alt={brand.name} onError={() => setFailed(true)} />
      ) : (
        <span className="logo-text">{brand.name}</span>
      )}
      {showTagline && <span className="logo-sub">{brand.tagline}</span>}
    </span>
  );
}
