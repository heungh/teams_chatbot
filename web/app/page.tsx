'use client';

import { useState, useRef, useEffect, FormEvent } from 'react';
import type { ChatMessage, Citation, ChatResponse } from '@/lib/types';

const SAMPLE_QUESTIONS = [
  'Phoenix 프로젝트 DB는 뭘 쓰기로 했어?',
  'Phoenix 릴리즈 일정 알려줘',
  '고객사 A의 Bedrock 비용은 어떻게 줄였어?',
  'SAA 자격증 준비 기간 추천은?',
  'Bedrock 워크숍 일정과 내용은?',
];

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, loading]);

  async function send(question: string) {
    if (!question.trim() || loading) return;
    setError(null);

    const userMsg: ChatMessage = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, sessionId }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as ChatResponse;
      setSessionId(data.sessionId || undefined);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.answer, citations: data.citations },
      ]);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `(오류) ${msg}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    send(input);
  }

  function newSession() {
    setMessages([]);
    setSessionId(undefined);
    setError(null);
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Teams Chat 챗봇</h1>
          <p className="text-xs text-slate-500">
            Bedrock Knowledge Base × Microsoft Teams 대화 이력
          </p>
        </div>
        <button
          type="button"
          onClick={newSession}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          새 대화
        </button>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
      >
        {messages.length === 0 && (
          <div className="space-y-3 py-8 text-center text-slate-500">
            <p>아래 샘플 질문을 클릭하거나 직접 입력하세요</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  className="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {messages.map((m, i) => (
            <MessageRow key={i} message={m} />
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-slate-400" />
              생각하는 중...
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="질문을 입력하세요"
          disabled={loading}
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-slate-300"
        >
          보내기
        </button>
      </form>

      <p className="mt-2 text-center text-[10px] text-slate-400">
        sessionId: {sessionId ?? '(없음 — 첫 메시지부터 새 대화)'}
      </p>
    </main>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-2 text-sm ${
          isUser
            ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900'
            : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
        }`}
      >
        <div className="whitespace-pre-wrap">{message.content}</div>
        {!isUser && message.citations && message.citations.length > 0 && (
          <Citations citations={message.citations} />
        )}
      </div>
    </div>
  );
}

function Citations({ citations }: { citations: Citation[] }) {
  const unique = dedupeByThread(citations);
  return (
    <details className="mt-3 border-t border-slate-300/40 pt-2 text-xs">
      <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
        출처 {unique.length}개
      </summary>
      <ul className="mt-2 space-y-2">
        {unique.map((c, i) => (
          <li key={i} className="rounded border border-slate-300/40 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {c.chatTopic ?? '(주제 없음)'}
                {c.chatType ? ` · ${c.chatType}` : ''}
              </span>
              {c.threadUrl && (
                <a
                  href={c.threadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-blue-600 hover:underline dark:text-blue-400"
                >
                  Teams에서 열기 ↗
                </a>
              )}
            </div>
            {c.participants && c.participants.length > 0 && (
              <div className="mt-1 text-[11px] text-slate-500">
                참여자: {c.participants.join(', ')}
              </div>
            )}
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              {c.excerpt}
              {c.excerpt.length >= 300 ? '…' : ''}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function dedupeByThread(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = c.threadId ?? c.sourceUri ?? c.excerpt.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
