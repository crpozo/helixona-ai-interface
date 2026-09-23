import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { canonicalModelId, estimateUsd, modelByAlias, type Catalog, type CatalogModel } from "../catalog.js";
import { CircuitBreaker } from "../breaker.js";
import { classifyError, FirstEventTimeoutError, type ClassifiedError } from "../errors.js";
import { toMessageParams } from "../history.js";
import { noopLogger, type SafeLogger } from "../logger.js";
import type { Conversation, PinReason, StoredMessage, TurnEvent, UsageSummary } from "../types.js";
import type { LlmProvider, StreamParams } from "./provider.js";

export interface ModelRouterOptions {
  catalog: Catalog;
  provider: LlmProvider;
  breaker?: CircuitBreaker;
  logger?: SafeLogger;
  maxTokens?: number;
  thinkingDisplay?: "omitted" | "summarized";
  firstEventTimeoutMs?: number;
  availabilityPinMinutes?: number;
  now?: () => Date;
}

export interface TurnInput {
  conversation: Conversation;
  history: StoredMessage[];
  userText: string;
  /** Full content of the new user turn (documents + text). Defaults to a single text block with `userText`. */
  userContent?: BetaContentBlockParam[];
  systemPrompt: string;
  /** Extra operator instructions (e.g. a project's instructions), sent as a second cached system block. */
  systemExtra?: string;
  signal?: AbortSignal;
  emit: (ev: TurnEvent) => void;
}

export interface TurnResult {
  ok: boolean;
  requestedModel: string;
  servedModel: string | null;
  content: BetaContentBlock[];
  stopReason: string | null;
  refusalCategory: string | null;
  usage: UsageSummary;
  fallbackReason: PinReason | null;
  pin: { model: string; reason: PinReason; until: string | null } | null;
  latencyMs: number;
  partial: boolean;
  error: ClassifiedError | null;
}

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

/**
 * ModelRouter: ejecuta un turno con el modelo elegido para la conversación y aplica las dos vías
 * de respaldo: (a) rechazo por clasificador → lo hace el middleware del SDK dentro del stream
 * (aquí solo se detecta y se fija la conversación); (b) indisponibilidad → reintento propio con el
 * siguiente modelo de `availabilityFallbacks` si aún no se emitió texto.
 */
export class ModelRouter {
  private readonly breaker: CircuitBreaker;
  private readonly log: SafeLogger;
  private readonly now: () => Date;

  constructor(private readonly opts: ModelRouterOptions) {
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => new Date());
  }

  /** Modelo con el que debe empezar el turno: pin vigente → modelo elegido → respaldo si el breaker está abierto. */
  resolveStartModel(conv: Conversation): { model: string; entry: CatalogModel; switchedFrom: string | null } {
    const entry = modelByAlias(this.opts.catalog, conv.modelAlias);
    if (!entry) throw new Error(`unknown model alias: ${conv.modelAlias}`);
    let model = conv.modelId;
    if (conv.pinnedModel) {
      const pinActive = conv.pinReason === "refusal" || !conv.pinnedUntil || new Date(conv.pinnedUntil).getTime() > this.now().getTime();
      // Pins written before provider ids were normalized may hold the bare API id.
      if (pinActive) model = canonicalModelId(this.opts.catalog, conv.pinnedModel);
    }
    if (this.breaker.isOpen(model)) {
      const alt = entry.availabilityFallbacks.find((id) => id !== model && !this.breaker.isOpen(id));
      if (alt) return { model: alt, entry, switchedFrom: model };
    }
    return { model, entry, switchedFrom: null };
  }

  buildParams(model: string, systemPrompt: string, history: StoredMessage[], userText: string, userContent?: BetaContentBlockParam[], systemExtra?: string): StreamParams {
    const system: BetaTextBlockParam[] = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }];
    if (systemExtra) system.push({ type: "text", text: systemExtra, cache_control: { type: "ephemeral", ttl: "1h" } });
    const messages: BetaMessageParam[] = [...toMessageParams(history), { role: "user", content: userContent ?? [{ type: "text", text: userText }] }];
    const params: StreamParams = {
      model,
      maxTokens: this.opts.maxTokens ?? 64_000,
      effort: this.opts.catalog.effort,
      system,
      messages,
    };
    if (this.opts.thinkingDisplay === "summarized") params.thinking = { type: "adaptive", display: "summarized" };
    return params;
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const started = this.now().getTime();
    const { model: startModel, entry, switchedFrom } = this.resolveStartModel(input.conversation);
    const log = this.log.child({ conversationId: input.conversation.id, alias: entry.alias, requestedModel: input.conversation.modelId });

    const candidates = [startModel, ...entry.availabilityFallbacks.filter((id) => id !== startModel)];
    let attempt = 0;
    let availabilitySwitch: PinReason | null = switchedFrom ? "availability" : null;
    if (switchedFrom) input.emit({ type: "model_switched", from: switchedFrom, to: startModel, reason: "availability" });

    for (let ci = 0; ci < candidates.length; ci++) {
      const model = candidates[ci]!;
      attempt++;
      const params = this.buildParams(model, input.systemPrompt, input.history, input.userText, input.userContent, input.systemExtra);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const firstEventMs = this.opts.firstEventTimeoutMs ?? 60_000;
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { timedOut = true; controller.abort(); }, firstEventMs);

      let emittedChars = 0;
      let partialText = "";
      let currentModel = model;
      let refusalFallback = false;
      input.emit({ type: "message_start", model });

      try {
        const stream = this.opts.provider.stream(params, { signal: controller.signal, conversationId: input.conversation.id });
        for await (const ev of stream) {
          if (timer) { clearTimeout(timer); timer = null; }
          if (ev.type === "message_start") {
            // The API reports its own id (`claude-sonnet-5`); compare on catalog ids or every turn looks like a fallback.
            const reported = ev.message.model ? canonicalModelId(this.opts.catalog, ev.message.model) : null;
            if (reported && reported !== currentModel && !refusalFallback) {
              // El middleware ya cambió de modelo antes de cualquier salida.
              refusalFallback = true;
              input.emit({ type: "fallback", from: currentModel, to: reported, reason: "refusal" });
              currentModel = reported;
            }
          } else if (ev.type === "content_block_start" && (ev.content_block as { type: string }).type === "fallback") {
            const fb = ev.content_block as unknown as { from: { model: string }; to: { model: string } };
            const to = fb.to?.model ? canonicalModelId(this.opts.catalog, fb.to.model) : null;
            if (to && to !== currentModel) {
              refusalFallback = true;
              input.emit({ type: "fallback", from: fb.from?.model ? canonicalModelId(this.opts.catalog, fb.from.model) : currentModel, to, reason: "refusal" });
              currentModel = to;
            }
          } else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") { emittedChars += ev.delta.text.length; partialText += ev.delta.text; input.emit({ type: "text_delta", text: ev.delta.text }); }
            else if (ev.delta.type === "thinking_delta" && this.opts.thinkingDisplay === "summarized") input.emit({ type: "thinking_delta", text: ev.delta.thinking });
          }
        }
        const final = await stream.finalMessage();
        input.signal?.removeEventListener("abort", onAbort);
        const latencyMs = this.now().getTime() - started;

        if (final.stop_reason === "refusal") {
          const category = final.stop_details?.category ?? null;
          log.warn("turn_refused", { model, refusalCategory: category, latencyMs, attempt });
          input.emit({ type: "refused", category });
          return { ok: false, requestedModel: startModel, servedModel: null, content: [], stopReason: "refusal", refusalCategory: category, usage: EMPTY_USAGE, fallbackReason: null, pin: null, latencyMs, partial: emittedChars > 0, error: null };
        }

        const servedModel = final.model ? canonicalModelId(this.opts.catalog, final.model) : currentModel;
        const iterFallback = (final.usage?.iterations ?? []).some((i) => (i as { type: string }).type === "fallback_message");
        const hadFallback = refusalFallback || iterFallback || servedModel !== model;
        const fallbackReason: PinReason | null = hadFallback ? "refusal" : availabilitySwitch;
        const usage: UsageSummary = {
          inputTokens: final.usage?.input_tokens ?? 0,
          outputTokens: final.usage?.output_tokens ?? 0,
          cacheReadTokens: final.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: final.usage?.cache_creation_input_tokens ?? 0,
          estimatedUsd: 0,
        };
        usage.estimatedUsd = estimateUsd(this.opts.catalog, servedModel, usage);
        this.breaker.recordSuccess(model);

        let pin: TurnResult["pin"] = null;
        if (servedModel !== input.conversation.modelId) {
          if (fallbackReason === "refusal") pin = { model: servedModel, reason: "refusal", until: null };
          else {
            const until = new Date(this.now().getTime() + (this.opts.availabilityPinMinutes ?? 15) * 60_000).toISOString();
            pin = { model: servedModel, reason: "availability", until };
          }
        }
        log.info("turn_done", { model, servedBy: servedModel, fallbackReason: fallbackReason ?? undefined, stopReason: final.stop_reason ?? undefined, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, estimatedUsd: usage.estimatedUsd, latencyMs, attempt });
        input.emit({ type: "done", model: servedModel, stopReason: final.stop_reason ?? null, usage, fallbackReason });
        return { ok: true, requestedModel: startModel, servedModel, content: final.content, stopReason: final.stop_reason ?? null, refusalCategory: null, usage, fallbackReason, pin, latencyMs, partial: false, error: null };
      } catch (rawErr) {
        if (timer) { clearTimeout(timer); timer = null; }
        input.signal?.removeEventListener("abort", onAbort);
        const err = timedOut ? new FirstEventTimeoutError(firstEventMs) : rawErr;
        const cls = classifyError(err);
        const latencyMs = this.now().getTime() - started;
        log.warn("turn_error", { model, errorClass: cls.errorClass, status: cls.status ?? undefined, reason: cls.kind, latencyMs, attempt, count: emittedChars });

        if (cls.kind === "aborted" && input.signal?.aborted) {
          input.emit({ type: "error", code: "aborted", message: "Request canceled", retryable: true, partial: emittedChars > 0 });
          // The caller keeps what was already answered, marked as stopped.
          return { ...this.failure(startModel, cls, latencyMs, emittedChars > 0), servedModel: currentModel, content: partialText ? [{ type: "text", text: partialText, citations: null } as BetaContentBlock] : [] };
        }
        if (cls.kind === "config") this.breaker.open(model, cls.breakerMs, cls.kind);
        else if (cls.kind === "availability") this.breaker.recordFailure(model, cls.kind);
        if (cls.alarm) log.error("turn_alarm", { model, errorClass: cls.errorClass, status: cls.status ?? undefined, reason: cls.kind });

        const next = candidates.slice(ci + 1).find((id) => !this.breaker.isOpen(id));
        if (cls.fallback && emittedChars === 0 && next) {
          input.emit({ type: "model_switched", from: model, to: next, reason: "availability" });
          availabilitySwitch = "availability";
          ci = candidates.indexOf(next) - 1;
          continue;
        }
        const code = cls.kind === "availability" || cls.kind === "config" ? "model_unavailable" : cls.kind === "bug" ? "bad_request" : "internal";
        input.emit({ type: "error", code, message: code === "model_unavailable" ? "The model is not available right now" : "The request could not be completed", retryable: code === "model_unavailable" || code === "internal", partial: emittedChars > 0 });
        return this.failure(startModel, cls, latencyMs, emittedChars > 0);
      }
    }
    // No debería llegar aquí: siempre hay al menos un candidato.
    return this.failure(startModel, classifyError(new Error("no candidates")), this.now().getTime() - started, false);
  }

  private failure(requestedModel: string, error: ClassifiedError, latencyMs: number, partial: boolean): TurnResult {
    return { ok: false, requestedModel, servedModel: null, content: [], stopReason: null, refusalCategory: null, usage: EMPTY_USAGE, fallbackReason: null, pin: null, latencyMs, partial, error };
  }
}
