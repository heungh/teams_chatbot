export interface Citation {
  /** 답변의 어느 부분에 대한 인용인지 */
  span?: { start: number; end: number };
  /** 인용한 chunk 본문 (잘라낸 일부) */
  excerpt: string;
  /** 메타데이터 from sidecar JSON */
  chatTopic?: string;
  chatType?: string;
  participants?: string[];
  threadId?: string;
  /** Teams 원본 메시지로 가는 deep link */
  threadUrl?: string;
  /** S3 소스 경로 (디버깅용) */
  sourceUri?: string;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  sessionId: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}
