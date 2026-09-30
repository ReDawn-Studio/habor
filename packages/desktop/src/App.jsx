import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight, CaretDown, Check, CheckCircle, Clock, DotsThree, File, FolderSimple,
  GitBranch, GitDiff, Graph, ListChecks, MagnifyingGlass, Paperclip, Pause, Play,
  Plus, Robot, ShieldCheck, Sparkle, TerminalWindow, WarningCircle, X,
} from "@phosphor-icons/react";

const TASKS = [
  { id: "fix-login", title: "Fix login error and add test coverage", status: "working", time: "2m ago" },
  { id: "audit-logging", title: "Add audit logging", status: "done", time: "Yesterday" },
  { id: "onboarding", title: "Improve onboarding flow", status: "done", time: "Sep 28" },
  { id: "data-layer", title: "Refactor data layer", status: "done", time: "Sep 27" },
  { id: "dependencies", title: "Update dependencies", status: "done", time: "Sep 26" },
];

const FILES = [
  { name: "src", type: "folder", open: true }, { name: "services", type: "folder", open: true, indent: 1 },
  { name: "auth.ts", type: "file", indent: 2, active: true }, { name: "session.ts", type: "file", indent: 2 },
  { name: "tests", type: "folder", open: true, indent: 1 }, { name: "login.spec.ts", type: "file", indent: 2 },
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

function StatusDot({ status }) { return <span className={`status-dot ${status}`} aria-label={status} />; }

export function App() {
  const [mode, setMode] = useState("solo");
  const [contextTab, setContextTab] = useState("files");
  const [selectedTask, setSelectedTask] = useState("fix-login");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(seedMessages);
  const [approval, setApproval] = useState(false);
  const [activeNode, setActiveNode] = useState("implement");
  const [commandOpen, setCommandOpen] = useState(false);
  const currentTask = useMemo(() => TASKS.find((task) => task.id === selectedTask) ?? TASKS[0], [selectedTask]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function sendMessage() {
    const text = draft.trim();
    if (!text) return;
    setMessages((items) => [...items, { who: "You", time: "Now", text, kind: "user" }, { who: "Astra", time: "Now", text: "I’ve added this to the current task and will keep the existing context intact.", kind: "assistant" }]);
    setDraft("");
  }

  return <main className="app-shell">
    <header className="titlebar"><div className="brand"><div className="brand-mark"><Sparkle size={16} weight="fill" /></div><span>habor</span><CaretDown size={13} /></div><div className="titlebar-task"><span className="crumb">agent-router</span><span className="slash">/</span><span>{currentTask.title}</span></div><div className="titlebar-actions"><button className="command-trigger" onClick={() => setCommandOpen(true)}><MagnifyingGlass size={15} /><span>Search</span><kbd>⌘K</kbd></button><button className="icon-btn" aria-label="More"><DotsThree size={20} /></button><div className="avatar">JM</div></div></header>
    <div className="workspace-grid"><Sidebar selectedTask={selectedTask} setSelectedTask={setSelectedTask} /><section className="main-column"><div className="task-toolbar"><div className="task-heading"><div className="status-pill"><span className="pulse" /> Running</div><h1>{currentTask.title}</h1><span className="task-id">task-7fa2</span></div><div className="task-controls"><div className="mode-switch"><button className={mode === "solo" ? "active" : ""} onClick={() => setMode("solo")}>Solo</button><button className={mode === "collab" ? "active" : ""} onClick={() => setMode("collab")}>Collaborate</button></div><button className="control-btn"><Pause size={15} weight="fill" /> Pause</button><button className="control-btn danger"><X size={15} weight="bold" /> Cancel</button></div></div><AnimatePresence mode="wait" initial={false}>{mode === "solo" ? <motion.div key="solo" className="view-transition" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .16 }}><SoloView messages={messages} draft={draft} setDraft={setDraft} sendMessage={sendMessage} approval={approval} setApproval={setApproval} /></motion.div> : <motion.div key="collab" className="view-transition" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .16 }}><CollabView activeNode={activeNode} setActiveNode={setActiveNode} setApproval={setApproval} /></motion.div>}</AnimatePresence></section><aside className="context-panel"><Tabs.Root value={contextTab} onValueChange={setContextTab} className="context-tabs"><Tabs.List><Tabs.Trigger value="files"><File size={15} /> Files</Tabs.Trigger><Tabs.Trigger value="diff"><GitDiff size={15} /> Diff <span className="tab-count">3</span></Tabs.Trigger><Tabs.Trigger value="verify"><CheckCircle size={15} /> Verify</Tabs.Trigger></Tabs.List></Tabs.Root>{contextTab === "files" && <FilesView />}{contextTab === "diff" && <DiffView />}{contextTab === "verify" && <VerifyView />}</aside></div>
    <CommandPalette open={commandOpen} setOpen={setCommandOpen} setMode={setMode} setContextTab={setContextTab} />
  </main>;
}

function Sidebar({ selectedTask, setSelectedTask }) {
  return <aside className="sidebar"><div className="sidebar-top"><button className="new-task"><Plus size={16} weight="bold" /> New task</button><button className="icon-btn"><MagnifyingGlass size={16} /></button></div><div className="sidebar-section"><div className="section-label">PROJECTS <DotsThree size={15} /></div><div className="project-row active"><FolderSimple size={16} weight="fill" /><span>agent-router</span><span className="branch">main</span></div></div><div className="sidebar-section task-section"><div className="section-label">TASKS <span className="count">{TASKS.length}</span></div>{TASKS.map((task) => <button key={task.id} className={`task-row ${task.id === selectedTask ? "selected" : ""}`} onClick={() => setSelectedTask(task.id)}><StatusDot status={task.status} /><span className="task-title">{task.title}</span><span className="task-time">{task.time}</span></button>)}</div><div className="sidebar-section"><div className="section-label">TEMPLATES</div><button className="template-row"><Graph size={15} /> Solo task</button><button className="template-row"><ListChecks size={15} /> Review loop</button><button className="template-row"><GitBranch size={15} /> Ship workflow</button></div><div className="sidebar-footer"><button className="footer-row"><Robot size={16} /> Agents &amp; models</button><button className="footer-row"><GitBranch size={16} /> Settings</button></div></aside>;
}

function SoloView({ messages, draft, setDraft, sendMessage, approval, setApproval }) {
  return <div className="solo-view"><div className="execution-strip"><div><span className="muted">Active member</span><strong><span className="member-dot peach" /> Astra</strong></div><div><span className="muted">Model</span><strong>GPT-6 Astra</strong></div><div><span className="muted">Native agent</span><strong>Codex ACP</strong></div><div><span className="muted">Permission</span><strong className="permission"><ShieldCheck size={14} /> Ask</strong></div></div><div className="conversation-scroll"><div className="processed"><CheckCircle size={14} weight="fill" /> Started 2m ago · 1 run</div>{messages.map((message, index) => <div className={`message ${message.kind}`} key={`${message.time}-${index}`}><div className="message-meta"><span className={`message-avatar ${message.kind}`}>{message.kind === "user" ? "You" : <Sparkle size={13} weight="fill" />}</span><strong>{message.who}</strong><span>{message.time}</span></div><div className="message-body">{message.text}</div></div>)}<div className="activity"><div className="activity-icon"><TerminalWindow size={16} /></div><div className="activity-content"><div className="activity-title"><strong>Running command</strong><span>12s</span></div><code>pnpm test packages/auth</code><div className="activity-result"><Check size={14} weight="bold" /> 14 tests passed</div></div></div><div className="activity pending"><div className="activity-icon"><WarningCircle size={16} /></div><div className="activity-content"><div className="activity-title"><strong>Approval needed</strong><span>now</span></div><p>Allow Astra to update <code>src/services/auth.ts</code>?</p><div className="approval-actions"><button className="approve" onClick={() => setApproval(false)}><Check size={14} /> Allow once</button><button className="deny" onClick={() => setApproval(false)}>Deny</button></div></div></div><div className="typing"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /> Astra is working</div></div>{approval && <div className="approval-toast"><div><strong>Approval is required</strong><span>Astra wants to edit <code>src/services/auth.ts</code></span></div><button className="approve" onClick={() => setApproval(false)}>Allow once</button><button className="deny" onClick={() => setApproval(false)}>Deny</button></div>}<div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Message habor…" /><div className="composer-tools"><button className="icon-btn"><Plus size={20} /></button><button className="icon-btn"><Paperclip size={18} /></button><span className="composer-hint">Message habor…</span></div><div className="composer-bottom"><button className="access-pill"><ShieldCheck size={14} /> Ask</button><span className="composer-spacer" /><button className="model-select">GPT-6 Astra <CaretDown size={13} /></button><button className="send-btn" onClick={sendMessage} aria-label="Send"><ArrowRight size={17} weight="bold" /></button></div></div></div>;
}

function CollabView({ activeNode, setActiveNode, setApproval }) {
  return <div className="collab-view"><div className="collab-header"><div><span className="eyebrow">COLLABORATION WORKFLOW</span><h2>Review loop · 3 members</h2></div><div className="collab-actions"><button className="compact-btn"><Plus size={14} /> Add member</button><button className="compact-btn"><Check size={14} /> Save template</button></div></div><div className="flow-canvas"><div className="flow-grid" /><div className="flow-line line-one" /><div className="flow-line line-two" /><div className="flow-line line-return" /><span className="line-label label-create">Creates changes</span><span className="line-label label-approved">If approved</span><span className="line-label label-parallel">In parallel</span><span className="return-label">Changes requested</span>{FLOW_NODES.map((node, index) => { const Icon = node.icon; return <button key={node.id} className={`flow-node ${node.tone} ${activeNode === node.id ? "selected" : ""}`} style={{ left: node.x, top: node.y }} onClick={() => { setActiveNode(node.id); if (node.id === "review") setApproval(true); }}><div className="node-top"><span className="node-icon"><Icon size={19} weight="bold" /></span><span className="node-step">{index + 1}</span><span className="node-state">{node.state === "working" ? <Play size={11} weight="fill" /> : node.state === "pending" ? <WarningCircle size={13} /> : <Pause size={12} weight="fill" />}</span></div><strong>{node.title}</strong><span>{node.detail}</span><small>{node.model}</small></button>; })}</div><div className="collab-bottom"><div><span className="muted">Current member</span><strong><span className="member-dot peach" /> Implement · Claude 3.5 Sonnet</strong></div><div><span className="muted">Shared context</span><strong>12 files · 2 messages · 1 approval</strong></div><button className="control-btn" onClick={() => setApproval(true)}><WarningCircle size={15} /> Review approval</button></div></div>;
}

function FilesView() { return <div className="context-body"><div className="context-title"><strong>agent-router</strong><span>main</span></div><div className="repo-line"><GitBranch size={14} /> main <span className="green">+12,460</span> <span className="red">−380</span></div><div className="file-tree">{FILES.map((file) => <div className={`file-row ${file.active ? "active" : ""}`} style={{ paddingLeft: `${12 + (file.indent ?? 0) * 16}px` }} key={file.name}>{file.type === "folder" ? <FolderSimple size={15} weight={file.open ? "fill" : "regular"} /> : <File size={15} />}{file.name}</div>)}</div><div className="context-footer"><span>Branch</span><strong>main</strong><span>Changes</span><strong>3 files</strong></div></div>; }
function DiffView() { return <div className="context-body"><div className="context-title"><strong>Pending changes</strong><span className="tab-count">3</span></div><div className="diff-file"><div className="diff-header"><File size={14} /> src/services/auth.ts <span>+12 −4</span></div><pre><span className="diff-add">+ return session ?? createSession(user);</span>{"\n"}<span className="diff-remove">- return createSession(user);</span>{"\n"}<span className="diff-add">+ if (!user) throw new AuthError();</span></pre></div><div className="diff-file"><div className="diff-header"><File size={14} /> tests/login.spec.ts <span>+18 −0</span></div><pre><span className="diff-add">+ it("rejects an expired session", ...)</span></pre></div><button className="review-btn"><GitDiff size={14} /> Review changes</button></div>; }
function VerifyView() { return <div className="context-body"><div className="context-title"><strong>Verification</strong><span className="green">Passed</span></div><div className="verify-item"><CheckCircle size={16} weight="fill" /><div><strong>Unit tests</strong><span>14 passed · 2.3s</span></div></div><div className="verify-item"><CheckCircle size={16} weight="fill" /><div><strong>Typecheck</strong><span>Clean · 1.1s</span></div></div><div className="verify-item pending"><Clock size={16} /><div><strong>Review approval</strong><span>Waiting for your decision</span></div></div><button className="review-btn"><Play size={14} weight="fill" /> Run verification again</button></div>; }

function CommandPalette({ open, setOpen, setMode, setContextTab }) {
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="command-overlay" /><Dialog.Content className="command-dialog"><Dialog.Title className="sr-only">Command palette</Dialog.Title><Command label="habor commands"><Command.Input placeholder="Search tasks, commands, panels…" autoFocus /><Command.List><Command.Empty>No results.</Command.Empty><Command.Group heading="Navigate"><Command.Item onSelect={() => { setMode("solo"); setOpen(false); }}>Open Solo workspace</Command.Item><Command.Item onSelect={() => { setMode("collab"); setOpen(false); }}>Open Collaborate workflow</Command.Item><Command.Item onSelect={() => { setContextTab("files"); setOpen(false); }}>Show Files</Command.Item><Command.Item onSelect={() => { setContextTab("diff"); setOpen(false); }}>Show Diff</Command.Item><Command.Item onSelect={() => { setContextTab("verify"); setOpen(false); }}>Show Verify</Command.Item></Command.Group><Command.Group heading="Task"><Command.Item onSelect={() => setOpen(false)}>New task</Command.Item><Command.Item onSelect={() => setOpen(false)}>Resume history</Command.Item><Command.Item onSelect={() => setOpen(false)}>Manage agents &amp; models</Command.Item></Command.Group></Command.List></Command></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
