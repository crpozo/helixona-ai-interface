import type { ServerResponse } from "node:http";

/** Escritor SSE con heartbeat (comentario `: ping`) cada 15 s para que ALB/CloudFront no corten el stream. */
export class SseWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private readonly res: ServerResponse, heartbeatMs = 15_000, extraHeaders: Record<string, string> = {}) {
    // La respuesta está "hijacked": los hooks de Fastify no aplican, así que las cabeceras de seguridad van aquí.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    });
    res.write(": open\n\n");
    this.timer = setInterval(() => { if (!this.closed) res.write(": ping\n\n"); }, heartbeatMs);
    res.on("close", () => this.end());
  }
  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try { this.res.end(); } catch { /* ya cerrado */ }
  }
  get isClosed(): boolean { return this.closed; }
}
