'use client';

import Link from 'next/link';
import React, { useEffect, useRef, useState } from 'react';

/* =========================
 * Types
 * =======================*/
type MsgKind = 'text' | 'card' | 'widget';
type Role = 'user' | 'assistant' | 'system';

type BaseMsg = {
  id: string;
  role: Role;
  kind: MsgKind;
  createdAt: number;
};

type TextMsg = BaseMsg & {
  kind: 'text';
  text: string;
};

type ActivityType = 'call' | 'email' | 'task' | 'note';
type ActivityStatus = 'pending' | 'approved' | 'discarded' | 'edited';

type CardAction = 'approve' | 'edit' | 'discard';

type CardMsg = BaseMsg & {
  kind: 'card';
  activityType: ActivityType;
  status: ActivityStatus;
  title: string;
  body: string;
  matterId?: string | null;
  contactId?: string | null;
  durationMin?: number; // for calls/time entries
  actions?: CardAction[];
  // UI local
  _editing?: boolean;
};

type WidgetMsg = BaseMsg & {
  kind: 'widget';
  widgetType: 'unbilled' | 'revenue' | 'tasks' | string;
  data: any;
};

type ChatMsg = TextMsg | CardMsg | WidgetMsg;

/* =========================
 * Mock data (Step 2 only)
 * =======================*/
const MATTERS = [
  { id: 'm1', name: 'Smith v. Coastal Insurance' },
  { id: 'm2', name: 'Acme vs. Westshore Logistics' },
  { id: 'm3', name: 'In re: Jameson Probate' },
];

const CONTACTS = [
  { id: 'c1', name: 'Jordan Smith (Client)' },
  { id: 'c2', name: 'Alex Rivera (Opposing Counsel)' },
  { id: 'c3', name: 'Judge Thompson (Chambers)' },
];

/* =========================
 * Helpers
 * =======================*/
const now = () => Date.now();
const newId = () => Math.random().toString(36).slice(2);

function cap(s: string) {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

function tmsg(text: string): TextMsg {
  return { id: newId(), role: 'assistant', kind: 'text', text, createdAt: now() };
}

function iconFor(type: ActivityType) {
  const map: Record<ActivityType, string> = {
    call: '📞',
    email: '✉️',
    task: '✅',
    note: '📝',
  };
  return <span className="mr-1">{map[type]}</span>;
}

/* =========================
 * Page
 * =======================*/
export default function ChatPage() {
  const [micOn, setMicOn] = useState(false);
  const [value, setValue] = useState('');
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    tmsg("Hi! I'm Alexis. Type or speak to manage cases. This chat now supports actionable cards."),
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs.length]);

  /* ===== composer send (text) ===== */
  function sendText() {
    const text = value.trim();
    if (!text) return;

    const userMsg: TextMsg = { id: newId(), role: 'user', kind: 'text', text, createdAt: now() };
    setMsgs((m) => [...m, userMsg]);
    setValue('');

    // tiny echo to show flow
    setTimeout(() => {
      setMsgs((m) => [
        ...m,
        tmsg(`(Step 2 echo) Understood: “${text}”. You can also try the demo buttons above to insert cards.`),
      ]);
    }, 200);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  }

  function toggleMic() {
    setMicOn((on) => !on);
  }

  /* ===== card demos ===== */
  function injectDemo(type: ActivityType) {
    const base: Omit<CardMsg, 'id' | 'createdAt'> = {
      role: 'assistant',
      kind: 'card',
      activityType: type,
      status: 'pending',
      actions: ['approve', 'edit', 'discard'],
      title: '',
      body: '',
      matterId: MATTERS[0].id,
      contactId: CONTACTS[0].id,
      durationMin: type === 'call' ? 12 : undefined,
      _editing: false,
    };

    const presets: Record<ActivityType, Pick<CardMsg, 'title' | 'body'>> = {
      call: {
        title: 'Log Call Time',
        body:
          'Inbound call with Jordan Smith regarding PT/OT schedule and settlement expectations.\n' +
          'Next steps: send follow-up email and request updated medical records.',
      },
      email: {
        title: 'Email Summary',
        body:
          'Draft reply to opposing counsel confirming receipt of discovery and offering 7-day extension.\n' +
          'Tone: professional and cooperative.',
      },
      task: {
        title: 'Create Task',
        body: 'Prepare discovery responses draft; due in 5 days. Subtasks: docs index; client answers.',
      },
      note: {
        title: 'Add Case Note',
        body: 'Client called anxious about timeline; reassured. Add to timeline and notify paralegal.',
      },
    };

    const msg: CardMsg = {
      id: newId(),
      createdAt: now(),
      ...base,
      ...presets[type],
    };

    setMsgs((m) => [...m, msg]);
  }

  /* ===== card actions ===== */
  function onApprove(id: string) {
    setMsgs((m) =>
      m.map((msg) => (msg.kind === 'card' && msg.id === id ? { ...msg, status: 'approved', _editing: false } : msg))
    );
    setMsgs((m) => [...m, tmsg('Approved. (API stub) This would write to DB + timeline and create a time entry if needed.')]);
  }

  function onDiscard(id: string) {
    setMsgs((m) =>
      m.map((msg) => (msg.kind === 'card' && msg.id === id ? { ...msg, status: 'discarded', _editing: false } : msg))
    );
  }

  function onToggleEdit(id: string) {
    setMsgs((m) =>
      m.map((msg) => (msg.kind === 'card' && msg.id === id ? { ...msg, _editing: !msg._editing } : msg))
    );
  }

  function onSaveEdit(id: string, patch: Partial<CardMsg>) {
    setMsgs((m) =>
      m.map((msg) =>
        msg.kind === 'card' && msg.id === id
          ? {
              ...msg,
              ...patch,
              status: msg.status === 'pending' ? 'edited' : msg.status,
              _editing: false,
            }
          : msg
      )
    );
  }

  function onPickMatter(id: string, matterId: string) {
    setMsgs((m) => m.map((msg) => (msg.kind === 'card' && msg.id === id ? { ...msg, matterId } : msg)));
  }

  function onPickContact(id: string, contactId: string) {
    setMsgs((m) => m.map((msg) => (msg.kind === 'card' && msg.id === id ? { ...msg, contactId } : msg)));
  }

  return (
    <main className="min-h-screen bg-black text-neutral-100">
      <div className="mx-auto w-full max-w-[1150px] px-4 py-6">
        <div className="relative rounded-[24px] border border-neutral-800/60 bg-[#0b0b0f]/75 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_18px_48px_rgba(0,0,0,0.5)]">
          {/* Header */}
          <header className="flex items-center justify-between border-b border-neutral-800/70 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 font-semibold">C</div>
              <h1 className="text-lg font-semibold tracking-tight">Case Management Chat</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-neutral-800 px-3 py-1 text-xs">Disconnected</span>
              <Link href="/" className="rounded-xl bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700">
                ← Back
              </Link>
            </div>
          </header>

          {/* Demo toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800/70 px-5 py-3 text-xs">
            <span className="text-neutral-400">Insert demo:</span>
            <ToolbarBtn onClick={() => injectDemo('call')}>+ Call Card</ToolbarBtn>
            <ToolbarBtn onClick={() => injectDemo('email')}>+ Email Card</ToolbarBtn>
            <ToolbarBtn onClick={() => injectDemo('task')}>+ Task Card</ToolbarBtn>
            <ToolbarBtn onClick={() => injectDemo('note')}>+ Note Card</ToolbarBtn>
            <span className="ml-2 text-neutral-500">Approve/Edit/Discard are UI-wired (no API yet).</span>
          </div>

          {/* Message list */}
          <div ref={listRef} className="h-[64vh] min-h-[420px] w-full overflow-y-auto px-5 py-4 space-y-3">
            {msgs.map((m) =>
              m.kind === 'text' ? (
                <TextBubble key={m.id} msg={m as TextMsg} />
              ) : m.kind === 'card' ? (
                <ActivityCard
                  key={m.id}
                  msg={m as CardMsg}
                  onApprove={onApprove}
                  onDiscard={onDiscard}
                  onToggleEdit={onToggleEdit}
                  onSaveEdit={onSaveEdit}
                  onPickMatter={onPickMatter}
                  onPickContact={onPickContact}
                />
              ) : (
                <WidgetBubble key={m.id} msg={m as WidgetMsg} />
              )
            )}
          </div>

          {/* Composer */}
          <footer className="border-t border-neutral-800/70 px-5 py-4">
            <div className="flex items-end gap-3">
              <button
                type="button"
                onClick={toggleMic}
                className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                  micOn
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700'
                }`}
                aria-pressed={micOn}
                title={micOn ? 'Mic on' : 'Mic off'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"></path>
                  <path d="M19 11a7 7 0 0 1-14 0"></path>
                  <path d="M12 19v3"></path>
                </svg>
              </button>

              <div className="flex-1">
                <div className="rounded-xl border border-neutral-800 bg-[#0e0e12] px-3 py-2">
                  <textarea
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Ask Alexis to log time, draft an email, or create a task…"
                    className="h-24 w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-neutral-500"
                  />
                  <div className="flex items-center justify-between pt-2">
                    <div className="text-[11px] text-neutral-500">Enter to send • Shift+Enter for newline</div>
                    <button
                      type="button"
                      onClick={sendText}
                      className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400"
                    >
                      Send <span aria-hidden>↩</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
}

/* =========================
 * Components
 * =======================*/

function ToolbarBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, children, type, ...rest } = props;
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={
        'rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1 text-[12px] text-neutral-200 hover:border-neutral-700 ' +
        (className ?? '')
      }
    >
      {children}
    </button>
  );
}

function TextBubble({ msg }: { msg: TextMsg }) {
  const isAssistant = msg.role !== 'user';
  const base =
    'max-w-[75%] rounded-2xl border px-3 py-2 text-sm whitespace-pre-wrap break-words ';
  return (
    <div className={`flex ${isAssistant ? '' : 'justify-end'}`}>
      <div
        className={
          base +
          (isAssistant
            ? 'border-neutral-800 bg-neutral-900/80'
            : 'border-emerald-800/70 bg-emerald-900/30')
        }
      >
        {msg.text}
      </div>
    </div>
  );
}

function WidgetBubble({ msg }: { msg: WidgetMsg }) {
  return (
    <div className="flex">
      <div className="max-w-[75%] rounded-2xl border border-neutral-800 bg-neutral-900/80 px-4 py-3">
        <div className="text-[13px] font-semibold mb-1">Widget: {msg.widgetType}</div>
        <div className="text-sm text-neutral-300">(Widget renderer placeholder — coming later)</div>
      </div>
    </div>
  );
}

function ActivityCard({
  msg,
  onApprove,
  onDiscard,
  onToggleEdit,
  onSaveEdit,
  onPickMatter,
  onPickContact,
}: {
  msg: CardMsg;
  onApprove: (id: string) => void;
  onDiscard: (id: string) => void;
  onToggleEdit: (id: string) => void;
  onSaveEdit: (id: string, patch: Partial<CardMsg>) => void;
  onPickMatter: (id: string, matterId: string) => void;
  onPickContact: (id: string, contactId: string) => void;
}) {
  const [draftTitle, setDraftTitle] = useState(msg.title);
  const [draftBody, setDraftBody] = useState(msg.body);
  const [draftDuration, setDraftDuration] = useState<number | undefined>(msg.durationMin);

  const statusBadge = {
    pending: 'bg-neutral-800 text-neutral-300',
    approved: 'bg-emerald-800/40 text-emerald-300 border-emerald-700/60',
    discarded: 'bg-neutral-900/80 text-neutral-500 border-neutral-800/80',
    edited: 'bg-amber-800/30 text-amber-300 border-amber-700/60',
  }[msg.status];

  return (
    <div className="flex">
      <div
        className={
          'max-w-[75%] rounded-2xl border px-4 py-3 ' +
          (msg.status === 'discarded' ? 'opacity-60 ' : '') +
          'border-neutral-800 bg-neutral-900/80'
        }
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[13px] font-semibold">
            {iconFor(msg.activityType)} {cap(msg.activityType)} {msg.activityType === 'call' ? 'Card' : ''}
          </span>
          <span className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] ${statusBadge}`}>
            {cap(msg.status)}
          </span>
        </div>

        {/* Matter & Contact chips */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <ChipPicker
            label="Matter"
            items={MATTERS}
            selectedId={msg.matterId || undefined}
            onPick={(id) => onPickMatter(msg.id, id)}
          />
          <ChipPicker
            label="Contact"
            items={CONTACTS}
            selectedId={msg.contactId || undefined}
            onPick={(id) => onPickContact(msg.id, id)}
          />
          {msg.activityType === 'call' && (
            <span className="rounded-md border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-[11px] text-neutral-300">
              Duration: {msg.durationMin ?? 0} min
            </span>
          )}
        </div>

        {/* Content / Edit */}
        {msg._editing ? (
          <div className="space-y-2">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-[13px] outline-none"
              placeholder="Title"
            />
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-sm outline-none"
              placeholder="Details"
            />
            {msg.activityType === 'call' && (
              <div className="flex items-center gap-2">
                <label className="text-[12px] text-neutral-400">Duration (min)</label>
                <input
                  type="number"
                  min={0}
                  value={draftDuration ?? 0}
                  onChange={(e) => setDraftDuration(Number(e.target.value))}
                  className="w-24 rounded-md border border-neutral-800 bg-neutral-950/70 px-2 py-1 text-sm outline-none"
                />
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  onSaveEdit(msg.id, {
                    title: draftTitle,
                    body: draftBody,
                    durationMin: msg.activityType === 'call' ? draftDuration : msg.durationMin,
                  })
                }
                className="rounded-md bg-emerald-600 px-3 py-1 text-[12px] font-semibold text-black hover:bg-emerald-500"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => onToggleEdit(msg.id)}
                className="rounded-md border border-neutral-800 bg-neutral-950/70 px-3 py-1 text-[12px]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-[13px] font-semibold mb-1">{msg.title}</div>
            <div className="whitespace-pre-wrap text-sm text-neutral-200">{msg.body}</div>
            {msg.activityType === 'call' && (
              <div className="mt-2 text-[12px] text-neutral-400">(Will create a time entry on Approve.)</div>
            )}
          </>
        )}

        {/* Actions */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onApprove(msg.id)}
            disabled={msg.status === 'approved' || msg.status === 'discarded'}
            className={
              'rounded-md px-2 py-1 text-[12px] font-medium ' +
              (msg.status === 'approved'
                ? 'bg-emerald-700/40 text-emerald-200 cursor-not-allowed'
                : 'border border-neutral-800 bg-neutral-950/60 hover:border-neutral-700')
            }
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onToggleEdit(msg.id)}
            disabled={msg.status === 'discarded'}
            className={
              'rounded-md px-2 py-1 text-[12px] font-medium ' +
              (msg._editing
                ? 'bg-amber-700/40 text-amber-200'
                : 'border border-neutral-800 bg-neutral-950/60 hover:border-neutral-700')
            }
          >
            {msg._editing ? 'Editing…' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={() => onDiscard(msg.id)}
            disabled={msg.status === 'discarded'}
            className={
              'rounded-md px-2 py-1 text-[12px] font-medium ' +
              (msg.status === 'discarded'
                ? 'bg-neutral-800 text-neutral-400 cursor-not-allowed'
                : 'border border-neutral-800 bg-neutral-950/60 hover:border-neutral-700')
            }
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

function ChipPicker({
  label,
  items,
  selectedId,
  onPick,
}: {
  label: string;
  items: { id: string; name: string }[];
  selectedId?: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.id === selectedId) || items[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/70 px-2 py-1"
      >
        <span className="text-[11px] text-neutral-400">{label}:</span>
        <span className="text-[12px] text-neutral-200">{selected?.name}</span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="text-neutral-400">
          <path d="M5.5 7.5l4.5 4.5 4.5-4.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 shadow-xl">
          <ul className="max-h-56 overflow-y-auto text-sm">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(it.id);
                    setOpen(false);
                  }}
                  className={
                    'flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-neutral-900 ' +
                    (it.id === selected?.id ? 'text-emerald-300' : 'text-neutral-200')
                  }
                >
                  {it.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
