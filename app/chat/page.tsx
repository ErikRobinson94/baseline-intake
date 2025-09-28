'use client';

import Link from 'next/link';
import React, { useEffect, useRef, useState } from 'react';

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

type CardAction = 'approve' | 'edit' | 'discard';
type CardMsg = BaseMsg & {
  kind: 'card';
  title: string;
  body: string;
  // For now, actions are shown but disabled; we’ll wire Approve/Edit/Discard in Step 2.
  actions?: CardAction[];
};

type WidgetMsg = BaseMsg & {
  kind: 'widget';
  widgetType: 'unbilled' | 'revenue' | 'tasks' | string;
  data: any;
};

type ChatMsg = TextMsg | CardMsg | WidgetMsg;

const now = () => Date.now();
const id = () => Math.random().toString(36).slice(2);

export default function ChatPage() {
  const [micOn, setMicOn] = useState(false);
  const [value, setValue] = useState('');
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      id: id(),
      role: 'assistant',
      kind: 'text',
      text: "Hi! I'm Alexis. Type or speak to manage cases. This is the new chat shell.",
      createdAt: now(),
    },
    {
      id: id(),
      role: 'assistant',
      kind: 'card',
      title: 'What I can do next',
      body:
        `• Log time from calls/emails\n` +
        `• Draft follow-ups\n` +
        `• Create tasks/notes\n` +
        `• Link items to matters\n\n` +
        `Use the composer below — we’ll wire real actions next.`,
      actions: ['approve', 'edit', 'discard'],
      createdAt: now(),
    },
  ]);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs.length]);

  function sendText() {
    const text = value.trim();
    if (!text) return;

    const userMsg: TextMsg = {
      id: id(),
      role: 'user',
      kind: 'text',
      text,
      createdAt: now(),
    };
    setMsgs((m) => [...m, userMsg]);
    setValue('');

    // For Step 1 we just echo a simple assistant response.
    const assistantMsg: TextMsg = {
      id: id(),
      role: 'assistant',
      kind: 'text',
      text: `Got it. (Step 1 echo) You said: “${text}”.\n\nNext step: cards with Approve / Edit / Discard.`,
      createdAt: now() + 1,
    };
    setTimeout(() => setMsgs((m) => [...m, assistantMsg]), 250);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  }

  function toggleMic() {
    // Mic UI only in Step 1; we wire Deepgram → chat in “Deepgram Ingest” step.
    setMicOn((on) => !on);
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
              <Link
                href="/"
                className="rounded-xl bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
              >
                ← Back
              </Link>
            </div>
          </header>

          {/* Message list */}
          <div ref={listRef} className="h-[68vh] min-h-[420px] w-full overflow-y-auto px-5 py-4 space-y-3">
            {msgs.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
          </div>

          {/* Composer */}
          <footer className="border-t border-neutral-800/70 px-5 py-4">
            <div className="flex items-end gap-3">
              <button
                onClick={toggleMic}
                className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                  micOn
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700'
                }`}
                aria-pressed={micOn}
                title={micOn ? 'Mic on' : 'Mic off'}
              >
                {/* inline mic icon */}
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
                    <div className="text-[11px] text-neutral-500">
                      Enter to send • Shift+Enter for newline
                    </div>
                    <button
                      onClick={sendText}
                      className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400"
                    >
                      Send
                      <span aria-hidden>↩</span>
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

/** ——— Simple message renderers for Step 1 ——— */
function MessageBubble({ msg }: { msg: ChatMsg }) {
  const isAssistant = msg.role !== 'user';
  const base =
    'max-w-[75%] rounded-2xl border px-3 py-2 text-sm whitespace-pre-wrap break-words ';

  if (msg.kind === 'text') {
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

  if (msg.kind === 'card') {
    const card = msg as CardMsg;
    return (
      <div className="flex">
        <div className="max-w-[75%] rounded-2xl border border-neutral-800 bg-neutral-900/80 px-4 py-3">
          <div className="text-[13px] font-semibold mb-1">{card.title}</div>
          <div className="whitespace-pre-wrap text-sm text-neutral-200">{card.body}</div>
          <div className="mt-3 flex gap-2">
            {['approve', 'edit', 'discard'].map((a) => (
              <button
                key={a}
                disabled
                className="cursor-not-allowed rounded-md border border-neutral-800 bg-neutral-950/60 px-2 py-1 text-[12px] text-neutral-400"
                title="Wired next step"
              >
                {capitalize(a)}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // widget placeholder
  const widget = msg as WidgetMsg;
  return (
    <div className="flex">
      <div className="max-w-[75%] rounded-2xl border border-neutral-800 bg-neutral-900/80 px-4 py-3">
        <div className="text-[13px] font-semibold mb-1">Widget: {widget.widgetType}</div>
        <div className="text-sm text-neutral-300">
          (Widget renderer placeholder — wired in a later step)
        </div>
      </div>
    </div>
  );
}

function capitalize(s: string) {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}
