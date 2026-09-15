import { createHmac } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Role } from "@helixona/core";
import type { IdentityResult } from "./cognito.js";

/**
 * Password sign-in inside the app: the SPA posts email + password to the API, which runs Cognito's
 * USER_PASSWORD_AUTH flow with the confidential client (secret hash), handles the challenges Cognito
 * can return (temporary password change, authenticator code) and verifies the ID token before a
 * server-side session is created. This replaces the AWS-styled hosted sign-in page.
 */
export type PasswordChallenge = "NEW_PASSWORD_REQUIRED" | "MFA";

export type PasswordAuthResult =
  | { kind: "ok"; identity: IdentityResult }
  | { kind: "challenge"; challenge: PasswordChallenge; session: string };

export class PasswordAuthError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "PasswordAuthError";
  }
}

export interface PasswordAuth {
  signIn(email: string, password: string): Promise<PasswordAuthResult>;
  respond(email: string, session: string, challenge: PasswordChallenge, answer: { newPassword?: string; code?: string }): Promise<PasswordAuthResult>;
  /** Sends a reset code by email. Never reveals whether the account exists. */
  forgotPassword(email: string): Promise<void>;
  resetPassword(email: string, code: string, newPassword: string): Promise<void>;
}

export interface CognitoPasswordAuthConfig { region: string; userPoolId: string; clientId: string; clientSecret: string }

export class CognitoPasswordAuth implements PasswordAuth {
  private readonly client: CognitoIdentityProviderClient;
  private readonly verifier;

  constructor(private readonly cfg: CognitoPasswordAuthConfig) {
    this.client = new CognitoIdentityProviderClient({ region: cfg.region });
    this.verifier = CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, tokenUse: "id", clientId: cfg.clientId });
  }

  private secretHash(username: string): string {
    return createHmac("sha256", this.cfg.clientSecret).update(username + this.cfg.clientId).digest("base64");
  }

  async signIn(email: string, password: string): Promise<PasswordAuthResult> {
    try {
      const r = await this.client.send(
        new InitiateAuthCommand({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: this.cfg.clientId,
          AuthParameters: { USERNAME: email, PASSWORD: password, SECRET_HASH: this.secretHash(email) },
        }),
      );
      return this.outcome(r);
    } catch (e) {
      throw mapCognitoError(e);
    }
  }

  async respond(email: string, session: string, challenge: PasswordChallenge, answer: { newPassword?: string; code?: string }): Promise<PasswordAuthResult> {
    const responses: Record<string, string> = { USERNAME: email, SECRET_HASH: this.secretHash(email) };
    if (challenge === "MFA") responses["SOFTWARE_TOKEN_MFA_CODE"] = answer.code ?? "";
    else responses["NEW_PASSWORD"] = answer.newPassword ?? "";
    try {
      const r = await this.client.send(
        new RespondToAuthChallengeCommand({
          ClientId: this.cfg.clientId,
          ChallengeName: challenge === "MFA" ? "SOFTWARE_TOKEN_MFA" : "NEW_PASSWORD_REQUIRED",
          Session: session,
          ChallengeResponses: responses,
        }),
      );
      return this.outcome(r);
    } catch (e) {
      throw mapCognitoError(e);
    }
  }

  async forgotPassword(email: string): Promise<void> {
    try {
      await this.client.send(new ForgotPasswordCommand({ ClientId: this.cfg.clientId, Username: email, SecretHash: this.secretHash(email) }));
    } catch (e) {
      const mapped = mapCognitoError(e);
      if (mapped.code === "invalid_credentials") return; // unknown account: same answer as a known one
      throw mapped;
    }
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    try {
      await this.client.send(new ConfirmForgotPasswordCommand({ ClientId: this.cfg.clientId, Username: email, ConfirmationCode: code, Password: newPassword, SecretHash: this.secretHash(email) }));
    } catch (e) {
      throw mapCognitoError(e);
    }
  }

  private async outcome(r: { AuthenticationResult?: { IdToken?: string; RefreshToken?: string }; ChallengeName?: string; Session?: string }): Promise<PasswordAuthResult> {
    if (r.AuthenticationResult?.IdToken) {
      const payload = await this.verifier.verify(r.AuthenticationResult.IdToken);
      const groups = (payload["cognito:groups"] as string[] | undefined) ?? [];
      const roles: Role[] = groups.includes("admin") ? ["staff", "admin"] : ["staff"];
      return {
        kind: "ok",
        identity: {
          id: String(payload.sub),
          email: String(payload["email"] ?? ""),
          name: String(payload["name"] ?? payload["email"] ?? ""),
          roles,
          refreshToken: r.AuthenticationResult.RefreshToken ?? null,
        },
      };
    }
    if (r.ChallengeName === "NEW_PASSWORD_REQUIRED" && r.Session) return { kind: "challenge", challenge: "NEW_PASSWORD_REQUIRED", session: r.Session };
    if (r.ChallengeName === "SOFTWARE_TOKEN_MFA" && r.Session) return { kind: "challenge", challenge: "MFA", session: r.Session };
    if (r.ChallengeName === "MFA_SETUP") throw new PasswordAuthError("mfa_setup_required", 400, "This account requires an authenticator app. Please contact an administrator.");
    throw new PasswordAuthError("unsupported_challenge", 400, "Sign-in could not be completed.");
  }
}

/** Cognito exceptions → stable API codes and messages safe to show to users. */
export function mapCognitoError(e: unknown): PasswordAuthError {
  if (e instanceof PasswordAuthError) return e;
  const name = (e as { name?: string }).name ?? "";
  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return new PasswordAuthError("invalid_credentials", 401, "Incorrect email or password.");
    case "PasswordResetRequiredException":
      return new PasswordAuthError("password_reset_required", 400, "You need to reset your password. Use “Forgot your password?” below.");
    case "UserNotConfirmedException":
      return new PasswordAuthError("user_not_confirmed", 400, "This account is not confirmed. Please contact an administrator.");
    case "InvalidPasswordException":
      return new PasswordAuthError("password_policy", 400, "Use at least 12 characters with upper and lower case letters, a number and a symbol.");
    case "CodeMismatchException":
    case "ExpiredCodeException":
      return new PasswordAuthError("invalid_code", 400, "The code is incorrect or has expired.");
    case "LimitExceededException":
    case "TooManyRequestsException":
      return new PasswordAuthError("rate_limited", 429, "Too many attempts. Please wait a few minutes and try again.");
    case "InvalidParameterException":
      return new PasswordAuthError("bad_request", 400, "Invalid request.");
    default:
      return new PasswordAuthError("auth_unavailable", 502, "Sign-in is temporarily unavailable. Please try again.");
  }
}

/** Small in-memory attempt limiter per key (client IP); Cognito's own lockout is the second line. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = () => Date.now()) {}
  allow(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
}
