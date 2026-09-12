import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ApiError,
  createConversation,
  deleteConversation,
  getConversation,
  getMe,
  listConversations,
  logout,
  renameConversation,
  sendMessage,
  setUnauthorizedHandler,
} from "./lib/api";
import { chatReducer, initialChatState, type ChatMessage } from "./lib/chatReducer";
import { useIdleTimeout } from "./lib/idle";
import { navigate, useRoute } from "./lib/router";
import type { Conversation, Me } from "./lib/types";
import { AdminPage } from "./components/AdminPage";
import { ChatPanel } from "./components/ChatPanel";
import { IdleWarning } from "./components/IdleWarning";
import { LoginPage } from "./components/LoginPage";
import { ModelSelector } from "./components/ModelSelector";
import { Sidebar } from "./components/Sidebar";

type Auth =
  | { status: "loading" }
  | { status: "anon"; reason: string | null }
  | { status: "error"; message: string }
  | { status: "authed"; me: Me };

let localSeq = 0;
const localId = (p: string) => `local-${p}-${++localSeq}`;

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<Auth>({ status: "loading" });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const abortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);

  const abortStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Limpia todo el estado en memoria y vuelve a /login. */
  const clearAll = useCallback(
    (reason: string | null) => {
      abortStream();
      setAuth({ status: "anon", reason });
      setConversations([]);
      setSelected(null);
      setCreating(false);
      setListError(null);
      dispatch({ type: "reset" });
      navigate("/login", { replace: true });
    },
    [abortStream],
  );

  useEffect(() => {
    setUnauthorizedHandler(() => clearAll("Tu sesión ha caducado. Inicia sesión de nuevo."));
    return () => setUnauthorizedHandler(null);
  }, [clearAll]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
      setListError(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("No se pudo cargar la lista de conversaciones.");
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setAuth({ status: "loading" });
    try {
      const me = await getMe();
      setAuth({ status: "authed", me });
      await refreshConversations();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // ya gestionado por el handler
      setAuth({ status: "error", message: "No se pudo conectar con el servidor. Inténtalo de nuevo." });
    }
  }, [refreshConversations]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Rutas según estado de autenticación.
  useEffect(() => {
    if (auth.status === "anon" && route !== "/login") navigate("/login", { replace: true });
    if (auth.status === "authed") {
      if (route === "/login") navigate("/", { replace: true });
      if (route === "/admin" && !auth.me.user.roles.includes("admin")) navigate("/", { replace: true });
    }
  }, [auth, route]);

  const doLogout = useCallback(
    async (reason: string | null) => {
      abortStream();
      let logoutUrl: string | null = null;
      try {
        logoutUrl = (await logout()).logoutUrl;
      } catch {
        // Aunque falle, limpiamos el estado local.
      }
      clearAll(reason);
      if (logoutUrl && /^https?:\/\//i.test(logoutUrl)) {
        // Cierre en el proveedor de identidad (Cognito); vuelve a /login al terminar.
        window.location.assign(logoutUrl);
      }
    },
    [abortStream, clearAll],
  );

  const idle = useIdleTimeout({
    enabled: auth.status === "authed",
    timeoutSeconds: auth.status === "authed" ? auth.me.session.idleTimeoutSeconds : 0,
    onExpire: () => void doLogout("Tu sesión se cerró por inactividad."),
  });

  const selectConversation = useCallback(
    async (id: string) => {
      abortStream();
      setCreating(false);
      setSidebarOpen(false);
      const seq = ++loadSeq.current;
      const known = conversations.find((c) => c.id === id) ?? null;
      setSelected(known);
      setLoadingConv(true);
      dispatch({ type: "reset" });
      try {
        const r = await getConversation(id);
        if (seq !== loadSeq.current) return;
        setSelected(r.conversation);
        dispatch({ type: "load", conversationId: id, messages: r.messages });
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (!(e instanceof ApiError && e.status === 401)) {
          dispatch({ type: "transport_error", message: "No se pudo cargar la conversación." });
        }
      } finally {
        if (seq === loadSeq.current) setLoadingConv(false);
      }
    },
    [abortStream, conversations],
  );

  const startNew = () => {
    abortStream();
    setCreating(true);
    setSidebarOpen(false);
  };

  const confirmNew = async (alias: string) => {
    setCreateBusy(true);
    try {
      const conv = await createConversation(alias);
      ++loadSeq.current;
      setConversations((prev) => [conv, ...prev]);
      setSelected(conv);
      setCreating(false);
      dispatch({ type: "load", conversationId: conv.id, messages: [] });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("No se pudo crear la conversación.");
    } finally {
      setCreateBusy(false);
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (selected?.id === id) {
        abortStream();
        setSelected(null);
        dispatch({ type: "reset" });
      }
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("No se pudo borrar la conversación.");
    }
  };

  const rename = async (id: string, title: string) => {
    try {
      const updated = await renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      if (selected?.id === id) setSelected(updated);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("No se pudo renombrar la conversación.");
    }
  };

  const send = async (text: string) => {
    if (!selected || chat.streaming) return;
    const conv = selected;
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: "send", text, userId: localId("u"), assistantId: localId("a") });
    try {
      for await (const ev of sendMessage(conv.id, text, ac.signal)) {
        dispatch({ type: "sse", event: ev });
      }
      dispatch({ type: "finish" });
    } catch (e) {
      if (ac.signal.aborted) {
        dispatch({ type: "stopped" });
      } else if (e instanceof ApiError && e.status === 401) {
        return;
      } else {
        const msg =
          e instanceof ApiError
            ? e.code === "quota_exceeded"
              ? "Has agotado tu cuota diaria."
              : e.code === "context_limit"
                ? "Esta conversación es demasiado larga. Abre una nueva."
                : "No se pudo enviar el mensaje."
            : "Se perdió la conexión con el servidor.";
        dispatch({ type: "transport_error", message: msg });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // Refrescamos metadatos (contador de mensajes, modelo fijado tras un fallback).
      void refreshConversations();
    }
  };

  // Mantén `selected` sincronizado con la lista (pinnedModel, updatedAt...).
  useEffect(() => {
    if (!selected) return;
    const fresh = conversations.find((c) => c.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [conversations, selected]);

  const stop = () => abortStream();

  const retry = (m: ChatMessage) => {
    const text = m.retryText;
    if (!text || chat.streaming) return;
    if (m.status === "error") dispatch({ type: "remove_failed_turn", assistantId: m.id });
    void send(text);
  };

  // ---- Render ----

  if (auth.status === "loading") {
    return (
      <main className="center-screen" aria-busy="true">
        <p className="muted">Cargando…</p>
      </main>
    );
  }

  if (auth.status === "error") {
    return (
      <main className="center-screen">
        <p role="alert">{auth.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => void bootstrap()}>
          Reintentar
        </button>
      </main>
    );
  }

  if (auth.status === "anon") {
    return <LoginPage reason={auth.reason} onDevLoggedIn={() => void bootstrap()} />;
  }

  const me = auth.me;
  const isAdmin = me.user.roles.includes("admin");

  return (
    <>
      {route === "/admin" && isAdmin ? (
        <AdminPage me={me} onBack={() => navigate("/")} />
      ) : (
        <div className="shell">
          {sidebarOpen && <div className="scrim only-mobile" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
          <Sidebar
            me={me}
            conversations={conversations}
            selectedId={selected?.id ?? null}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onSelect={(id) => void selectConversation(id)}
            onNew={startNew}
            onDelete={(id) => void removeConversation(id)}
            onRename={rename}
            onLogout={() => void doLogout(null)}
            onAdmin={() => navigate("/admin")}
          />
          <div className="main">
            <div className="topbar only-mobile">
              <button type="button" className="btn" onClick={() => setSidebarOpen(true)} aria-expanded={sidebarOpen} aria-controls="sidebar">
                ☰ Conversaciones
              </button>
            </div>
            {listError && (
              <p className="notice notice-error" role="alert">
                {listError}{" "}
                <button type="button" className="btn btn-small" onClick={() => setListError(null)}>
                  Cerrar
                </button>
              </p>
            )}
            {creating ? (
              <div className="panel-center">
                <ModelSelector
                  models={me.catalog.models}
                  defaultAlias={me.catalog.defaultAlias}
                  busy={createBusy}
                  onConfirm={(alias) => void confirmNew(alias)}
                  onCancel={() => setCreating(false)}
                />
              </div>
            ) : selected ? (
              <ChatPanel
                me={me}
                conversation={selected}
                state={chat}
                loading={loadingConv}
                onSend={(t) => void send(t)}
                onStop={stop}
                onRetry={retry}
              />
            ) : (
              <div className="panel-center">
                <div className="empty">
                  <h1>Hola, {me.user.name}</h1>
                  <p className="muted">Elige una conversación o empieza una nueva.</p>
                  <button type="button" className="btn btn-primary" onClick={startNew}>
                    Nueva conversación
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {idle.secondsLeft !== null && idle.secondsLeft > 0 && (
        <IdleWarning secondsLeft={idle.secondsLeft} onContinue={idle.reset} onLogout={() => void doLogout(null)} />
      )}
    </>
  );
}
