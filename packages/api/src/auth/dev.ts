import type { IdentityProvider, IdentityResult, OidcPending } from "./cognito.js";

/** Solo desarrollo: no hay Cognito. `AUTH_MODE=dev` se rechaza en producción (config.ts). */
export class DevIdentityProvider implements IdentityProvider {
  beginLogin() { return { url: "/login", pending: { state: "dev", verifier: "dev", exp: Date.now() + 60_000 } as OidcPending }; }
  async completeLogin(): Promise<IdentityResult> { throw new Error("not applicable in dev mode"); }
  async revoke(): Promise<void> {}
  logoutUrl() { return "/login"; }
}
