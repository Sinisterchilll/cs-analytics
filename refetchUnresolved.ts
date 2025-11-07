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
  console.error('Missing Supabase envs: need URL and either SERVICE_ROLE_KEY or ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY!, {
  auth: { persistSession: false },
});

const VERBOSE_LOG = String(process.env.VERBOSE_LOG || '') === '1';
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
      const backoff = Math.pow(2, attempt - 1) * 1000;
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

async function fetchConversation(conversationId: string) {
  const data = await fetchWithRetry(`/conversations/${conversationId}`);
  return data;
}

async function upsertConversation(convo: any, convoId: string) {
  const row = {
    id: convoId,
    userid: convo.userId || convo.user_id,
    status: convo.status || '',
    channel_id: convo.channel_id || '',
    created_time: new Date(convo.created_time || convo.created_at || Date.now()).toISOString(),
    updated_time: new Date(convo.updated_time || convo.updated_at || Date.now()).toISOString(),
    assigned_to: JSON.stringify(convo.assigned_to || {}),
    custom_properties: convo.custom_properties || {},
  };
  const { error } = await supabase.from('Conversation').upsert(row, { onConflict: 'id' });
  if (error) {
    if (VERBOSE_LOG) console.error('[Supabase] upsert Conversation error:', error);
    throw error;
  }
}

async function refetchUnresolvedConversations() {
  // eslint-disable-next-line no-console
  console.log('[Refetch] Starting refetch of all unresolved conversations...');
  
  const MAX_AGE_DAYS = 30; // Don't check conversations older than 30 days
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  
  // Get ALL unresolved conversations (not too old)
  const { data: unresolvedConvos, error } = await supabase
    .from('Conversation')
    .select('id, userid, status, updated_time, created_time')
    .neq('status', 'resolved')
    .gt('created_time', maxAge.toISOString()) // Only conversations < 30 days old
    .order('updated_time', { ascending: true }); // Check oldest first
  
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[Refetch] Error fetching unresolved conversations:', error);
    return { checked: 0, resolved: 0, updated: 0, errors: 0 };
  }

  if (!unresolvedConvos || unresolvedConvos.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[Refetch] No unresolved conversations to check.');
    return { checked: 0, resolved: 0, updated: 0, errors: 0 };
  }

  // eslint-disable-next-line no-console
  console.log(`[Refetch] Found ${unresolvedConvos.length} unresolved conversations to check`);
  
  let checked = 0;
  let resolved = 0;
  let updated = 0;
  let errors = 0;

  for (const dbConvo of unresolvedConvos) {
    try {
      // Fetch latest state from Freshchat
      const freshConvo = await fetchConversation(dbConvo.id);
      checked++;
      
      const freshStatus = freshConvo.status || '';
      const freshUpdatedTime = freshConvo.updated_time || freshConvo.updated_at;
      
      // Check if status or updated_time changed
      const statusChanged = freshStatus !== dbConvo.status;
      const timeChanged = freshUpdatedTime && 
        new Date(freshUpdatedTime).getTime() !== new Date(dbConvo.updated_time).getTime();
      
      if (statusChanged || timeChanged) {
        // Update conversation in DB
        await upsertConversation({ ...freshConvo, userId: dbConvo.userid }, dbConvo.id);
        updated++;
        
        if (freshStatus === 'resolved') {
          resolved++;
          if (VERBOSE_LOG) {
            // eslint-disable-next-line no-console
            console.log(`[Refetch] ✓ Conversation ${dbConvo.id} resolved at ${freshUpdatedTime}`);
          }
        }
      }
      
      // Progress logging every 50 conversations
      if (checked % 50 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[Refetch] Progress: ${checked}/${unresolvedConvos.length} checked, ${resolved} resolved, ${updated} updated`);
      }
      
      // Throttle to avoid rate limits
      await sleep(300);
      
    } catch (e: any) {
      errors++;
      // eslint-disable-next-line no-console
      console.error(`[Refetch] Failed to refetch conversation ${dbConvo.id}:`, e?.message);
      await sleep(500);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[Refetch] Completed. Summary:', { 
    total: unresolvedConvos.length,
    checked, 
    resolved, 
    updated,
    errors,
    stillUnresolved: unresolvedConvos.length - resolved
  });
  
  return { checked, resolved, updated, errors };
}

// Main execution
async function main() {
  // eslint-disable-next-line no-console
  console.log('=== Refetch Unresolved Conversations ===');
  await refetchUnresolvedConversations();
  // eslint-disable-next-line no-console
  console.log('=== Refetch Complete ===');
  process.exit(0);
}

main();


