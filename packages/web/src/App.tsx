import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ApiError,
  createConversation,
  createProject,
  deleteConversation,
  deleteProject,
  getConversation,
  getMe,
  listConversations,
  listProjects,
  logout,
  renameConversation,
  sendMessage,
  setUnauthorizedHandler,
  updateConversation,
} from "./lib/api";
import { chatReducer, initialChatState, type ChatMessage } from "./lib/chatReducer";
import { useIdleTimeout } from "./lib/idle";
import { currentRoute, navigate, useRoute } from "./lib/router";
import type { AttachmentMeta, Conversation, Me, Project } from "./lib/types";
import { AdminPage } from "./components/AdminPage";
import { ChatPanel } from "./components/ChatPanel";
import { IdleWarning } from "./components/IdleWarning";
import { LoginPage } from "./components/LoginPage";
import { ProjectPage } from "./components/ProjectPage";
import { Sidebar } from "./components/Sidebar";
import { StartComposer } from "./components/StartComposer";
import { brand } from "./brand";
import { TrainingGate } from "./components/TrainingSections";

const TrainingCoursePage = lazy(() => import("./components/TrainingCoursePage").then((m) => ({ default: m.TrainingCoursePage })));

// The HIPAA documents ship in their own chunk: the chat bundle stays lean.
const DocumentationPage = lazy(() => import("./components/DocumentationPage").then((m) => ({ default: m.DocumentationPage })));

type Auth =
  | { status: "loading" }
  | { status: "anon"; reason: string | null }
  | { status: "error"; message: string }
  | { status: "authed"; me: Me };

let localSeq = 0;
const localId = (p: string) => `local-${p}-${++localSeq}`;


function Docs(props: { backLabel: string; backTo: "/login" | "/"; me?: Me }) {
  return (
    <Suspense
      fallback={
        <main className="center-screen" aria-busy="true">
          <p className="muted">Loading…</p>
        </main>
      }
    >
      <DocumentationPage {...props} />
    </Suspense>
  );
}

/** Message for the login page when the OIDC callback redirected here with `?error=`. */
function signInErrorReason(): string | null {
  const err = new URLSearchParams(window.location.search).get("error");
  if (!err) return null;
  if (err === "login") return "Sign-in could not be completed. Please try again.";
  return "The sign-in request was invalid or expired. Please try again.";
}

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<Auth>({ status: "loading" });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectView, setProjectView] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
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
      setProjects([]);
      setProjectView(null);
      setSelected(null);
      setListError(null);
      dispatch({ type: "reset" });
      // The documentation is public: a visitor who lands there (or whose session expires while reading) stays.
      if (currentRoute() !== "/documentation") navigate("/login", { replace: true });
    },
    [abortStream],
  );

  // A 401 only means "expired" if this tab had a session; a first visit just lands on the login page.
  const hadSession = useRef(false);
  useEffect(() => {
    setUnauthorizedHandler(() => clearAll(hadSession.current ? "Your session has expired. Please sign in again." : signInErrorReason()));
    return () => setUnauthorizedHandler(null);
  }, [clearAll]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
      setListError(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not load the conversation list.");
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not load the project list.");
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setAuth({ status: "loading" });
    try {
      const me = await getMe();
      hadSession.current = true;
      setAuth({ status: "authed", me });
      await refreshConversations();
      await refreshProjects();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // ya gestionado por el handler
      setAuth({ status: "error", message: "Could not connect to the server. Please try again." });
    }
  }, [refreshConversations, refreshProjects]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Rutas según estado de autenticación.
  useEffect(() => {
    if (auth.status === "anon" && route !== "/login" && route !== "/documentation") navigate("/login", { replace: true });
    if (auth.status === "authed") {
      if (route === "/login") navigate("/", { replace: true });
      if (route === "/admin" && !auth.me.user.roles.includes("admin")) navigate("/", { replace: true });
    }
  }, [auth, route]);

  // Training gate: coming back from the training document, re-read the profile so the lock lifts.
  const refreshMe = useCallback(async () => {
    try {
      const me = await getMe();
      setAuth({ status: "authed", me });
    } catch {
      // A 401 is handled by the unauthorized handler; anything else keeps the current profile.
    }
  }, []);
  const authRef = useRef<Auth>(auth);
  authRef.current = auth;
  useEffect(() => {
    const a = authRef.current;
    if (route === "/" && a.status === "authed" && a.me.training?.required && !a.me.training.complete) void refreshMe();
  }, [route, refreshMe]);

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
    onExpire: () => void doLogout("You were signed out due to inactivity."),
  });

  const selectConversation = useCallback(
    async (id: string) => {
      abortStream();
      setProjectView(null);
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
          dispatch({ type: "transport_error", message: "Could not load the conversation." });
        }
      } finally {
        if (seq === loadSeq.current) setLoadingConv(false);
      }
    },
    [abortStream, conversations],
  );

  // A new chat starts from the start screen (home) or from the project's own composer, like Claude.ai.
  const startNew = (projectId: string | null = null) => {
    abortStream();
    setSidebarOpen(false);
    if (projectId) {
      openProject(projectId);
      return;
    }
    setSelected(null);
    dispatch({ type: "reset" });
    setProjectView(null);
  };

  const openProject = (id: string) => {
    abortStream();
    setSelected(null);
    dispatch({ type: "reset" });
    setProjectView(id);
    setSidebarOpen(false);
  };

  const newProject = async () => {
    try {
      const p = await createProject({ name: "New project" });
      setProjects((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
      openProject(p.id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not create the project.");
    }
  };

  const projectUpdated = (p: Project) => setProjects((prev) => prev.map((x) => (x.id === p.id ? p : x)).sort((a, b) => a.name.localeCompare(b.name)));

  const removeProject = async (id: string) => {
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setConversations((prev) => prev.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)));
      setProjectView(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not delete the project.");
    }
  };

  const changeModel = async (alias: string) => {
    if (!selected) return;
    try {
      const updated = await updateConversation(selected.id, { modelAlias: alias });
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setSelected(updated);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not change the model.");
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
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not delete the conversation.");
    }
  };

  const rename = async (id: string, title: string) => {
    try {
      const updated = await renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      if (selected?.id === id) setSelected(updated);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setListError("Could not rename the conversation.");
    }
  };

  const sendTo = async (conv: Conversation, text: string, attachments: AttachmentMeta[] = []) => {
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: "send", text, attachments, userId: localId("u"), assistantId: localId("a") });
    try {
      for await (const ev of sendMessage(conv.id, text, ac.signal, attachments.map((a) => ({ id: a.id, name: a.name })))) {
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
              ? "You have reached your daily quota."
              : e.code === "context_limit"
                ? "This conversation is too long. Please start a new one."
                : "Could not send the message."
            : "Connection to the server was lost.";
        dispatch({ type: "transport_error", message: msg });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // Refrescamos metadatos (contador de mensajes, modelo fijado tras un fallback).
      void refreshConversations();
    }
  };

  const send = (text: string, attachments: AttachmentMeta[] = []) => {
    if (!selected || chat.streaming) return;
    return sendTo(selected, text, attachments);
  };

  /** From the project page: create the conversation in the project and send its first message. */
  const startInProject = async (projectId: string | null, text: string, alias: string) => {
    abortStream();
    const conv = await createConversation(alias, projectId);
    ++loadSeq.current;
    setConversations((prev) => [conv, ...prev]);
    setSelected(conv);
    setProjectView(null);
    dispatch({ type: "load", conversationId: conv.id, messages: [] });
    void sendTo(conv, text);
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
    if (text === null || chat.streaming) return;
    if (m.status === "error") dispatch({ type: "remove_failed_turn", assistantId: m.id });
    void send(text, m.retryAttachments);
  };

  // ---- Render ----

  if (auth.status === "loading") {
    return (
      <main className="center-screen" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (auth.status === "error") {
    return (
      <main className="center-screen">
        <p role="alert">{auth.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => void bootstrap()}>
          Retry
        </button>
      </main>
    );
  }

  if (auth.status === "anon") {
    if (route === "/documentation") return <Docs backLabel="Sign in" backTo="/login" />;
    return <LoginPage reason={auth.reason} onSignedIn={() => void bootstrap()} />;
  }

  const me = auth.me;
  const isAdmin = me.user.roles.includes("admin");
  const trainingBlocked = !!me.training?.required && !me.training.complete;

  return (
    <>
      {route === "/documentation" ? (
        <Docs backLabel="Back to the assistant" backTo="/" me={me} />
      ) : route === "/training" ? (
        <Suspense
          fallback={
            <main className="center-screen" aria-busy="true">
              <p className="muted">Loading…</p>
            </main>
          }
        >
          <TrainingCoursePage me={me} onExit={() => navigate("/")} />
        </Suspense>
      ) : route === "/admin" && isAdmin ? (
        <AdminPage me={me} onBack={() => navigate("/")} />
      ) : (
        <div className="shell">
          {sidebarOpen && <div className="scrim only-mobile" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
          <Sidebar
            me={me}
            conversations={conversations}
            projects={projects}
            selectedId={selected?.id ?? null}
            projectViewId={projectView}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onSelect={(id) => void selectConversation(id)}
            onNew={() => startNew(null)}
            onDelete={(id) => void removeConversation(id)}
            onRename={rename}
            onOpenProject={openProject}
            onNewProject={() => void newProject()}
            onNewInProject={(id) => startNew(id)}
            onLogout={() => void doLogout(null)}
            onAdmin={() => navigate("/admin")}
            onDocs={() => navigate("/documentation")}
            onTraining={() => navigate("/training")}
          />
          <div className="main">
            <div className="topbar only-mobile">
              <button type="button" className="btn" onClick={() => setSidebarOpen(true)} aria-expanded={sidebarOpen} aria-controls="sidebar">
                ☰ Conversations
              </button>
            </div>
            {listError && (
              <p className="notice notice-error" role="alert">
                {listError}{" "}
                <button type="button" className="btn btn-small" onClick={() => setListError(null)}>
                  Dismiss
                </button>
              </p>
            )}
            {trainingBlocked ? (
              <TrainingGate me={me} onRefresh={() => void refreshMe()} />
            ) : projectView && projects.some((p) => p.id === projectView) ? (
              <ProjectPage
                project={projects.find((p) => p.id === projectView)!}
                conversations={conversations.filter((c) => c.projectId === projectView)}
                models={me.catalog.models}
                maxMb={me.limits.attachments?.maxMb ?? 20}
                uploadsEnabled={me.limits.attachments?.enabled ?? false}
                onBack={() => setProjectView(null)}
                onOpenConversation={(id) => void selectConversation(id)}
                defaultAlias={me.catalog.defaultAlias}
                onStartConversation={(text, alias) => startInProject(projectView, text, alias)}
                onUpdated={projectUpdated}
                onDelete={() => void removeProject(projectView)}
              />
            ) : selected ? (
              <ChatPanel
                me={me}
                conversation={selected}
                projectName={selected.projectId ? projects.find((p) => p.id === selected.projectId)?.name ?? null : null}
                state={chat}
                loading={loadingConv}
                onSend={(t, a) => void send(t, a)}
                onStop={stop}
                onRetry={retry}
                onChangeModel={(alias) => void changeModel(alias)}
                onOpenProject={selected.projectId ? () => openProject(selected.projectId!) : undefined}
              />
            ) : (
              <div className="panel-center">
                <div className="home-start">
                  <p className="eyebrow">{brand.productName}</p>
                  <h1>Hello, {me.user.name}</h1>
                  <p className="muted home-lead">What are you working on today?</p>
                  <StartComposer models={me.catalog.models} defaultAlias={me.catalog.defaultAlias} placeholder="Write a message…" onStart={(text, alias) => startInProject(null, text, alias)} />
                  <p className="muted small home-hint">Patient information stays in this assistant; review every answer before you use it.</p>
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
