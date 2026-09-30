import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ArrowRight, CheckCircle, CaretDown, Graph, MagnifyingGlass, Plus, Sparkle } from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "./i18n.jsx";

const STORAGE_KEY = "habor.desktop.workspace";
const QUICK_STARTS = [
  { key: "starterTask", prompt: "Describe the task you want to work on." },
  { key: "starterPlan", prompt: "Break the task into a short, actionable plan." },
  { key: "starterChecklist", prompt: "Write a clear checklist for the work." },
];

function readWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value?.tasks && value?.messages) return value;
  } catch {
    // Local persistence is optional; a fresh workspace is still usable.
  }
  return { tasks: [], messages: {} };
}

function formatTime() {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
}

function LanguagePicker() {
  const { preference, languages, setLanguage, t } = useI18n();
  return <label className="language-picker" title={t("language")}>
    <span className="language-globe">文</span>
    <select aria-label={t("language")} value={preference} onChange={(event) => setLanguage(event.target.value)}>
      {languages.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
    </select>
    <CaretDown size={12} />
  </label>;
}

export function App() {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState(readWorkspace);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [draft, setDraft] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const composerRef = useRef(null);
  const currentTask = useMemo(
    () => workspace.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, workspace.tasks],
  );
  const currentMessages = currentTask ? workspace.messages[currentTask.id] ?? [] : [];

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); } catch { /* local storage is optional */ }
  }, [workspace]);

  useEffect(() => {
    let unlisten;
    listen("habor://menu-command", (event) => {
      if (event.payload === "new-task") resetTask();
      if (event.payload === "command-palette") setCommandOpen(true);
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => undefined);
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function resetTask() {
    setSelectedTaskId(null);
    setDraft("");
    setCommandOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function selectTask(taskId) {
    setSelectedTaskId(taskId);
    setDraft("");
  }

  function startTask(value = draft) {
    const text = value.trim();
    if (!text) return;
    const now = formatTime();
    const id = selectedTaskId ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
    setWorkspace((previous) => {
      const existing = previous.tasks.find((task) => task.id === id);
      const task = existing ?? { id, title: text.slice(0, 72), time: now, status: "draft" };
      const tasks = existing ? previous.tasks : [task, ...previous.tasks];
      const messages = {
        ...previous.messages,
        [id]: [...(previous.messages[id] ?? []), { who: "You", time: now, text, kind: "user" }],
      };
      return { tasks, messages };
    });
    setSelectedTaskId(id);
    setDraft("");
  }

  function useQuickStart(prompt) {
    resetTask();
    setDraft(prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  return <main className="app-shell">
    <header className="titlebar">
      <div className="brand"><div className="brand-mark"><Sparkle size={16} weight="fill" /></div><span>habor</span><CaretDown size={13} /></div>
      <div className="titlebar-task">
        <span className="crumb">agent-router</span><span className="slash">/</span>
        <span>{currentTask?.title ?? t("newTask")}</span>
        {currentTask && <span className="connection-status"><span className="status-dot draft" /> {t("localTask")}</span>}
      </div>
      <div className="titlebar-actions">
        <LanguagePicker />
        <button className="command-trigger" onClick={() => setCommandOpen(true)}><MagnifyingGlass size={15} /><span>{t("search")}</span><kbd>⌘K</kbd></button>
      </div>
    </header>

    <div className="workspace-grid without-context">
      <Sidebar tasks={workspace.tasks} selectedTaskId={selectedTaskId} onNewTask={resetTask} onSearch={() => setCommandOpen(true)} onSelectTask={selectTask} onQuickStart={useQuickStart} />
      <section className="main-column">
        <div className="task-toolbar simple">
          <div className="task-heading">
            <div className="status-pill quiet"><span className="pulse" /> {currentTask ? t("localTask") : t("newTask")}</div>
            <h1>{currentTask?.title ?? t("newTask")}</h1>
            {currentTask && <span className="task-id">{t("saved")}</span>}
          </div>
        </div>
        <div className="view-transition">
          {currentTask
            ? <TaskView task={currentTask} messages={currentMessages} draft={draft} setDraft={setDraft} composerRef={composerRef} sendMessage={() => startTask()} />
            : <EmptyTask draft={draft} setDraft={setDraft} composerRef={composerRef} startTask={startTask} onQuickStart={useQuickStart} />}
        </div>
      </section>
    </div>

    <CommandPalette open={commandOpen} setOpen={setCommandOpen} onNewTask={resetTask} onSearch={onSearchFocus.bind(null, composerRef)} />
  </main>;
}

function onSearchFocus(composerRef) {
  requestAnimationFrame(() => composerRef.current?.focus());
}

function Sidebar({ tasks, selectedTaskId, onNewTask, onSearch, onSelectTask, onQuickStart }) {
  const { t } = useI18n();
  return <aside className="sidebar">
    <div className="sidebar-top"><button className="new-task" onClick={onNewTask}><Plus size={16} weight="bold" /> {t("newTask")}</button></div>
    <nav className="primary-nav"><button className="nav-row" onClick={onSearch}><MagnifyingGlass size={16} /> <span>{t("search")}</span><kbd>⌘K</kbd></button></nav>
    <div className="sidebar-section task-section">
      <div className="section-label"><span>{t("recentTasks")}</span><span className="count">{tasks.length}</span></div>
      {tasks.length === 0 ? <div className="sidebar-empty">{t("noRecentTasks")}</div> : tasks.map((task) => <button key={task.id} className={`task-row ${task.id === selectedTaskId ? "selected" : ""}`} onClick={() => onSelectTask(task.id)}><span className="status-dot draft" /><span className="task-title">{task.title}</span><span className="task-time">{task.time}</span></button>)}
    </div>
    <div className="sidebar-section">
      <div className="section-label">{t("workflows")}</div>
      {QUICK_STARTS.map(({ key, prompt }) => <button className="template-row" key={key} onClick={() => onQuickStart(prompt)}><Graph size={15} /> {t(key)} <ArrowRight size={13} /></button>)}
    </div>
    <div className="sidebar-footer"><div className="sidebar-note"><CheckCircle size={14} /> {t("localTaskDescription")}</div><div className="sidebar-version">habor desktop · preview</div></div>
  </aside>;
}

function EmptyTask({ draft, setDraft, composerRef, startTask, onQuickStart }) {
  const { t } = useI18n();
  return <div className="empty-task">
    <div className="empty-task-copy"><div className="empty-mark"><Sparkle size={22} weight="fill" /></div><h2>{t("emptyTitle")}</h2><p>{t("emptySubtitle")}</p></div>
    <Composer draft={draft} setDraft={setDraft} composerRef={composerRef} sendMessage={startTask} />
    <div className="suggestion-row">{QUICK_STARTS.map(({ key, prompt }) => <button key={key} onClick={() => onQuickStart(prompt)}><span>{t(key)}</span><ArrowRight size={14} /></button>)}</div>
  </div>;
}

function TaskView({ task, messages, draft, setDraft, composerRef, sendMessage }) {
  const { t } = useI18n();
  return <div className="task-view">
    <div className="local-task-header"><CheckCircle size={16} /><div><strong>{t("localTask")}</strong><span>{t("localTaskDescription")}</span></div></div>
    <div className="conversation-scroll">
      {messages.length === 0 ? <div className="task-empty-note">{t("emptyTaskHistory")}</div> : messages.map((message, index) => <div className="message user" key={`${message.time}-${index}`}><div className="message-meta"><span className="message-avatar user">{t("you")}</span><strong>{t("you")}</strong><span>{message.time}</span></div><div className="message-body">{message.text}</div></div>)}
    </div>
    <Composer draft={draft} setDraft={setDraft} composerRef={composerRef} sendMessage={sendMessage} />
  </div>;
}

function Composer({ draft, setDraft, composerRef, sendMessage }) {
  const { t } = useI18n();
  return <div className="composer">
    <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder={t("messagePlaceholder")} />
    <div className="composer-bottom"><span className="local-mode"><CheckCircle size={14} /> {t("localTask")}</span><span className="composer-spacer" /><span className="send-hint">{t("sendHint")}</span><button className="send-btn" onClick={sendMessage} aria-label={t("send")}><ArrowRight size={17} weight="bold" /></button></div>
  </div>;
}

function CommandPalette({ open, setOpen, onNewTask, onSearch }) {
  const { t } = useI18n();
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="command-overlay" /><Dialog.Content className="command-dialog"><Dialog.Title className="sr-only">{t("commandPalette")}</Dialog.Title><Command label="habor commands"><Command.Input placeholder={t("commandSearch")} autoFocus /><Command.List><Command.Empty>{t("noResults")}</Command.Empty><Command.Group heading={t("task")}><Command.Item onSelect={onNewTask}>{t("newTask")}</Command.Item><Command.Item onSelect={() => { setOpen(false); onSearch(); }}>{t("focusComposer")}</Command.Item></Command.Group></Command.List></Command></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
