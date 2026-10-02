import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaTextBlockParam, BetaToolResultBlockParam, BetaToolUnion, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { canonicalModelId, estimateUsd, modelByAlias, type Catalog, type CatalogModel } from "../catalog.js";
import { CircuitBreaker } from "../breaker.js";
import { classifyError, FirstEventTimeoutError, type ClassifiedError } from "../errors.js";
import { toMessageParams } from "../history.js";
import { noopLogger, type SafeLogger } from "../logger.js";
import type { Conversation, PinReason, StoredMessage, ToolRound, TurnEvent, TurnStep, UsageSummary } from "../types.js";
import type { LlmProvider, StreamParams } from "./provider.js";

export interface ModelRouterOptions {
  catalog: Catalog;
  provider: LlmProvider;
  breaker?: CircuitBreaker;
  logger?: SafeLogger;
  maxTokens?: number;
  thinkingDisplay?: "omitted" | "summarized";
  firstEventTimeoutMs?: number;
  /** Extra wait for the first event per thousand estimated input tokens: a long conversation or a large file takes longer to read. */
  firstEventMsPerThousandTokens?: number;
  availabilityPinMinutes?: number;
  now?: () => Date;
}

/** A tool call the model made. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** What a tool returns: the blocks for the model, and one line for the activity list. */
export interface ToolOutput {
  content: BetaToolResultBlockParam["content"];
  isError?: boolean;
  /** What was done, in words for the person ("Read 3 files from EOBs.zip: a, b, c"). */
  summary: string;
}

/** Tools the model may use during a turn. They run here, on the server, between rounds. */
export interface TurnTools {
  definitions: BetaToolUnion[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput>;
  /** What a call is about to do, for the activity list while it runs. */
  describe(call: ToolCall): string;
  /** Rounds a turn may take before the model has to answer with what it has (default 30). */
  maxRounds?: number;
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
  /** Rough size of the request, to wait longer for the first event and to tell the person what is being read. */
  estimatedInputTokens?: number;
  /** Tools the model may call during this turn. */
  tools?: TurnTools;
  signal?: AbortSignal;
  emit: (ev: TurnEvent) => void;
}

export interface TurnResult {
  ok: boolean;
  requestedModel: string;
  servedModel: string | null;
  /** The final round's content, as it is stored and shown. */
  content: BetaContentBlock[];
  /** The earlier rounds of a turn that used tools (empty otherwise). */
  rounds: ToolRound[];
  /** The activity list of the turn: what the tools did, and the model's remarks between rounds. */
  steps: TurnStep[];
  stopReason: string | null;
  refusalCategory: string | null;
  /** Everything the turn cost, all rounds together. */
  usage: UsageSummary;
  /** The size of the conversation after the turn: the last round's request plus its answer. */
  contextTokens: number;
  fallbackReason: PinReason | null;
  pin: { model: string; reason: PinReason; until: string | null } | null;
  latencyMs: number;
  partial: boolean;
  error: ClassifiedError | null;
}

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };
const DEFAULT_MAX_ROUNDS = 30;
/** A remark the model made before using a tool is kept this long in the activity list. */
const NOTE_CHARS = 160;

/** Rejects when the signal fires, so a tool that ignores it cannot hold the turn. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function note(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > NOTE_CHARS ? `${t.slice(0, NOTE_CHARS - 1).trimEnd()}…` : t;
}

/**
 * ModelRouter: ejecuta un turno con el modelo elegido para la conversación y aplica las dos vías
 * de respaldo: (a) rechazo por clasificador → lo hace el middleware del SDK dentro del stream
 * (aquí solo se detecta y se fija la conversación); (b) indisponibilidad → reintento propio con el
 * siguiente modelo de `availabilityFallbacks` si aún no se emitió texto.
 *
 * With tools, a turn is a loop: the model answers or asks for tools; the tools run here; their
 * results go back to the same model, which continues, until it answers (or the round cap is hit).
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

  buildParams(model: string, systemPrompt: string, history: StoredMessage[], userText: string, userContent?: BetaContentBlockParam[], systemExtra?: string, tools?: BetaToolUnion[]): StreamParams {
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
    if (tools && tools.length > 0) params.tools = tools;
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
    const maxRounds = input.tools?.maxRounds ?? DEFAULT_MAX_ROUNDS;

    for (let ci = 0; ci < candidates.length; ci++) {
      const model = candidates[ci]!;
      attempt++;
      const params = this.buildParams(model, input.systemPrompt, input.history, input.userText, input.userContent, input.systemExtra, input.tools?.definitions);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const inputTokens = input.estimatedInputTokens ?? null;
      const firstEventMs = (this.opts.firstEventTimeoutMs ?? 60_000) + Math.ceil((inputTokens ?? 0) / 1000) * (this.opts.firstEventMsPerThousandTokens ?? 500);

      // One attempt may take several rounds (tool calls); these span the rounds.
      const rounds: ToolRound[] = [];
      const steps: TurnStep[] = [];
      const usage: UsageSummary = { ...EMPTY_USAGE };
      let currentModel = model;
      let refusalFallback = false;
      let round = 0;
      // Text of the current round (what a fallback may not discard, and the remark kept when a round ends in tool calls).
      let roundText = "";
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      input.emit({ type: "message_start", model });

      try {
        for (;;) {
          round++;
          timedOut = false;
          timer = setTimeout(() => { timedOut = true; controller.abort(); }, firstEventMs);
          let responded = false;
          roundText = "";
          input.emit({ type: "status", stage: "waiting", model: currentModel, inputTokens });

          const stream = this.opts.provider.stream(params, { signal: controller.signal, conversationId: input.conversation.id });
          for await (const ev of stream) {
            if (timer) { clearTimeout(timer); timer = null; }
            if (!responded) {
              responded = true;
              log.info("model_first_event", { model, ms: this.now().getTime() - started, estimatedInputTokens: inputTokens ?? undefined, attempt, chunks: round });
              input.emit({ type: "status", stage: "responding", model: currentModel, inputTokens });
            }
            if (ev.type === "message_start") {
              // Thinking blocks the API dropped because the history before them changed (counts only).
              const dropped = ((ev.message as { input_transformations?: Array<{ type?: string; reason?: string }> }).input_transformations ?? []).filter((t) => t.type === "thinking_dropped" && t.reason === "prefix_binding_mismatch").length;
              if (dropped > 0) log.warn("thinking_blocks_dropped", { model: currentModel, count: dropped, reason: "prefix_binding_mismatch" });
              // The API reports its own id (`claude-sonnet-5-5`); compare on catalog ids or every turn looks like a fallback.
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
              if (ev.delta.type === "text_delta") { roundText += ev.delta.text; input.emit({ type: "text_delta", text: ev.delta.text }); }
              else if (ev.delta.type === "thinking_delta" && this.opts.thinkingDisplay === "summarized") input.emit({ type: "thinking_delta", text: ev.delta.thinking });
            }
          }
          const final = await stream.finalMessage();
          usage.inputTokens += final.usage?.input_tokens ?? 0;
          usage.outputTokens += final.usage?.output_tokens ?? 0;
          usage.cacheReadTokens += final.usage?.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens += final.usage?.cache_creation_input_tokens ?? 0;
          const latencyMs = this.now().getTime() - started;

          if (final.stop_reason === "refusal") {
            input.signal?.removeEventListener("abort", onAbort);
            const category = final.stop_details?.category ?? null;
            log.warn("turn_refused", { model, refusalCategory: category, latencyMs, attempt });
            input.emit({ type: "refused", category });
            return { ok: false, requestedModel: startModel, servedModel: null, content: [], rounds: [], steps: [], stopReason: "refusal", refusalCategory: category, usage: EMPTY_USAGE, contextTokens: 0, fallbackReason: null, pin: null, latencyMs, partial: roundText.length > 0, error: null };
          }

          const calls = final.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
          if (final.stop_reason === "tool_use" && calls.length > 0 && input.tools && round < maxRounds) {
            // The model paused to use tools: what it wrote so far was a remark, kept in the activity list.
            const remark = note(roundText);
            input.emit({ type: "round", round, note: remark });
            if (remark) steps.push({ text: remark, ms: 0 });
            const tools = input.tools;
            input.emit({ type: "step", steps: calls.map((c) => ({ id: c.id, text: tools.describe({ id: c.id, name: c.name, input: c.input }), state: "running" as const })) });
            const results = await Promise.all(
              calls.map(async (c): Promise<BetaToolResultBlockParam> => {
                const call: ToolCall = { id: c.id, name: c.name, input: c.input };
                const t0 = this.now().getTime();
                let out: ToolOutput;
                try {
                  out = await Promise.race([tools.execute(call, controller.signal), untilAborted(controller.signal)]);
                } catch (e) {
                  if (controller.signal.aborted) throw e;
                  log.warn("tool_error", { action: c.name, errorClass: e instanceof Error ? e.name : "unknown", attempt: round });
                  out = { content: [{ type: "text", text: "The tool failed; try again or go on without it." }], isError: true, summary: `${tools.describe(call)}: failed` };
                }
                const ms = this.now().getTime() - t0;
                log.info("tool_call", { action: c.name, latencyMs: ms, status: out.isError ? "error" : "ok", attempt: round });
                input.emit({ type: "step", steps: [{ id: c.id, text: out.summary, state: "done" }] });
                steps.push({ text: out.summary, ms });
                return { type: "tool_result", tool_use_id: c.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
              }),
            );
            rounds.push({ assistant: final.content, results });
            params.messages.push({ role: "assistant", content: final.content as BetaContentBlockParam[] }, { role: "user", content: results });
            continue;
          }

          // The answer. A tool call left unanswered (round cap) cannot be stored: it would break the next request.
          let content = final.content;
          if (calls.length > 0) {
            log.warn("tool_rounds_exhausted", { model: currentModel, count: calls.length, attempt: round });
            content = content.filter((b) => b.type !== "tool_use");
          }
          input.signal?.removeEventListener("abort", onAbort);
          const servedModel = final.model ? canonicalModelId(this.opts.catalog, final.model) : currentModel;
          const iterFallback = (final.usage?.iterations ?? []).some((i) => (i as { type: string }).type === "fallback_message");
          const hadFallback = refusalFallback || iterFallback || servedModel !== model;
          const fallbackReason: PinReason | null = hadFallback ? "refusal" : availabilitySwitch;
          usage.estimatedUsd = estimateUsd(this.opts.catalog, servedModel, usage);
          const contextTokens = (final.usage?.input_tokens ?? 0) + (final.usage?.cache_read_input_tokens ?? 0) + (final.usage?.cache_creation_input_tokens ?? 0) + (final.usage?.output_tokens ?? 0);
          this.breaker.recordSuccess(model);

          let pin: TurnResult["pin"] = null;
          if (servedModel !== input.conversation.modelId) {
            if (fallbackReason === "refusal") pin = { model: servedModel, reason: "refusal", until: null };
            else {
              const until = new Date(this.now().getTime() + (this.opts.availabilityPinMinutes ?? 15) * 60_000).toISOString();
              pin = { model: servedModel, reason: "availability", until };
            }
          }
          log.info("turn_done", { model, servedBy: servedModel, fallbackReason: fallbackReason ?? undefined, stopReason: final.stop_reason ?? undefined, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, estimatedUsd: usage.estimatedUsd, latencyMs, attempt, chunks: round });
          input.emit({ type: "done", model: servedModel, stopReason: final.stop_reason ?? null, usage, fallbackReason });
          return { ok: true, requestedModel: startModel, servedModel, content, rounds, steps, stopReason: final.stop_reason ?? null, refusalCategory: null, usage, contextTokens, fallbackReason, pin, latencyMs, partial: false, error: null };
        }
      } catch (rawErr) {
        if (timer) { clearTimeout(timer); timer = null; }
        input.signal?.removeEventListener("abort", onAbort);
        const err = timedOut ? new FirstEventTimeoutError(firstEventMs) : rawErr;
        const cls = classifyError(err);
        const latencyMs = this.now().getTime() - started;
        const emittedChars = roundText.length;
        log.warn("turn_error", { model, errorClass: cls.errorClass, status: cls.status ?? undefined, reason: cls.kind, latencyMs, attempt, count: emittedChars, chunks: round });

        if (cls.kind === "aborted" && input.signal?.aborted) {
          input.emit({ type: "error", code: "aborted", message: "Request canceled", retryable: true, partial: emittedChars > 0 });
          // The caller keeps what was already answered, marked as stopped.
          return { ...this.failure(startModel, cls, latencyMs, emittedChars > 0), servedModel: currentModel, content: roundText ? [{ type: "text", text: roundText, citations: null } as BetaContentBlock] : [] };
        }
        if (cls.kind === "config") this.breaker.open(model, cls.breakerMs, cls.kind);
        else if (cls.kind === "availability") this.breaker.recordFailure(model, cls.kind);
        if (cls.alarm) log.error("turn_alarm", { model, errorClass: cls.errorClass, status: cls.status ?? undefined, reason: cls.kind });

        const next = candidates.slice(ci + 1).find((id) => !this.breaker.isOpen(id));
        if (cls.fallback && emittedChars === 0 && next) {
          // Nothing of this round was shown: the next model starts the turn over (its own rounds).
          if (round > 1) input.emit({ type: "round", round, note: null });
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
    return { ok: false, requestedModel, servedModel: null, content: [], rounds: [], steps: [], stopReason: null, refusalCategory: null, usage: EMPTY_USAGE, contextTokens: 0, fallbackReason: null, pin: null, latencyMs, partial, error };
  }
}
