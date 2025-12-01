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
import { prisma } from './lib/prisma';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}

const FRESHCHAT_TOKEN = process.env.FRESHCHAT_TOKEN;
const FRESHCHAT_DOMAIN = process.env.FRESHCHAT_DOMAIN;

if (!FRESHCHAT_TOKEN || !FRESHCHAT_DOMAIN) {
  console.error('Missing FRESHCHAT_TOKEN or FRESHCHAT_DOMAIN');
  process.exit(1);
}

const VERBOSE_LOG = String(process.env.VERBOSE_LOG || '') === '1';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50); // Process conversations in batches
const RATE_LIMIT_DELAY = Number(process.env.RATE_LIMIT_DELAY || 1000); // 1 second between API calls
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 5000); // 5 seconds between batches

interface Conversation {
  id: string;
  created_time: string;
}

interface Message {
  id: string;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(path: string, params: Record<string, any> = {}, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = `https://${FRESHCHAT_DOMAIN}/v2/${path}`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${FRESHCHAT_TOKEN}` },
        params,
        timeout: 30000,
      });
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 429 && attempt < retries) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(`[Freshchat] Rate limited, retrying in ${backoff}ms (attempt ${attempt}/${retries})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

async function paginate(path: string, params: Record<string, any>, itemsKey: string): Promise<any[]> {
  let page = (params.page as number) || 1;
  const pageSize = (params.items_per_page as number) || 50;
  const items: any[] = [];
  const seenFirstIds = new Set<string>();
  let safety = 0;

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

async function upsertMessage(msg: any, conversationId: string): Promise<boolean> {
  try {
    // Filter out system messages
    if (msg.actor_type === 'system') {
      return false;
    }

    // Extract clean text content from message_parts
    const cleanContent = extractMessageContent(msg.message_parts || msg.parts);
    
    const row = {
      id: msg.id || msg.uuid || `${conversationId}-${new Date(msg.created_time || msg.created_at || Date.now()).toISOString()}`,
      conversationId: conversationId,
      actor_type: msg.actor_type || '',
      message_parts: cleanContent,
      created_time: new Date(msg.created_time || msg.created_at || Date.now()),
      rating: msg.rating ?? null,
    };

    await prisma.message.upsert({
      where: { id: row.id },
      update: row,
      create: row,
    });
    return true;
  } catch (err: any) {
    if (VERBOSE_LOG) console.error('[upsertMessage] error:', err?.message);
    return false;
  }
}

async function getExistingMessageIds(conversationId: string): Promise<Set<string>> {
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId: conversationId },
      select: { id: true },
    });
    
    return new Set(messages.map((m) => m.id));
  } catch (err: any) {
    console.error(`[getExistingMessageIds] error:`, err?.message);
    return new Set();
  }
}

async function backfillConversationMessages(conversation: Conversation, stats: BackfillStats) {
  const convId = conversation.id;
  const convCreatedTime = new Date(conversation.created_time);
  
  try {
    // Get existing message IDs for this conversation
    const existingMessageIds = await getExistingMessageIds(convId);
    
    if (VERBOSE_LOG) {
      console.log(`[Backfill] Processing conversation ${convId} (existing messages: ${existingMessageIds.size})`);
    }
    
    // Fetch all messages for this conversation from Freshchat
    // Use conversation created_time as starting point
    const messages = await paginate(
      `conversations/${convId}/messages`,
      {
        items_per_page: 50,
      },
      'messages'
    );
    
    await sleep(RATE_LIMIT_DELAY); // Rate limiting
    
    let newMessages = 0;
    let skippedMessages = 0;
    
    for (const msg of messages) {
      const messageId = msg.id || msg.uuid;
      
      // Skip if message already exists
      if (existingMessageIds.has(messageId)) {
        skippedMessages++;
        continue;
      }
      
      // Upsert new message
      const success = await upsertMessage(msg, convId);
      if (success) {
        newMessages++;
        stats.totalMessagesInserted++;
      } else {
        stats.totalMessagesFailed++;
      }
    }
    
    stats.conversationsProcessed++;
    
    console.log(`[Backfill] ✓ Conversation ${convId}: ${newMessages} new, ${skippedMessages} skipped, ${messages.length} total`);
    
  } catch (err: any) {
    console.error(`[Backfill] ✗ Failed to process conversation ${convId}:`, err?.message);
    stats.conversationsFailed++;
  }
}

interface BackfillStats {
  totalConversations: number;
  conversationsProcessed: number;
  conversationsFailed: number;
  totalMessagesInserted: number;
  totalMessagesFailed: number;
}

async function backfillAllMessages() {
  const startTime = Date.now();
  console.log('=== Backfill Messages - Start ===');
  console.log(`Configuration: BATCH_SIZE=${BATCH_SIZE}, RATE_LIMIT_DELAY=${RATE_LIMIT_DELAY}ms, BATCH_DELAY=${BATCH_DELAY}ms`);
  
  const stats: BackfillStats = {
    totalConversations: 0,
    conversationsProcessed: 0,
    conversationsFailed: 0,
    totalMessagesInserted: 0,
    totalMessagesFailed: 0,
  };
  
  try {
    // Fetch all conversations from database
    console.log('[Backfill] Fetching all conversations from database...');
    const conversations = await prisma.conversation.findMany({
      select: {
        id: true,
        created_time: true,
      },
      orderBy: { created_time: 'asc' }, // Process oldest first
    });
    
    if (!conversations || conversations.length === 0) {
      console.log('[Backfill] No conversations found in database.');
      return;
    }
    
    stats.totalConversations = conversations.length;
    console.log(`[Backfill] Found ${stats.totalConversations} conversations to process`);
    
    // Process conversations in batches
    for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
      const batch = conversations.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(conversations.length / BATCH_SIZE);
      
      console.log(`\n[Backfill] === Batch ${batchNum}/${totalBatches} (${batch.length} conversations) ===`);
      
      // Process each conversation in the batch
      for (const conversation of batch) {
        await backfillConversationMessages(conversation, stats);
      }
      
      // Delay between batches to avoid rate limits
      if (i + BATCH_SIZE < conversations.length) {
        console.log(`[Backfill] Waiting ${BATCH_DELAY}ms before next batch...`);
        await sleep(BATCH_DELAY);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n=== Backfill Messages - Complete ===');
    console.log('Summary:', {
      totalConversations: stats.totalConversations,
      conversationsProcessed: stats.conversationsProcessed,
      conversationsFailed: stats.conversationsFailed,
      totalMessagesInserted: stats.totalMessagesInserted,
      totalMessagesFailed: stats.totalMessagesFailed,
      durationSeconds: duration,
    });
    
  } catch (err: any) {
    console.error('[Backfill] Fatal error:', err?.message);
    throw err;
  }
}

async function main() {
  try {
    await backfillAllMessages();
    process.exit(0);
  } catch (err: any) {
    console.error('Backfill failed:', err?.message);
    process.exit(1);
  }
}

main();

