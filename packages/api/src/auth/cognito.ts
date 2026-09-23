import { createHash, randomBytes } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { AdminCreateUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand, AdminSetUserMFAPreferenceCommand, CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand, AdminUserGlobalSignOutCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { Role } from "@helixona/core";
import type { DirectoryUser, UserDirectory } from "../repos/types.js";

export interface CognitoConfig { region: string; userPoolId: string; clientId: string; clientSecret: string; domain: string; redirectUri: string; logoutUri: string }

export interface OidcPending { state: string; verifier: string; exp: number }

export interface IdentityResult { id: string; email: string; name: string; roles: Role[]; refreshToken: string | null }

export interface IdentityProvider {
  /** Construye la URL de autorización y el estado pendiente (se guarda en cookie firmada de corta vida). */
  beginLogin(): { url: string; pending: OidcPending };
  completeLogin(code: string, pending: OidcPending): Promise<IdentityResult>;
  revoke(refreshToken: string | null): Promise<void>;
  logoutUrl(): string;
}

function b64url(buf: Buffer): string { return buf.toString("base64url"); }

/** Authorization Code + PKCE contra los endpoints OIDC de Cognito (Managed Login). App client confidencial. */
export class CognitoIdentityProvider implements IdentityProvider {
  private readonly verifier;
  constructor(private readonly cfg: CognitoConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, tokenUse: "id", clientId: cfg.clientId });
  }

  beginLogin() {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const u = new URL("/oauth2/authorize", this.cfg.domain);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return { url: u.toString(), pending: { state, verifier, exp: Date.now() + 10 * 60_000 } };
  }

  async completeLogin(code: string, pending: OidcPending): Promise<IdentityResult> {
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: this.cfg.clientId, code, redirect_uri: this.cfg.redirectUri, code_verifier: pending.verifier });
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(new URL("/oauth2/token", this.cfg.domain), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` }, body });
    if (!res.ok) throw new Error(`token_endpoint_${res.status}`);
    const tokens = (await res.json()) as { id_token: string; refresh_token?: string };
    const payload = await this.verifier.verify(tokens.id_token);
    const groups = (payload["cognito:groups"] as string[] | undefined) ?? [];
    const roles: Role[] = groups.includes("admin") ? ["staff", "admin"] : ["staff"];
    return {
      id: String(payload.sub),
      email: String(payload["email"] ?? ""),
      name: String(payload["name"] ?? payload["email"] ?? ""),
      roles,
      refreshToken: tokens.refresh_token ?? null,
    };
  }

  async revoke(refreshToken: string | null): Promise<void> {
    if (!refreshToken) return;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    await this.fetchImpl(new URL("/oauth2/revoke", this.cfg.domain), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` }, body: new URLSearchParams({ token: refreshToken, client_id: this.cfg.clientId }) }).catch(() => {});
  }

  logoutUrl(): string {
    const u = new URL("/logout", this.cfg.domain);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("logout_uri", this.cfg.logoutUri);
    return u.toString();
  }
}

/** Directorio de usuarios sobre el User Pool (altas, bajas). Las acciones se auditan en la app con el admin humano. */
export class CognitoUserDirectory implements UserDirectory {
  private readonly client: CognitoIdentityProviderClient;
  constructor(private readonly region: string, private readonly userPoolId: string) { this.client = new CognitoIdentityProviderClient({ region }); }

  async list(): Promise<DirectoryUser[]> {
    const admins = await this.adminUsernames();
    const out: DirectoryUser[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListUsersCommand({ UserPoolId: this.userPoolId, PaginationToken: token, Limit: 60 }));
      for (const u of r.Users ?? []) {
        const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value ?? "";
        out.push({
          id: attr("sub") || (u.Username ?? ""),
          email: attr("email"),
          name: attr("name"),
          role: admins.has(u.Username ?? "") ? "admin" : "staff",
          enabled: u.Enabled ?? false,
          createdAt: u.UserCreateDate?.toISOString() ?? "",
          status: u.UserStatus === "FORCE_CHANGE_PASSWORD" ? "invited" : "active",
        });
      }
      token = r.PaginationToken;
    } while (token);
    return out;
  }

  /** Usernames in the `admin` group (one paginated call instead of one call per user). */
  private async adminUsernames(): Promise<Set<string>> {
    const set = new Set<string>();
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListUsersInGroupCommand({ UserPoolId: this.userPoolId, GroupName: "admin", NextToken: token, Limit: 60 }));
      for (const u of r.Users ?? []) if (u.Username) set.add(u.Username);
      token = r.NextToken;
    } while (token);
    return set;
  }

  async setRole(id: string, role: Role): Promise<void> {
    const username = await this.usernameFor(id);
    await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: "staff" }));
    if (role === "admin") await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: "admin" }));
    else await this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.userPoolId, Username: username, GroupName: "admin" })).catch(() => {});
    // Roles come from the ID token at sign-in: sign the user out everywhere so the change applies now.
    await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username })).catch(() => {});
  }

  async resetMfa(id: string): Promise<void> {
    const username = await this.usernameFor(id);
    // Disabling the software token makes the pool (MFA required) ask for enrollment again at sign-in.
    await this.client.send(new AdminSetUserMFAPreferenceCommand({ UserPoolId: this.userPoolId, Username: username, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
    await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username })).catch(() => {});
  }

  // The temporary password in the invitation expires after 3 days, and "Forgot your password?" does
  // not work until the first sign-in is complete, so a new invitation is the only way back in.
  async resendInvitation(id: string): Promise<void> {
    const username = await this.usernameFor(id);
    await this.client.send(new AdminCreateUserCommand({ UserPoolId: this.userPoolId, Username: username, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] }));
  }

  async create(input: { email: string; name: string; role: Role }): Promise<DirectoryUser> {
    const r = await this.client.send(new AdminCreateUserCommand({ UserPoolId: this.userPoolId, Username: input.email, DesiredDeliveryMediums: ["EMAIL"], UserAttributes: [{ Name: "email", Value: input.email }, { Name: "email_verified", Value: "true" }, { Name: "name", Value: input.name }] }));
    await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: input.email, GroupName: input.role }));
    if (input.role === "admin") await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.userPoolId, Username: input.email, GroupName: "staff" }));
    const sub = r.User?.Attributes?.find((a) => a.Name === "sub")?.Value ?? input.email;
    return { id: sub, email: input.email, name: input.name, role: input.role, enabled: true, createdAt: new Date().toISOString(), status: "invited" };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const username = await this.usernameFor(id);
    if (enabled) await this.client.send(new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: username }));
    else {
      await this.client.send(new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: username }));
      await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username })).catch(() => {});
    }
  }

  private async usernameFor(sub: string): Promise<string> {
    const r = await this.client.send(new ListUsersCommand({ UserPoolId: this.userPoolId, Filter: `sub = "${sub.replace(/"/g, "")}"`, Limit: 1 }));
    return r.Users?.[0]?.Username ?? sub;
  }
}
