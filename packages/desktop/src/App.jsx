import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight, CaretDown, Check, CheckCircle, Clock, DotsThree,
  File, FolderSimple, GearSix, GitBranch, GitDiff, Graph, ListChecks, MagnifyingGlass,
  Paperclip, Pause, Play, Plus, Robot, ShieldCheck, Sparkle, TerminalWindow, UsersThree,
  WarningCircle, X,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n.jsx";

const TASKS = [
  { id: "fix-login", title: "Fix login error and add test coverage", status: "working", time: "2m ago" },
  { id: "audit-logging", title: "Add audit logging", status: "done", time: "Yesterday" },
  { id: "onboarding", title: "Improve onboarding flow", status: "done", time: "Sep 28" },
  { id: "data-layer", title: "Refactor data layer", status: "done", time: "Sep 27" },
  { id: "dependencies", title: "Update dependencies", status: "done", time: "Sep 26" },
];

const FILES = [
  { name: "src", type: "folder", open: true },
  { name: "services", type: "folder", open: true, indent: 1 },
  { name: "auth.ts", type: "file", indent: 2, active: true },
  { name: "session.ts", type: "file", indent: 2 },
  { name: "tests", type: "folder", open: true, indent: 1 },
  { name: "login.spec.ts", type: "file", indent: 2 },
];

const FLOW_NODES = [
  { id: "implement", title: "Implement", detail: "Build the focused fix", model: "Claude 3.5 Sonnet", tone: "peach", x: 42, y: 100, state: "working", icon: Robot },
  { id: "review", title: "Review", detail: "Check code, security, UX", model: "GPT-4o", tone: "lavender", x: 392, y: 100, state: "pending", icon: ShieldCheck },
  { id: "verify", title: "Verify", detail: "Run tests and checks", model: "Habor Verify", tone: "blue", x: 742, y: 100, state: "idle", icon: CheckCircle },
  { id: "docs", title: "Generate docs", detail: "Update user and dev docs", model: "Claude 3.5 Haiku", tone: "lavender", x: 392, y: 320, state: "idle", icon: File },
];

const seedMessages = [
  { who: "You", time: "10:24 AM", text: "Investigate the login error, fix the root cause, and add tests. Keep the change minimal and focused. Run the relevant test suite when you are done.", kind: "user" },
  { who: "Astra", time: "10:24 AM", text: "I’ll trace the login path first, reproduce the failure, implement a minimal fix, and add focused tests before I run verification.", kind: "assistant" },
];

function StatusDot({ status }) {
  return <span className={`status-dot ${status}`} aria-label={status} />;
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
  const [mode, setMode] = useState("solo");
  const [contextTab, setContextTab] = useState("files");
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(seedMessages);
  const [approval, setApproval] = useState(false);
  const [activeNode, setActiveNode] = useState("implement");
  const [commandOpen, setCommandOpen] = useState(false);
  const currentTask = useMemo(() => TASKS.find((task) => task.id === selectedTask) ?? null, [selectedTask]);

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

  function startTask(text = draft) {
    const value = text.trim();
    if (!value) return;
    setSelectedTask("fix-login");
    setMessages((items) => [...items, { who: "You", time: t("now"), text: value, kind: "user" }, {
      who: "Astra", time: t("now"), text: "I’ve added this to the current task and will keep the existing context intact.", kind: "assistant",
    }]);
    setDraft("");
  }

  function openTask(taskId) {
    setSelectedTask(taskId);
    setContextOpen(true);
  }

  return <main className="app-shell">
    <header className="titlebar">
      <div className="brand"><div className="brand-mark"><Sparkle size={16} weight="fill" /></div><span>habor</span><CaretDown size={13} /></div>
      <div className="titlebar-task">
        <span className="crumb">agent-router</span><span className="slash">/</span>
        <span>{currentTask?.title ?? t("newTask")}</span>
        {currentTask && <span className="connection-status"><span className="status-dot working" /> {t("running")}</span>}
      </div>
      <div className="titlebar-actions">
        {currentTask && <button className="top-model"><Sparkle size={13} /> GPT-6 Astra <CaretDown size={12} /></button>}
        <LanguagePicker />
        <button className="command-trigger" onClick={() => setCommandOpen(true)}><MagnifyingGlass size={15} /><span>{t("search")}</span><kbd>⌘K</kbd></button>
        <button className="icon-btn" aria-label={t("more")}><DotsThree size={20} /></button>
        <div className="avatar">JM</div>
      </div>
    </header>

    <div className={`workspace-grid ${contextOpen ? "with-context" : "without-context"}`}>
      <Sidebar selectedTask={selectedTask} setSelectedTask={openTask} onNewTask={() => { setSelectedTask(null); setMode("solo"); setContextOpen(false); }} onSearch={() => setCommandOpen(true)} onTeams={() => { setMode("collab"); if (!selectedTask) setSelectedTask("fix-login"); }} />
      <section className="main-column">
        <div className="task-toolbar">
          <div className="task-heading">
            <div className={`status-pill ${currentTask ? "" : "quiet"}`}><span className="pulse" /> {currentTask ? t("running") : t("newTask")}</div>
            <h1>{currentTask?.title ?? t("newTask")}</h1>
            {currentTask && <span className="task-id">task-7fa2</span>}
          </div>
          <div className="task-controls">
            <div className="mode-switch"><button className={mode === "solo" ? "active" : ""} onClick={() => setMode("solo")}>{t("solo")}</button><button className={mode === "collab" ? "active" : ""} onClick={() => setMode("collab")}>{t("collaborate")}</button></div>
            {currentTask && <><button className="control-btn"><Pause size={15} weight="fill" /> {t("pause")}</button><button className="control-btn danger"><X size={15} weight="bold" /> {t("cancel")}</button></>}
            <button className={`context-toggle ${contextOpen ? "active" : ""}`} onClick={() => setContextOpen((value) => !value)}><GitDiff size={15} /> {contextOpen ? t("close") : t("files")}</button>
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {mode === "solo" ? <motion.div key="solo" className="view-transition" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .16 }}>
            {currentTask ? <SoloView messages={messages} draft={draft} setDraft={setDraft} sendMessage={() => startTask()} approval={approval} setApproval={setApproval} /> : <EmptyTask draft={draft} setDraft={setDraft} startTask={startTask} setSelectedTask={setSelectedTask} />}
          </motion.div> : <motion.div key="collab" className="view-transition" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .16 }}><CollabView activeNode={activeNode} setActiveNode={setActiveNode} setApproval={setApproval} /></motion.div>}
        </AnimatePresence>
      </section>
      {contextOpen && <aside className="context-panel">
        <Tabs.Root value={contextTab} onValueChange={setContextTab} className="context-tabs">
          <Tabs.List><Tabs.Trigger value="files"><File size={15} /> {t("files")}</Tabs.Trigger><Tabs.Trigger value="diff"><GitDiff size={15} /> {t("diff")} <span className="tab-count">3</span></Tabs.Trigger><Tabs.Trigger value="verify"><CheckCircle size={15} /> {t("verify")}</Tabs.Trigger></Tabs.List>
        </Tabs.Root>
        {contextTab === "files" && <FilesView />}
        {contextTab === "diff" && <DiffView />}
        {contextTab === "verify" && <VerifyView />}
      </aside>}
    </div>
    <CommandPalette open={commandOpen} setOpen={setCommandOpen} setMode={setMode} setContextTab={setContextTab} setContextOpen={setContextOpen} />
  </main>;
}

function Sidebar({ selectedTask, setSelectedTask, onNewTask, onSearch, onTeams }) {
  const { t } = useI18n();
  const nav = [
    { icon: MagnifyingGlass, label: t("search"), action: onSearch },
    { icon: UsersThree, label: t("teams"), badge: "2", action: onTeams },
    { icon: FolderSimple, label: t("projects") },
  ];
  return <aside className="sidebar">
    <div className="sidebar-top"><button className="new-task" onClick={onNewTask}><Plus size={16} weight="bold" /> {t("newTask")}</button></div>
    <nav className="primary-nav">{nav.map(({ icon: Icon, label, action, badge }) => <button className="nav-row" key={label} onClick={action}><Icon size={16} /> <span>{label}</span>{badge && <span className="nav-badge">{badge}</span>}</button>)}</nav>
    <div className="sidebar-section task-section"><div className="section-label"><span>{t("recentTasks")}</span><span className="count">{TASKS.length}</span></div>{TASKS.map((task) => <button key={task.id} className={`task-row ${task.id === selectedTask ? "selected" : ""}`} onClick={() => setSelectedTask(task.id)}><StatusDot status={task.status} /><span className="task-title">{task.title}</span><span className="task-time">{task.time}</span></button>)}</div>
    <div className="sidebar-section"><div className="section-label">{t("workflows")}</div><button className="template-row" onClick={onNewTask}><Graph size={15} /> {t("soloTask")}</button><button className="template-row" onClick={() => { setSelectedTask("fix-login"); }}><ListChecks size={15} /> {t("reviewLoop")}</button><button className="template-row"><GitBranch size={15} /> {t("shipWorkflow")}</button></div>
    <div className="sidebar-footer"><button className="footer-row"><GearSix size={16} /> {t("settings")}</button><button className="footer-row"><Robot size={16} /> {t("agents")}</button></div>
  </aside>;
}

function EmptyTask({ draft, setDraft, startTask, setSelectedTask }) {
  const { t } = useI18n();
  const suggestions = [
    { label: t("soloTask"), prompt: "Fix the login error and add test coverage." },
    { label: t("reviewLoop"), prompt: "Review the current branch for security and UX issues." },
    { label: t("shipWorkflow"), prompt: "Prepare this change for release and verify it." },
  ];
  return <div className="empty-task">
    <div className="empty-task-copy"><div className="empty-mark"><Sparkle size={22} weight="fill" /></div><h2>{t("emptyTitle")}</h2><p>{t("emptySubtitle")}</p></div>
    <Composer draft={draft} setDraft={setDraft} sendMessage={startTask} />
    <div className="suggestion-row">{suggestions.map((suggestion) => <button key={suggestion.label} onClick={() => { setDraft(suggestion.prompt); setSelectedTask("fix-login"); }}><span>{suggestion.label}</span><ArrowRight size={14} /></button>)}</div>
  </div>;
}

function Composer({ draft, setDraft, sendMessage }) {
  const { t } = useI18n();
  return <div className="composer">
    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder={t("messagePlaceholder")} />
    <div className="composer-tools"><button className="icon-btn" aria-label={t("add")}><Plus size={20} /></button><button className="icon-btn" aria-label={t("attach")}><Paperclip size={18} /></button><span className="composer-hint">{t("commandHelp")}</span></div>
    <div className="composer-bottom"><button className="access-pill"><ShieldCheck size={14} /> {t("ask")}</button><span className="composer-spacer" /><button className="model-select">GPT-6 Astra <CaretDown size={13} /></button><button className="send-btn" onClick={sendMessage} aria-label={t("send")}><ArrowRight size={17} weight="bold" /></button></div>
  </div>;
}

function SoloView({ messages, draft, setDraft, sendMessage, approval, setApproval }) {
  const { t } = useI18n();
  return <div className="solo-view"><div className="execution-strip"><div><span className="muted">{t("activeMember")}</span><strong><span className="member-dot peach" /> Astra</strong></div><div><span className="muted">{t("model")}</span><strong>GPT-6 Astra</strong></div><div><span className="muted">{t("nativeAgent")}</span><strong>Codex ACP</strong></div><div><span className="muted">{t("permission")}</span><strong className="permission"><ShieldCheck size={14} /> {t("ask")}</strong></div></div><div className="conversation-scroll"><div className="processed"><CheckCircle size={14} weight="fill" /> {t("started")}</div>{messages.map((message, index) => <div className={`message ${message.kind}`} key={`${message.time}-${index}`}><div className="message-meta"><span className={`message-avatar ${message.kind}`}>{message.kind === "user" ? t("you") : <Sparkle size={13} weight="fill" />}</span><strong>{message.who}</strong><span>{message.time}</span></div><div className="message-body">{message.text}</div></div>)}<div className="activity"><div className="activity-icon"><TerminalWindow size={16} /></div><div className="activity-content"><div className="activity-title"><strong>{t("runningCommand")}</strong><span>12s</span></div><code>pnpm test packages/auth</code><div className="activity-result"><Check size={14} weight="bold" /> {t("testsPassed_other", { count: 14 })}</div></div></div><div className="activity pending"><div className="activity-icon"><WarningCircle size={16} /></div><div className="activity-content"><div className="activity-title"><strong>{t("approvalNeeded")}</strong><span>{t("now")}</span></div><p>{t("allowEdit", { name: "Astra" })} <code>src/services/auth.ts</code></p><div className="approval-actions"><button className="approve" onClick={() => setApproval(false)}><Check size={14} /> {t("allowOnce")}</button><button className="deny" onClick={() => setApproval(false)}>{t("deny")}</button></div></div></div><div className="typing"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /> {t("working", { name: "Astra" })}</div></div>{approval && <div className="approval-toast"><div><strong>{t("approvalNeeded")}</strong><span>{t("allowEdit", { name: "Astra" })} <code>src/services/auth.ts</code></span></div><button className="approve" onClick={() => setApproval(false)}>{t("allowOnce")}</button><button className="deny" onClick={() => setApproval(false)}>{t("deny")}</button></div>}<Composer draft={draft} setDraft={setDraft} sendMessage={sendMessage} /></div>;
}

function CollabView({ activeNode, setActiveNode, setApproval }) {
  const { t } = useI18n();
  return <div className="collab-view"><div className="collab-header"><div><span className="eyebrow">{t("collaborationWorkflow")}</span><h2>{t("reviewLoop")} · 3</h2></div><div className="collab-actions"><button className="compact-btn"><Plus size={14} /> {t("addMember")}</button><button className="compact-btn"><Check size={14} /> {t("saveTemplate")}</button></div></div><div className="flow-canvas"><div className="flow-grid" /><div className="flow-line line-one" /><div className="flow-line line-two" /><div className="flow-line line-return" /><span className="line-label label-create">{t("createsChanges")}</span><span className="line-label label-approved">{t("ifApproved")}</span><span className="line-label label-parallel">{t("inParallel")}</span><span className="return-label">{t("changesRequested")}</span>{FLOW_NODES.map((node, index) => { const Icon = node.icon; return <button key={node.id} className={`flow-node ${node.tone} ${activeNode === node.id ? "selected" : ""}`} style={{ left: node.x, top: node.y }} onClick={() => { setActiveNode(node.id); if (node.id === "review") setApproval(true); }}><div className="node-top"><span className="node-icon"><Icon size={19} weight="bold" /></span><span className="node-step">{index + 1}</span><span className="node-state">{node.state === "working" ? <Play size={11} weight="fill" /> : node.state === "pending" ? <WarningCircle size={13} /> : <Pause size={12} weight="fill" />}</span></div><strong>{t(`role.${node.id}`)}</strong><span>{t(`detail.${node.id}`)}</span><small>{node.model}</small></button>; })}</div><div className="collab-bottom"><div><span className="muted">{t("currentMember")}</span><strong><span className="member-dot peach" /> Implement · Claude 3.5 Sonnet</strong></div><div><span className="muted">{t("sharedContext")}</span><strong>{t("sharedSummary", { files: 12, messages: 2, approvals: 1 })}</strong></div><button className="control-btn" onClick={() => setApproval(true)}><WarningCircle size={15} /> {t("reviewApproval")}</button></div></div>;
}

function FilesView() {
  const { t } = useI18n();
  return <div className="context-body"><div className="context-title"><strong>agent-router</strong><span>main</span></div><div className="repo-line"><GitBranch size={14} /> main <span className="green">+12,460</span> <span className="red">−380</span></div><div className="file-tree">{FILES.map((file) => <div className={`file-row ${file.active ? "active" : ""}`} style={{ paddingLeft: `${12 + (file.indent ?? 0) * 16}px` }} key={file.name}>{file.type === "folder" ? <FolderSimple size={15} weight={file.open ? "fill" : "regular"} /> : <File size={15} />}{file.name}</div>)}</div><div className="context-footer"><span>{t("branch")}</span><strong>main</strong><span>{t("changes")}</span><strong>{t("fileCount_other", { count: 3 })}</strong></div></div>;
}
function DiffView() {
  const { t } = useI18n();
  return <div className="context-body"><div className="context-title"><strong>{t("pendingChanges")}</strong><span className="tab-count">3</span></div><div className="diff-file"><div className="diff-header"><File size={14} /> src/services/auth.ts <span>+12 −4</span></div><pre><span className="diff-add">+ return session ?? createSession(user);</span>{"\n"}<span className="diff-remove">- return createSession(user);</span>{"\n"}<span className="diff-add">+ if (!user) throw new AuthError();</span></pre></div><div className="diff-file"><div className="diff-header"><File size={14} /> tests/login.spec.ts <span>+18 −0</span></div><pre><span className="diff-add">+ it("rejects an expired session", ...)</span></pre></div><button className="review-btn"><GitDiff size={14} /> {t("reviewChanges")}</button></div>;
}
function VerifyView() {
  const { t } = useI18n();
  return <div className="context-body"><div className="context-title"><strong>{t("verification")}</strong><span className="green">{t("passed")}</span></div><div className="verify-item"><CheckCircle size={16} weight="fill" /><div><strong>{t("unitTests")}</strong><span>14 passed · 2.3s</span></div></div><div className="verify-item"><CheckCircle size={16} weight="fill" /><div><strong>{t("typecheck")}</strong><span>{t("clean")} · 1.1s</span></div></div><div className="verify-item pending"><Clock size={16} /><div><strong>{t("reviewApproval")}</strong><span>{t("waitingDecision")}</span></div></div><button className="review-btn"><Play size={14} weight="fill" /> {t("runAgain")}</button></div>;
}

function CommandPalette({ open, setOpen, setMode, setContextTab, setContextOpen }) {
  const { t } = useI18n();
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="command-overlay" /><Dialog.Content className="command-dialog"><Dialog.Title className="sr-only">{t("commandPalette")}</Dialog.Title><Command label="habor commands"><Command.Input placeholder={t("commandSearch")} autoFocus /><Command.List><Command.Empty>{t("noResults")}</Command.Empty><Command.Group heading={t("navigate")}><Command.Item onSelect={() => { setMode("solo"); setOpen(false); }}>{t("openSolo")}</Command.Item><Command.Item onSelect={() => { setMode("collab"); setOpen(false); }}>{t("openCollab")}</Command.Item><Command.Item onSelect={() => { setContextTab("files"); setContextOpen(true); setOpen(false); }}>{t("showFiles")}</Command.Item><Command.Item onSelect={() => { setContextTab("diff"); setContextOpen(true); setOpen(false); }}>{t("showDiff")}</Command.Item><Command.Item onSelect={() => { setContextTab("verify"); setContextOpen(true); setOpen(false); }}>{t("showVerify")}</Command.Item></Command.Group><Command.Group heading={t("task")}><Command.Item onSelect={() => setOpen(false)}>{t("newTask")}</Command.Item><Command.Item onSelect={() => setOpen(false)}>{t("resume")}</Command.Item><Command.Item onSelect={() => setOpen(false)}>{t("agents")}</Command.Item></Command.Group></Command.List></Command></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
