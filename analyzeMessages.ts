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

import { prisma } from './lib/prisma';
import { analyzeMessagesWithRetry, MODEL } from './lib/openai';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}

const VERBOSE_LOG = String(process.env.VERBOSE_LOG || '') === '1';
const MAX_MESSAGES_PER_BATCH = 20; // Max messages to analyze in single OpenAI call
const MAX_CONVERSATIONS_TO_PROCESS = Number(process.env.MAX_CONVERSATIONS || 100); // Limit per run

interface Message {
  id: string;
  conversationId: string;
  actor_type: string;
  message_parts: string | any; // Can be string or JSON
  created_time: Date | string;
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
  const analyzedMessages = await prisma.messageAnalysis.findMany({
    select: { messageId: true },
  });
  
  const analyzedIds = new Set(analyzedMessages.map(m => m.messageId));

  // Fetch all user messages
  const allMessages = await prisma.message.findMany({
    where: {
      actor_type: 'user',
      message_parts: { not: '' },
    },
    select: {
      id: true,
      conversationId: true,
      actor_type: true,
      message_parts: true,
      created_time: true,
    },
    orderBy: { created_time: 'desc' },
    take: 1000,
  });

  // Filter out already analyzed messages and short messages
  let skippedShort = 0;
  const messages = allMessages
    .filter(m => !analyzedIds.has(m.id))
    .filter(m => {
      // Handle message_parts - it's stored as string in the database
      const text = typeof m.message_parts === 'string' 
        ? m.message_parts 
        : String(m.message_parts || '');
      const trimmedText = text.trim();
      const wordCount = trimmedText.split(/\s+/).filter((w: string) => w.length > 0).length;
      const charCount = trimmedText.length;
      
      if (wordCount <= 2 || charCount <= 10) {
        skippedShort++;
        if (VERBOSE_LOG) {
          console.log(`[Filter] Skipping short message (${wordCount} words, ${charCount} chars): "${trimmedText.substring(0, 30)}"`);
        }
        return false;
      }
      
      return true;
    })
    .map(m => ({
      ...m,
      message_parts: typeof m.message_parts === 'string' 
        ? m.message_parts 
        : JSON.stringify(m.message_parts),
    }));

  if (VERBOSE_LOG) {
    console.log(`[Fetch] Found ${messages.length} unanalyzed messages (filtered from ${allMessages.length} total, skipped ${skippedShort} short messages)`);
  } else {
    console.log(`[Fetch] Found ${messages.length} unanalyzed messages (skipped ${skippedShort} short messages)`);
  }

  // Group by conversation
  const conversationMap = new Map<string, Message[]>();
  for (const msg of messages) {
    const convId = msg.conversationId;
    if (!conversationMap.has(convId)) {
      conversationMap.set(convId, []);
    }
    conversationMap.get(convId)!.push(msg as Message);
  }

  // Sort messages within each conversation by created_time
  for (const msgs of conversationMap.values()) {
    msgs.sort((a, b) => {
      const aTime = a.created_time instanceof Date ? a.created_time.getTime() : new Date(a.created_time).getTime();
      const bTime = b.created_time instanceof Date ? b.created_time.getTime() : new Date(b.created_time).getTime();
      return aTime - bTime;
    });
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
      messageId: messagesToAnalyze[index].id,
      language: result.language || 'unknown',
      category: result.category || 'others',
      tag: result.tag || 'cs', // Single tag
      confidence: result.confidence || 0.5,
      modelVersion: MODEL,
    }));

    try {
      await prisma.messageAnalysis.createMany({
        data: analyses,
        skipDuplicates: true,
      });
    } catch (insertError) {
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
      const existing = await prisma.analysisFailures.findUnique({
        where: { messageId: msg.id },
        select: { attempts: true },
      });

      if (existing) {
        // Update existing failure record
        await prisma.analysisFailures.update({
          where: { messageId: msg.id },
          data: {
            attempts: existing.attempts + 1,
            lastAttempt: new Date(),
            nextRetry: nextRetry,
            errorMessage: err?.message || 'Unknown error',
            errorType: errorType,
          },
        });
      } else {
        // Insert new failure record
        await prisma.analysisFailures.create({
          data: {
            messageId: msg.id,
            conversationId: conversationId,
            errorMessage: err?.message || 'Unknown error',
            errorType: errorType,
            attempts: 1,
            nextRetry: nextRetry,
          },
        });
      }
    }
  }
}

/**
 * Process failed messages that are ready for retry
 */
async function retryFailedMessages(): Promise<void> {
  // Query the view using raw SQL since it's a database view
  const failures = await prisma.$queryRaw<Array<{
    message_id: string;
    conversation_id: string;
    attempts: number;
  }>>`
    SELECT message_id, conversation_id, attempts
    FROM "FailedMessagesForRetry"
    LIMIT 50
  `;

  if (!failures?.length) {
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
    const messages = await prisma.message.findMany({
      where: {
        id: { in: messageIds },
      },
      select: {
        id: true,
        conversationId: true,
        actor_type: true,
        message_parts: true,
        created_time: true,
      },
    });

    if (messages?.length) {
      // Convert message_parts to string for the Message interface
      const convertedMessages = messages.map(m => ({
        ...m,
        message_parts: typeof m.message_parts === 'string' 
          ? m.message_parts 
          : JSON.stringify(m.message_parts),
      }));
      await analyzeConversation(convId, convertedMessages as Message[]);
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

