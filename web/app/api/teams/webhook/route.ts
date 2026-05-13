/**
 * Microsoft Teams Outgoing Webhook endpoint.
 *
 * Flow:
 *   1. Teams posts user message here when someone @mentions the webhook in a channel.
 *   2. Verify HMAC signature with shared secret (env: TEAMS_WEBHOOK_SECRET).
 *   3. Strip <at>BotName</at> from message text.
 *   4. Call shared RAG, format Markdown response, return Bot Framework Activity.
 *
 * Teams response timeout: ~5 seconds. Long Bedrock generations may time out.
 * For production use, switch to Bot Framework + Azure Bot Service (option C).
 */

import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ragQuery, dedupeCitations } from '@/lib/rag';
import { loadConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10; // Teams aborts at ~5s but allow a bit more

interface TeamsActivity {
  type?: string;
  text?: string;
  from?: { name?: string; id?: string };
  conversation?: { id?: string };
}

interface TeamsResponse {
  type: 'message';
  text: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  // Read raw body — HMAC must be computed over exact bytes
  const rawBody = await req.text();

  const secret = await getWebhookSecret();
  if (!secret) {
    console.error('TEAMS_WEBHOOK_SECRET not configured');
    return new NextResponse('Webhook not configured', { status: 503 });
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (!verifyHmac(rawBody, authHeader, secret)) {
    console.warn('Teams webhook: HMAC verification failed');
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let activity: TeamsActivity;
  try {
    activity = JSON.parse(rawBody) as TeamsActivity;
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  if (activity.type && activity.type !== 'message') {
    // Non-message events (e.g. typing, deleteUserData) — just acknowledge
    return NextResponse.json({ type: 'message', text: '' });
  }

  const question = extractQuestion(activity.text ?? '');
  if (!question) {
    return NextResponse.json<TeamsResponse>({
      type: 'message',
      text: '질문 내용이 비어 있습니다. 예: `@AskBot Phoenix DB 뭐 쓰기로 했어?`',
    });
  }

  try {
    const result = await ragQuery(question);
    return NextResponse.json<TeamsResponse>({
      type: 'message',
      text: formatTeamsMarkdown(result.answer, result.citations),
    });
  } catch (err) {
    const e = err as Error;
    console.error('Teams webhook RAG error:', e.name, e.message);
    return NextResponse.json<TeamsResponse>({
      type: 'message',
      text: `⚠️ 답변 생성 중 오류가 발생했습니다.\n\n_${e.message}_`,
    });
  }
}

/**
 * Teams Outgoing Webhook signs each request as:
 *   Authorization: HMAC <base64-sha256(body, secret-decoded-from-base64)>
 */
function verifyHmac(body: string, authHeader: string, secret: string): boolean {
  if (!authHeader.startsWith('HMAC ')) return false;
  const provided = authHeader.slice(5).trim();

  const secretBytes = Buffer.from(secret, 'base64');
  const computed = createHmac('sha256', secretBytes)
    .update(body, 'utf8')
    .digest('base64');

  const a = Buffer.from(computed);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractQuestion(text: string): string {
  // Strip <at>BotName</at> and stray HTML
  return text
    .replace(/<at>[^<]*<\/at>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function formatTeamsMarkdown(answer: string, citations: Parameters<typeof dedupeCitations>[0]): string {
  const top = dedupeCitations(citations, 3);
  const lines: string[] = [answer.trim()];
  if (top.length > 0) {
    lines.push('');
    lines.push(`**📎 출처 ${top.length}개**`);
    for (const c of top) {
      const topic = c.chatTopic ?? '(주제 없음)';
      const who = c.participants && c.participants.length > 0
        ? ` — ${c.participants.slice(0, 3).join(', ')}`
        : '';
      const link = c.threadUrl
        ? `[${topic}${who}](${c.threadUrl})`
        : `${topic}${who}`;
      lines.push(`- ${link}`);
    }
  }
  return lines.join('\n');
}

async function getWebhookSecret(): Promise<string | undefined> {
  // Env override first
  const envSecret = process.env.TEAMS_WEBHOOK_SECRET?.trim();
  if (envSecret) return envSecret;

  // Fall back to SSM SecureString /teams-bedrock-chatbot/teams-webhook-secret
  try {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const cfg = await loadConfig();
    const ssm = new SSMClient({ region: cfg.region });
    const result = await ssm.send(
      new GetParameterCommand({
        Name: '/teams-bedrock-chatbot/teams-webhook-secret',
        WithDecryption: true,
      }),
    );
    return result.Parameter?.Value;
  } catch (err) {
    console.warn(`SSM webhook secret lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}
