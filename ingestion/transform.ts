/**
 * Transform raw Teams Graph messages → KB-ready Markdown + metadata sidecar.
 *
 * Reads:  ./raw/messages_*.json
 * Writes: ./processed/<chat>__thread-<NNN>.md
 *         ./processed/<chat>__thread-<NNN>.md.metadata.json   (Bedrock KB sidecar)
 *
 * Grouping unit: thread (root message + all replies). One file per thread.
 */

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RAW_DIR = join(__dirname, 'raw');
const PROCESSED_DIR = join(__dirname, 'processed');

interface Message {
  id: string;
  replyToId?: string | null;
  createdDateTime?: string;
  from?: {
    user?: { id: string; displayName: string } | null;
  } | null;
  body?: { content: string; contentType: 'html' | 'text' };
  attachments?: Array<{ name?: string }>;
  webUrl?: string;
  messageType?: string;
}

interface ChatFile {
  chatId: string;
  topic: string | null;
  chatType: string;
  webUrl?: string;
  messages: Message[];
}

interface Thread {
  root: Message;
  all: Message[];
}

function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function findRoot(byId: Map<string, Message>, msg: Message): Message {
  let cur = msg;
  let depth = 0;
  while (cur.replyToId && byId.has(cur.replyToId) && depth < 50) {
    cur = byId.get(cur.replyToId)!;
    depth += 1;
  }
  return cur;
}

function fmtKoreanDate(iso?: string): string {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function processChat(filePath: string, chatLabel: string): Promise<number> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as ChatFile;

  const messages = raw.messages.filter(
    (m) => m.messageType === 'message' && m.body?.content,
  );

  const byId = new Map<string, Message>();
  for (const m of messages) byId.set(m.id, m);

  const threadMap = new Map<string, Thread>();
  for (const m of messages) {
    const root = findRoot(byId, m);
    const entry = threadMap.get(root.id) ?? { root, all: [] };
    entry.all.push(m);
    threadMap.set(root.id, entry);
  }
  for (const t of threadMap.values()) {
    t.all.sort((a, b) =>
      (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? ''),
    );
  }

  const threads = [...threadMap.values()].sort((a, b) =>
    (a.root.createdDateTime ?? '').localeCompare(b.root.createdDateTime ?? ''),
  );

  for (let i = 0; i < threads.length; i += 1) {
    const t = threads[i];
    const baseName = `${chatLabel}__thread-${String(i + 1).padStart(3, '0')}`;
    const mdPath = join(PROCESSED_DIR, `${baseName}.md`);
    const metaPath = join(PROCESSED_DIR, `${baseName}.md.metadata.json`);

    const participants = [
      ...new Set(
        t.all
          .map((m) => m.from?.user?.displayName)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const dates = t.all
      .map((m) => m.createdDateTime)
      .filter((v): v is string => Boolean(v))
      .sort();
    const topic =
      raw.topic ?? (raw.chatType === 'oneOnOne' ? '1:1 대화' : '그룹 채팅');

    const lines: string[] = [];
    lines.push(`# ${topic} — 스레드 ${i + 1}`);
    lines.push('');
    lines.push(`**채팅 유형**: ${raw.chatType}`);
    lines.push(`**참여자**: ${participants.join(', ')}`);
    lines.push(`**메시지 수**: ${t.all.length}`);
    if (dates.length > 0) {
      lines.push(
        `**기간**: ${fmtKoreanDate(dates[0])} ~ ${fmtKoreanDate(dates[dates.length - 1])}`,
      );
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const m of t.all) {
      const author = m.from?.user?.displayName ?? '(unknown)';
      const ts = fmtKoreanDate(m.createdDateTime);
      const body =
        m.body?.contentType === 'html'
          ? htmlToText(m.body.content)
          : (m.body?.content ?? '');
      const isReply = m.replyToId && m.id !== t.root.id;
      const heading = isReply
        ? `### ↳ ${author} — ${ts}`
        : `## ${author} — ${ts}`;
      lines.push(heading);
      lines.push('');
      lines.push(body);
      if (m.attachments && m.attachments.length > 0) {
        const names = m.attachments
          .map((a) => a.name)
          .filter((v): v is string => Boolean(v));
        if (names.length > 0) {
          lines.push('');
          lines.push(`*(첨부: ${names.join(', ')})*`);
        }
      }
      lines.push('');
    }

    await writeFile(mdPath, lines.join('\n'));

    const metadata = {
      metadataAttributes: {
        chat_id: raw.chatId,
        chat_topic: topic,
        chat_type: raw.chatType,
        thread_id: t.root.id,
        thread_root_url: t.root.webUrl ?? raw.webUrl ?? '',
        participants,
        message_count: t.all.length,
        date_start: dates[0] ?? '',
        date_end: dates[dates.length - 1] ?? '',
      },
    };
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  }

  return threads.length;
}

async function main(): Promise<void> {
  await rm(PROCESSED_DIR, { recursive: true, force: true });
  await mkdir(PROCESSED_DIR, { recursive: true });

  const files = (await readdir(RAW_DIR))
    .filter((f) => f.startsWith('messages_') && f.endsWith('.json'))
    .sort();

  console.log(`Found ${files.length} message file(s):\n`);

  let total = 0;
  for (const f of files) {
    const chatLabel = basename(f).replace(/^messages_/, '').replace(/\.json$/, '');
    process.stdout.write(`  ${f} ... `);
    const n = await processChat(join(RAW_DIR, f), chatLabel);
    total += n;
    console.log(`${n} thread(s)`);
  }

  console.log(`\n✅ ${total} thread chunks written to processed/`);
}

main().catch((err) => {
  console.error('❌ Fatal:', (err as Error).message);
  process.exit(1);
});
