/**
 * Shared RAG (Retrieve and Generate) logic.
 * Used by both /api/chat (web UI) and /api/teams/webhook (Teams outgoing webhook).
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { loadConfig, resolveModelArn } from './config';
import type { Citation } from './types';

export interface RagResult {
  answer: string;
  citations: Citation[];
  sessionId: string;
}

export async function ragQuery(
  message: string,
  sessionId?: string,
): Promise<RagResult> {
  const config = await loadConfig();
  const modelArn = resolveModelArn(config);
  const client = new BedrockAgentRuntimeClient({ region: config.region });

  const result = await client.send(
    new RetrieveAndGenerateCommand({
      input: { text: message },
      ...(sessionId ? { sessionId } : {}),
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
    }),
  );

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

  return {
    answer: result.output?.text ?? '',
    citations,
    sessionId: result.sessionId ?? '',
  };
}

/** Deduplicate citations by thread (or fallback key). */
export function dedupeCitations(citations: Citation[], max = 3): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = c.threadId ?? c.sourceUri ?? c.excerpt.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
