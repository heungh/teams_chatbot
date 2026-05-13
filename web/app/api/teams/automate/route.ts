/**
 * Microsoft Power Automate Workflow endpoint for Teams chatbot.
 *
 * Designed for the MS-recommended replacement for retired Outgoing Webhooks.
 *
 * Trigger flow:
 *   Teams @mention → Power Automate Workflow → HTTP POST here → RAG → response
 *   → Workflow posts answer back to channel.
 *
 * Auth: simple shared-secret header `X-Workflow-Secret` (matches SSM SecureString
 * /teams-bedrock-chatbot/automate-secret). No HMAC; Workflow's own M365 identity
 * protects the trigger side.
 *
 * Request:  POST { "message": "<text from @mention>" }
 * Response: { "markdown": "<ready-to-post>", "answer": "...", "citations": [...] }
 */

import { NextResponse } from 'next/server';
import { ragQuery, dedupeCitations } from '@/lib/rag';
import { loadConfig } from '@/lib/config';
import type { Citation } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  message?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = await getAutomateSecret();
  if (!secret) {
    return NextResponse.json(
      { error: 'AUTOMATE_SECRET not configured (env or SSM)' },
      { status: 503 },
    );
  }

  const provided = req.headers.get('x-workflow-secret') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const message = stripMentionsAndTags(body.message ?? '');
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  try {
    const result = await ragQuery(message);
    const top = dedupeCitations(result.citations, 3);
    return NextResponse.json({
      markdown: formatMarkdown(result.answer, top),
      answer: result.answer,
      citations: top,
      sessionId: result.sessionId,
    });
  } catch (err) {
    const e = err as Error;
    console.error('automate RAG error:', e.name, e.message);
    return NextResponse.json(
      { error: e.message, markdown: `⚠️ 답변 생성 오류: ${e.message}` },
      { status: 500 },
    );
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function stripMentionsAndTags(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^@\S+\s*/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function formatMarkdown(answer: string, citations: Citation[]): string {
  const lines: string[] = [answer.trim()];
  if (citations.length > 0) {
    lines.push('', `**📎 출처 ${citations.length}개**`);
    for (const c of citations) {
      const topic = c.chatTopic ?? '(주제 없음)';
      const who = c.participants && c.participants.length > 0
        ? ` — ${c.participants.slice(0, 2).join(', ')}`
        : '';
      const text = `${topic}${who}`;
      lines.push(c.threadUrl ? `- [${text}](${c.threadUrl})` : `- ${text}`);
    }
  }
  return lines.join('\n');
}

async function getAutomateSecret(): Promise<string | undefined> {
  const envSecret = process.env.AUTOMATE_SECRET?.trim();
  if (envSecret) return envSecret;

  try {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const cfg = await loadConfig();
    const ssm = new SSMClient({ region: cfg.region });
    const result = await ssm.send(
      new GetParameterCommand({
        Name: '/teams-bedrock-chatbot/automate-secret',
        WithDecryption: true,
      }),
    );
    return result.Parameter?.Value;
  } catch (err) {
    console.warn(`SSM automate secret lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}
