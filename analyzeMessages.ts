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

import { createClient } from '@supabase/supabase-js';
import { analyzeMessagesWithRetry, MODEL } from './lib/openai';

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) as string | undefined;
const SUPABASE_SERVICE_ROLE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) as string | undefined;
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY) as string | undefined;

if (!SUPABASE_URL || (!SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_ANON_KEY)) {
  console.error('Missing Supabase envs');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY!, {
  auth: { persistSession: false },
});

const VERBOSE_LOG = String(process.env.VERBOSE_LOG || '') === '1';
const MAX_MESSAGES_PER_BATCH = 20; // Max messages to analyze in single OpenAI call
const MAX_CONVERSATIONS_TO_PROCESS = Number(process.env.MAX_CONVERSATIONS || 100); // Limit per run

interface Message {
  id: string;
  conversationid: string;
  actor_type: string;
  message_parts: string;
  created_time: string;
}

interface AnalysisResult {
  language: string;
  category: string;
  tag: string; // Single tag instead of array
  confidence: number;
}

/**
 * Fetch messages grouped by conversation that need analysis
 */
async function fetchMessagesForAnalysis(): Promise<Map<string, Message[]>> {
  // First get all analyzed message IDs
  const { data: analyzedMessages } = await supabase
    .from('MessageAnalysis')
    .select('message_id');
  
  const analyzedIds = new Set((analyzedMessages || []).map(m => m.message_id));

  // Fetch all user messages
  const { data: allMessages, error } = await supabase
    .from('Message')
    .select('id, conversationid, actor_type, message_parts, created_time')
    .eq('actor_type', 'user') // Only analyze user messages
    .neq('message_parts', '')
    .order('created_time', { ascending: false })
    .limit(1000); // Fetch up to 1000 messages

  if (error) {
    console.error('[Fetch] Error fetching messages:', error);
    throw error;
  }

  // Filter out already analyzed messages and short messages
  let skippedShort = 0;
  const messages = (allMessages || [])
    .filter(m => !analyzedIds.has(m.id))
    .filter(m => {
      // Skip very short messages (≤2 words or ≤10 characters)
      const text = m.message_parts.trim();
      const wordCount = text.split(/\s+/).filter((w: string) => w.length > 0).length;
      const charCount = text.length;
      
      if (wordCount <= 2 || charCount <= 10) {
        skippedShort++;
        if (VERBOSE_LOG) {
          console.log(`[Filter] Skipping short message (${wordCount} words, ${charCount} chars): "${text.substring(0, 30)}"`);
        }
        return false;
      }
      
      return true;
    });

  if (VERBOSE_LOG) {
    console.log(`[Fetch] Found ${messages.length} unanalyzed messages (filtered from ${allMessages?.length || 0} total, skipped ${skippedShort} short messages)`);
  } else {
    console.log(`[Fetch] Found ${messages.length} unanalyzed messages (skipped ${skippedShort} short messages)`);
  }

  // Group by conversation
  const conversationMap = new Map<string, Message[]>();
  for (const msg of messages || []) {
    const convId = msg.conversationid;
    if (!conversationMap.has(convId)) {
      conversationMap.set(convId, []);
    }
    conversationMap.get(convId)!.push(msg as Message);
  }

  // Sort messages within each conversation by created_time
  for (const msgs of conversationMap.values()) {
    msgs.sort((a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime());
  }

  return conversationMap;
}

/**
 * Analyze a single conversation batch
 */
async function analyzeConversation(conversationId: string, messages: Message[]): Promise<void> {
  try {
    if (VERBOSE_LOG) {
      console.log(`[Analyze] Processing conversation ${conversationId} with ${messages.length} messages`);
    }

    // Limit messages per batch to stay within token limits
    const messagesToAnalyze = messages.slice(0, MAX_MESSAGES_PER_BATCH);
    
    const response = await analyzeMessagesWithRetry(
      messagesToAnalyze.map(m => ({
        actor_type: m.actor_type,
        message_parts: m.message_parts
      }))
    );

    if (!response.messages || !Array.isArray(response.messages)) {
      throw new Error('Invalid response format from OpenAI');
    }

    // Store analysis results
    const analyses = response.messages.map((result: AnalysisResult, index: number) => ({
      message_id: messagesToAnalyze[index].id,
      language: result.language || 'unknown',
      category: result.category || 'others',
      tag: result.tag || 'cs', // Single tag
      confidence: result.confidence || 0.5,
      model_version: MODEL,
    }));

    const { error: insertError } = await supabase
      .from('MessageAnalysis')
      .upsert(analyses, { onConflict: 'message_id' });

    if (insertError) {
      console.error(`[Analyze] Error storing analysis for conversation ${conversationId}:`, insertError);
      throw insertError;
    }

    if (VERBOSE_LOG) {
      console.log(`[Analyze] ✓ Stored ${analyses.length} analyses for conversation ${conversationId}`);
    }

  } catch (error: unknown) {
    const err = error as { message?: string; status?: number; name?: string };
    console.error(`[Analyze] Failed conversation ${conversationId}:`, err?.message);
    
    // Record failure for retry
    const errorType = err?.status === 429 ? 'rate_limit' 
                    : err?.status && err.status >= 500 ? 'api_error'
                    : err?.name === 'SyntaxError' ? 'parse_error'
                    : 'unknown_error';

    const nextRetry = new Date();
    nextRetry.setHours(nextRetry.getHours() + 1); // Retry in 1 hour

    for (const msg of messages) {
      // First, check if failure already exists
      const { data: existing } = await supabase
        .from('AnalysisFailures')
        .select('attempts')
        .eq('message_id', msg.id)
        .single();

      if (existing) {
        // Update existing failure record
        await supabase
          .from('AnalysisFailures')
          .update({
            attempts: existing.attempts + 1,
            last_attempt: new Date().toISOString(),
            next_retry: nextRetry.toISOString(),
            error_message: err?.message || 'Unknown error',
            error_type: errorType,
          })
          .eq('message_id', msg.id);
      } else {
        // Insert new failure record
        await supabase
          .from('AnalysisFailures')
          .insert({
            message_id: msg.id,
            conversation_id: conversationId,
            error_message: err?.message || 'Unknown error',
            error_type: errorType,
            attempts: 1,
            next_retry: nextRetry.toISOString(),
          });
      }
    }
  }
}

/**
 * Process failed messages that are ready for retry
 */
async function retryFailedMessages(): Promise<void> {
  const { data: failures, error } = await supabase
    .from('FailedMessagesForRetry')
    .select('message_id, conversation_id, attempts')
    .limit(50);

  if (error || !failures?.length) {
    if (error) console.error('[Retry] Error fetching failures:', error);
    return;
  }

  console.log(`[Retry] Found ${failures.length} failed messages to retry`);

  // Group by conversation
  const convMap = new Map<string, string[]>();
  for (const f of failures) {
    if (!convMap.has(f.conversation_id)) {
      convMap.set(f.conversation_id, []);
    }
    convMap.get(f.conversation_id)!.push(f.message_id);
  }

  // Fetch and retry each conversation
  for (const [convId, messageIds] of convMap.entries()) {
    const { data: messages } = await supabase
      .from('Message')
      .select('id, conversationid, actor_type, message_parts, created_time')
      .in('id', messageIds);

    if (messages?.length) {
      await analyzeConversation(convId, messages as Message[]);
    }
  }
}

/**
 * Main analysis flow
 */
async function runAnalysis(): Promise<void> {
  console.log('--- Analysis start ---');
  const startTime = Date.now();

  try {
    // 1. Retry failed messages first
    await retryFailedMessages();

    // 2. Fetch new messages for analysis
    const conversationMap = await fetchMessagesForAnalysis();
    const totalConversations = conversationMap.size;
    const totalMessages = Array.from(conversationMap.values()).reduce((sum, msgs) => sum + msgs.length, 0);

    console.log(`[Analyze] Found ${totalMessages} messages across ${totalConversations} conversations`);

    if (totalConversations === 0) {
      console.log('[Analyze] No messages to analyze');
      return;
    }

    // 3. Process conversations (limit to avoid long runs)
    let processed = 0;
    let analyzed = 0;
    let failed = 0;

    for (const [convId, messages] of conversationMap.entries()) {
      if (processed >= MAX_CONVERSATIONS_TO_PROCESS) {
        console.log(`[Analyze] Reached limit of ${MAX_CONVERSATIONS_TO_PROCESS} conversations, stopping`);
        break;
      }

      try {
        await analyzeConversation(convId, messages);
        analyzed += messages.length;
      } catch {
        failed += messages.length;
      }

      processed++;

      // Small delay between conversations to avoid rate limits
      if (processed < Math.min(totalConversations, MAX_CONVERSATIONS_TO_PROCESS)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('[Analyze] Completed. Summary:', {
      conversationsProcessed: processed,
      messagesAnalyzed: analyzed,
      messagesFailed: failed,
      durationSeconds: duration
    });

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('[Analyze] Fatal error:', err?.message);
    throw error;
  }

  console.log('--- Analysis complete ---');
}

// Run analysis
runAnalysis()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Analysis failed:', error);
    process.exit(1);
  });

