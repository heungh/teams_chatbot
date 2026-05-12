/**
 * Microsoft Graph로부터 본인 채팅 메타데이터와 메시지를 수집해
 * ./raw/ 디렉토리에 JSON으로 저장한다.
 *
 * 사용:
 *   export GRAPH_TOKEN="<teams.microsoft.com 세션의 graph.microsoft.com 토큰>"
 *   npm run fetch -- --list-only           # 채팅 목록만
 *   CHAT_IDS="19:abc...,19:def..." npm run fetch
 *   npm run fetch                          # 모든 채팅 (시간 오래 걸림)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadDotenv(join(__dirname, '.env'));

const TOKEN = process.env.GRAPH_TOKEN?.trim();
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const RAW_DIR = join(__dirname, 'raw');
const LIST_ONLY = process.argv.includes('--list-only');
const CHAT_ID_FILTER = process.env.CHAT_IDS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error('❌ GRAPH_TOKEN environment variable is required.');
  console.error('   See docs/01b-browser-token-method.md');
  process.exit(1);
}

interface Page<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface Me {
  id: string;
  displayName: string;
  mail?: string | null;
  userPrincipalName?: string;
}

interface Chat {
  id: string;
  topic: string | null;
  chatType: 'oneOnOne' | 'group' | 'meeting' | string;
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  webUrl?: string;
}

interface Message {
  id: string;
  replyToId?: string | null;
  createdDateTime?: string;
  from?: {
    user?: { id: string; displayName: string } | null;
    application?: { displayName: string } | null;
  } | null;
  body?: { content: string; contentType: 'html' | 'text' };
  attachments?: unknown[];
  mentions?: unknown[];
  webUrl?: string;
  messageType?: string;
  [key: string]: unknown;
}

async function graphGet<T>(url: string, attempt = 1): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '5');
    console.warn(`   ⚠️  429 throttled, sleeping ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    if (attempt < 5) return graphGet<T>(url, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph ${res.status} ${res.statusText} for ${url}\n${body.slice(0, 800)}`);
  }
  return res.json() as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function fetchAllPages<T>(initialUrl: string): Promise<T[]> {
  let url: string | undefined = initialUrl;
  const out: T[] = [];
  let page = 0;
  while (url) {
    page += 1;
    process.stdout.write(`   page ${page}... `);
    const data = await graphGet<Page<T>>(url);
    out.push(...data.value);
    process.stdout.write(`+${data.value.length}\n`);
    url = data['@odata.nextLink'];
  }
  return out;
}

function safeFileLabel(chat: Chat, fallbackIdx: number): string {
  const base =
    chat.topic?.trim() ||
    `${chat.chatType}_${chat.id.replace(/[^a-zA-Z0-9]/g, '').slice(3, 15)}` ||
    `chat_${fallbackIdx}`;
  return base.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
}

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });

  console.log('1) /me');
  const me = await graphGet<Me>(`${GRAPH_BASE}/me`);
  console.log(`   ${me.displayName} (${me.mail ?? me.userPrincipalName ?? me.id})`);
  await writeFile(join(RAW_DIR, 'me.json'), JSON.stringify(me, null, 2));

  console.log('2) chat list');
  const chats = await fetchAllPages<Chat>(`${GRAPH_BASE}/me/chats?$top=50`);
  console.log(`   ${chats.length} chats total`);
  await writeFile(join(RAW_DIR, 'chats.json'), JSON.stringify(chats, null, 2));
  console.log(`   → ${join(RAW_DIR, 'chats.json')}`);

  if (LIST_ONLY) {
    console.log('3) (--list-only) skipping message fetch');
    printChatPreview(chats);
    return;
  }

  const targetChats = CHAT_ID_FILTER
    ? chats.filter((c) => CHAT_ID_FILTER.includes(c.id))
    : chats;

  if (CHAT_ID_FILTER && targetChats.length === 0) {
    console.error('❌ CHAT_IDS 에 매칭되는 채팅이 없습니다. chats.json 의 id를 확인하세요.');
    process.exit(1);
  }

  console.log(`3) fetching messages for ${targetChats.length} chat(s)`);
  for (let i = 0; i < targetChats.length; i += 1) {
    const chat = targetChats[i];
    const label = safeFileLabel(chat, i);
    const outFile = join(RAW_DIR, `messages_${label}.json`);
    console.log(`   - [${i + 1}/${targetChats.length}] "${chat.topic ?? '(no topic)'}" (${chat.chatType})`);
    try {
      const messages = await fetchAllPages<Message>(
        `${GRAPH_BASE}/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50`,
      );
      await writeFile(
        outFile,
        JSON.stringify(
          {
            chatId: chat.id,
            topic: chat.topic,
            chatType: chat.chatType,
            webUrl: chat.webUrl,
            fetchedAt: new Date().toISOString(),
            messageCount: messages.length,
            messages,
          },
          null,
          2,
        ),
      );
      console.log(`     → ${outFile} (${messages.length} messages)`);
    } catch (err) {
      console.error(`     ✗ failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log('done.');
}

function printChatPreview(chats: Chat[]): void {
  const groups = chats.filter((c) => c.chatType === 'group').slice(0, 10);
  const oneOnOnes = chats.filter((c) => c.chatType === 'oneOnOne').slice(0, 5);
  console.log('\n   sample group chats (up to 10):');
  for (const c of groups) {
    console.log(`     "${c.topic ?? '(no topic)'}"  ${c.id}`);
  }
  console.log('\n   sample 1:1 chats (up to 5):');
  for (const c of oneOnOnes) {
    console.log(`     ${c.id}  (last: ${c.lastUpdatedDateTime ?? '?'})`);
  }
  console.log('\n   다음 명령으로 원하는 채팅만 수집:');
  console.log('     CHAT_IDS="19:xxx...,19:yyy..." npm run fetch');
}

main().catch((err) => {
  console.error('\n❌ Fatal:', (err as Error).message);
  process.exit(1);
});
