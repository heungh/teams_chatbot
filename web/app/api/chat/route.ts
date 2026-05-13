import { NextResponse } from 'next/server';
import { ragQuery } from '@/lib/rag';
import type { ChatResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  message?: string;
  sessionId?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  try {
    const result = await ragQuery(message, body.sessionId);
    const payload: ChatResponse = {
      answer: result.answer,
      citations: result.citations,
      sessionId: result.sessionId,
    };
    return NextResponse.json(payload);
  } catch (err) {
    const e = err as Error & {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    console.error('Bedrock error:', e.name, e.message);
    return NextResponse.json(
      {
        error: e.message,
        name: e.name,
        httpStatusCode: e.$metadata?.httpStatusCode,
      },
      { status: 500 },
    );
  }
}
