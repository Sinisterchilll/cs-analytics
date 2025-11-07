import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
// Load .env.local if present (Next.js style), else fallback to .env
const localEnvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else {
  dotenv.config();
}
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) as string | undefined;
const SUPABASE_SERVICE_ROLE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) as string | undefined;
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY) as string | undefined;

if (!SUPABASE_URL || (!SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_ANON_KEY)) {
  // eslint-disable-next-line no-console
  console.error('Missing Supabase envs: need URL and either SERVICE_ROLE_KEY or ANON_KEY (supports NEXT_PUBLIC_* or server-only names).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY!, {
  auth: { persistSession: false },
});

const VERBOSE_LOG = String(process.env.VERBOSE_LOG || '') === '1';
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 2);

const FRESHCHAT_TOKEN = process.env.FRESHCHAT_TOKEN as string | undefined;
const FRESHCHAT_DOMAIN = process.env.FRESHCHAT_DOMAIN as string | undefined;

if (!FRESHCHAT_TOKEN || !FRESHCHAT_DOMAIN) {
  // eslint-disable-next-line no-console
  console.error('Missing FRESHCHAT_TOKEN or FRESHCHAT_DOMAIN in environment.');
  process.exit(1);
}

const api = axios.create({
  baseURL: `https://${FRESHCHAT_DOMAIN}/v2`,
  headers: {
    Authorization: `Bearer ${FRESHCHAT_TOKEN}`,
    Accept: 'application/json',
  },
  timeout: 30000,
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(path: string, params: Record<string, any> = {}, attempt = 1): Promise<any> {
  try {
    const response = await api.get(path, { params });
    return response.data;
  } catch (err: any) {
    const status = err?.response?.status as number | undefined;
    if (status === 429 && attempt < 4) {
      const backoff = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      // eslint-disable-next-line no-console
      console.warn(`429 received. Backing off ${backoff}ms (attempt ${attempt}) for ${path}`);
      await sleep(backoff);
      return fetchWithRetry(path, params, attempt + 1);
    }
    // eslint-disable-next-line no-console
    console.error(`GET ${path} failed`, status, err?.message);
    throw err;
  }
}

function toISOStringNoMs(date: Date | string | number) {
  return new Date(date).toISOString();
}

async function paginate(path: string, params: Record<string, any>, itemsKey: string): Promise<any[]> {
  let page = (params.page as number) || 1;
  const pageSize = (params.items_per_page as number) || 10;
  const items: any[] = [];
  const seenFirstIds = new Set<string>();
  let safety = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await fetchWithRetry(path, { ...params, page });
    const pageItems = Array.isArray((data as any)?.[itemsKey])
      ? (data as any)[itemsKey]
      : Array.isArray(data)
      ? (data as any)
      : [];
    if (!pageItems.length) break;
    const beforeLen = items.length;
    items.push(...pageItems);
    // Dedup safety: if API ignores page and repeats, break to avoid infinite loop
    const firstId = (pageItems[0] && (pageItems[0].id || pageItems[0].uuid)) as string | undefined;
    if (firstId) {
      if (seenFirstIds.has(firstId)) {
        if (VERBOSE_LOG) console.warn(`[Paginate] Detected repeating firstId on ${path} page=${page}, stopping.`);
        break;
      }
      seenFirstIds.add(firstId);
    }
    if (pageItems.length < pageSize) break; // last page
    if (items.length === beforeLen) break; // nothing new
    page += 1;
    safety += 1;
    if (safety > 200) { // hard stop to avoid runaway
      if (VERBOSE_LOG) console.warn(`[Paginate] Safety stop on ${path}`);
      break;
    }
    await sleep(500);
  }
  return items;
}

async function upsertUser(user: any) {
  const row = {
    id: user.id,
    phone_no: user.phone || user.phone_number || '',
    created_time: new Date(user.created_time || user.created_at || Date.now()).toISOString(),
  };
  const { error } = await supabase.from('User').upsert(row, { onConflict: 'id' });
  if (error) {
    if (VERBOSE_LOG) console.error('[Supabase] upsert User error:', error);
    throw error;
  }
}

async function upsertConversation(convo: any, overrideId?: string) {
  const row = {
    id: overrideId || convo.id || convo.uuid || '',
    userid: convo.userId || (convo?.users?.[0]?.id) || convo?.user_id || '',
    status: convo.status || '',
    channel_id: convo.channel_id || '',
    created_time: new Date(convo.created_time || convo.created_at || Date.now()).toISOString(),
    updated_time: new Date(convo.updated_time || convo.updated_at || convo.created_time || Date.now()).toISOString(),
    assigned_to: (convo?.assigned_to?.id || convo?.assigned_to || '') + '',
    custom_properties: convo.custom_properties || {},
  };
  const { error } = await supabase.from('Conversation').upsert(row, { onConflict: 'id' });
  if (error) {
    if (VERBOSE_LOG) console.error('[Supabase] upsert Conversation error:', error);
    throw error;
  }
}

/**
 * Extracts clean text content from Freshchat message_parts.
 * Handles nested structures like [{"text": {"content": "..."}}] and returns plain text.
 */
function extractMessageContent(parts: any): string {
  if (!parts) return '';
  
  // Handle array of parts
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      // Common structure: {"text": {"content": "actual message"}}
      if (part?.text?.content) {
        texts.push(String(part.text.content).trim());
      }
      // Fallback: {"content": "..."}
      else if (part?.content) {
        texts.push(String(part.content).trim());
      }
      // Direct text: {"text": "..."}
      else if (part?.text && typeof part.text === 'string') {
        texts.push(String(part.text).trim());
      }
      // Plain string in array
      else if (typeof part === 'string') {
        texts.push(part.trim());
      }
    }
    return texts.filter(t => t.length > 0).join(' ');
  }
  
  // Handle single object
  if (typeof parts === 'object') {
    if (parts?.text?.content) return String(parts.text.content).trim();
    if (parts?.content) return String(parts.content).trim();
    if (parts?.text && typeof parts.text === 'string') return String(parts.text).trim();
  }
  
  // Fallback to string conversion
  return String(parts).trim();
}

async function upsertMessage(msg: any, conversationId: string) {
  // Extract clean text content from message_parts
  const cleanContent = extractMessageContent(msg.message_parts || msg.parts);
  
  const row = {
    id: msg.id || msg.uuid || `${conversationId}-${new Date(msg.created_time || msg.created_at || Date.now()).toISOString()}`,
    conversationid: conversationId,
    actor_type: msg.actor_type || '',
    message_parts: cleanContent, // Store cleaned text instead of raw JSON
    created_time: new Date(msg.created_time || msg.created_at || Date.now()).toISOString(),
    rating: msg.rating ?? null,
  };
  const { error } = await supabase.from('Message').upsert(row, { onConflict: 'id' });
  if (error) {
    if (VERBOSE_LOG) console.error('[Supabase] upsert Message error:', error);
    throw error;
  }
}


async function fetchUserConversations(userId: string) {
  const conversations = await paginate(`/users/${userId}/conversations`, { items_per_page: 20, page: 1 }, 'conversations');
  return conversations;
}

async function fetchConversation(conversationId: string) {
  const data = await fetchWithRetry(`/conversations/${conversationId}`);
  return data;
}

// Note: Freshchat public docs do not expose a global conversations list; use per-user listing.

async function fetchConversationMessages(conversationId: string, fromISO: string) {
  const msgs = await paginate(`/conversations/${conversationId}/messages`, {
    from_time: fromISO,
    items_per_page: 50,
    page: 1,
  }, 'messages');
  return msgs;
}

function isWithinWindow(isoString: string, windowStart: Date, now: Date) {
  const t = new Date(isoString).getTime();
  return t >= windowStart.getTime() && t <= now.getTime();
}


async function fetchAndStore() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const windowStartISO = toISOStringNoMs(windowStart);
  const nowISO = toISOStringNoMs(now);

  // eslint-disable-next-line no-console
  console.log(`[Fetch] Starting window ${windowStart.toISOString()} -> ${now.toISOString()}`);

  // Per docs: fetch users updated in window, then their conversations
  const users = await paginate('/users', {
    updated_from: windowStartISO,
    updated_to: nowISO,
    items_per_page: 100,
    page: 1
  }, 'users');
  console.log(`[Fetch] Users updated in last ${LOOKBACK_HOURS}h: ${users.length}`);

  let usersUpserted = 0;
  let convsUpserted = 0;
  let msgsUpserted = 0;
  let convsSkippedNotInWindow = 0;
  let convsSkippedNoBot = 0;

  let userIndex = 0;
  for (const user of users) {
    userIndex += 1;
    try {
      if (VERBOSE_LOG) console.log(`[Fetch] User ${userIndex}/${users.length}: upserting ${user.id}`);
      await upsertUser(user);
      usersUpserted += 1;

      const userConversations = await fetchUserConversations(user.id);
      if (VERBOSE_LOG) console.log(`[Fetch] User ${user.id} conversations fetched: ${userConversations.length}`);
      for (const uc of userConversations) {
        try {
          const convoDetail = await fetchConversation(uc.id);
          const convoId = convoDetail.id || uc.id || convoDetail.uuid || uc.uuid;
          if (!convoId) {
            if (VERBOSE_LOG) console.warn('[Fetch] Skipping conversation without id for user', user.id);
            await sleep(200);
            continue;
          }
          const createdIso = convoDetail.created_time || convoDetail.created_at || uc.created_time || uc.created_at;
          const updatedIso = convoDetail.updated_time || convoDetail.updated_at || uc.updated_time || uc.updated_at || createdIso;
          const createdInWindow = !!createdIso && isWithinWindow(createdIso, windowStart, now);
          const updatedInWindow = !!updatedIso && isWithinWindow(updatedIso, windowStart, now);
          if (!createdInWindow && !updatedInWindow) {
            convsSkippedNotInWindow += 1;
            await sleep(1000);
            continue;
          }

          await upsertConversation({ ...convoDetail, userId: user.id }, convoId);
          convsUpserted += 1;

          const messages = await fetchConversationMessages(convoId, windowStartISO);
          if (VERBOSE_LOG) console.log(`[Fetch] Conversation ${convoId} messages fetched: ${messages.length}`);
          
          // Filter out system messages (not needed for analytics)
          const nonSystemMessages = messages.filter((m: any) => {
            const actorType = (m.actor_type || '').toUpperCase();
            return actorType !== 'SYSTEM';
          });
          
          const botMessages = nonSystemMessages.filter((m: any) => (m.actor_type || '').toUpperCase() === 'BOT');
          if (botMessages.length === 0 && !((convoDetail?.assigned_to?.type || '').toUpperCase() === 'BOT')) {
            convsSkippedNoBot += 1;
            await sleep(300);
            continue; // skip non-bot conversations per requirement
          }

          for (const m of nonSystemMessages) {
            await upsertMessage(m, convoId);
            msgsUpserted += 1;
          }
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.error(`[Fetch] Conversation processing failed for user ${user.id}`, e?.message);
        }
        await sleep(300);
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[Fetch] User processing failed for ${user.id}`, e?.message);
    }
    await sleep(300);
  }

  // eslint-disable-next-line no-console
  console.log('[Fetch] Completed. Summary:', {
    usersUpserted,
    convsUpserted,
    msgsUpserted,
    convsSkippedNotInWindow,
    convsSkippedNoBot,
  });
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('=== Fetch Cycle Start ===');
  try {
    await fetchAndStore();
    // eslint-disable-next-line no-console
    console.log('=== Fetch Cycle Complete ===');
    process.exit(0);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('Fetch cycle failed:', e?.message);
    process.exit(1);
  }
}

// Run once and exit
main();


