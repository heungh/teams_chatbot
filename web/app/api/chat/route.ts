import { NextResponse } from 'next/server';
import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { loadConfig, resolveModelArn } from '@/lib/config';
import type { Citation, ChatResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  message?: string;
  sessionId?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

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

  let modelArn: string;
  try {
    modelArn = resolveModelArn(config);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const client = new BedrockAgentRuntimeClient({ region: config.region });

  try {
    const command = new RetrieveAndGenerateCommand({
      input: { text: message },
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: config.kbId,
          modelArn,
          generationConfiguration: {
            inferenceConfig: {
              textInferenceConfig: {
                temperature: 0.2,
                maxTokens: 1024,
              },
            },
          },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: 5,
            },
          },
        },
      },
    });

    const result = await client.send(command);

    const citations: Citation[] = [];
    for (const c of result.citations ?? []) {
      const span = c.generatedResponsePart?.textResponsePart?.span;
      for (const ref of c.retrievedReferences ?? []) {
        const md = (ref.metadata ?? {}) as Record<string, unknown>;
        citations.push({
          span:
            span?.start != null && span.end != null
              ? { start: span.start, end: span.end }
              : undefined,
          excerpt: (ref.content?.text ?? '').slice(0, 300),
          chatTopic: typeof md.chat_topic === 'string' ? md.chat_topic : undefined,
          chatType: typeof md.chat_type === 'string' ? md.chat_type : undefined,
          participants: Array.isArray(md.participants)
            ? (md.participants as string[])
            : undefined,
          threadId: typeof md.thread_id === 'string' ? md.thread_id : undefined,
          threadUrl:
            typeof md.thread_root_url === 'string' ? md.thread_root_url : undefined,
          sourceUri: ref.location?.s3Location?.uri,
        });
      }
    }

    const payload: ChatResponse = {
      answer: result.output?.text ?? '',
      citations,
      sessionId: result.sessionId ?? '',
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
