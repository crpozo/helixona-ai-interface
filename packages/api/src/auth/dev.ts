import type { IdentityProvider, IdentityResult, OidcPending } from "./cognito.js";

/** Solo desarrollo: no hay Cognito. `AUTH_MODE=dev` se rechaza en producción (config.ts). */
export class DevIdentityProvider implements IdentityProvider {
  beginLogin() { return { url: "/login", pending: { state: "dev", verifier: "dev", exp: Date.now() + 60_000 } as OidcPending }; }
  async completeLogin(): Promise<IdentityResult> { throw new Error("no aplica en modo dev"); }
  async revoke(): Promise<void> {}
  logoutUrl() { return "/login"; }
}
