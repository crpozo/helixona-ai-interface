import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@helixona/core";
import type { Session, SessionRepo } from "../repos/types.js";

export const SESSION_COOKIE = "hx_session";

export interface SessionServiceOptions { repo: SessionRepo; secret: string; idleSeconds: number; absoluteSeconds: number; now?: () => Date }

/** Sesiones del lado servidor: el navegador solo tiene un id opaco firmado con HMAC. */
export class SessionService {
  private readonly now: () => Date;
  constructor(private readonly o: SessionServiceOptions) { this.now = o.now ?? (() => new Date()); }

  private sign(id: string): string { return createHmac("sha256", this.o.secret).update(id).digest("base64url"); }

  encode(id: string): string { return `${id}.${this.sign(id)}`; }

  decode(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const dot = cookie.lastIndexOf(".");
    if (dot <= 0) return null;
    const id = cookie.slice(0, dot); const sig = cookie.slice(dot + 1);
    const expected = this.sign(id);
    if (sig.length !== expected.length) return null;
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
  }

  async create(user: { id: string; email: string; name: string; roles: Role[] }, refreshToken: string | null): Promise<{ session: Session; cookie: string }> {
    const now = this.now();
    const s: Session = {
      id: randomBytes(32).toString("base64url"),
      userId: user.id, email: user.email, name: user.name, roles: user.roles,
      createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + this.o.absoluteSeconds * 1000).toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + this.o.idleSeconds,
      refreshToken,
    };
    await this.o.repo.create(s);
    return { session: s, cookie: this.encode(s.id) };
  }

  /** Devuelve la sesión válida (y la refresca) o null si no existe / expiró por inactividad o tiempo absoluto. */
  async resolve(cookie: string | undefined): Promise<{ session: Session; expired: boolean } | null> {
    const id = this.decode(cookie);
    if (!id) return null;
    const s = await this.o.repo.get(id);
    if (!s) return null;
    const now = this.now();
    const nowS = Math.floor(now.getTime() / 1000);
    if (s.expiresAt <= nowS || new Date(s.absoluteExpiresAt).getTime() <= now.getTime()) {
      await this.o.repo.delete(id);
      return { session: s, expired: true };
    }
    // Refresco de inactividad con escritura solo si pasó más de 30 s (evita una escritura por request).
    const lastSeen = new Date(s.lastSeenAt).getTime();
    if (now.getTime() - lastSeen > 30_000) {
      const expiresAt = Math.min(nowS + this.o.idleSeconds, Math.floor(new Date(s.absoluteExpiresAt).getTime() / 1000));
      await this.o.repo.touch(id, now.toISOString(), expiresAt);
      s.lastSeenAt = now.toISOString(); s.expiresAt = expiresAt;
    }
    return { session: s, expired: false };
  }

  async destroy(id: string): Promise<void> { await this.o.repo.delete(id); }

  cookieOptions(secure: boolean) {
    return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge: this.o.absoluteSeconds };
  }
}
