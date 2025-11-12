-- ============================================
-- Cleanup Script: Remove Short Messages from Analysis System
-- ============================================
-- This script removes short messages (≤2 words or ≤10 characters) from:
-- 1. AnalysisFailures table (prevents infinite retry loops)
-- 2. Updates views to automatically filter them out
--
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Show current counts before cleanup
SELECT 
  'Before Cleanup' as status,
  'AnalysisFailures' as table_name,
  COUNT(*) as total_count,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM "Message" m 
      WHERE m.id = "AnalysisFailures".message_id
      AND (
        array_length(regexp_split_to_array(TRIM(m.message_parts), E'\\s+'), 1) <= 2
        OR LENGTH(TRIM(m.message_parts)) <= 10
      )
    )
  ) as short_messages
FROM "AnalysisFailures";

-- 2. Delete short messages from AnalysisFailures
DELETE FROM "AnalysisFailures"
WHERE message_id IN (
  SELECT af.message_id
  FROM "AnalysisFailures" af
  JOIN "Message" m ON af.message_id = m.id
  WHERE 
    array_length(regexp_split_to_array(TRIM(m.message_parts), E'\\s+'), 1) <= 2
    OR LENGTH(TRIM(m.message_parts)) <= 10
);

-- 3. Update views with short message filters (if not already done)
CREATE OR REPLACE VIEW "FailedMessagesForRetry" AS
SELECT 
  af.message_id,
  af.conversation_id,
  af.error_message,
  af.attempts,
  af.next_retry,
  m.message_parts
FROM "AnalysisFailures" af
JOIN "Message" m ON af.message_id = m.id
WHERE af.next_retry IS NOT NULL
  AND af.next_retry <= NOW()
  AND af.attempts < 3
  -- Filter out short messages (≤2 words or ≤10 characters)
  AND array_length(regexp_split_to_array(TRIM(m.message_parts), E'\\s+'), 1) > 2
  AND LENGTH(TRIM(m.message_parts)) > 10
ORDER BY af.next_retry ASC;

CREATE OR REPLACE VIEW "MessagesNeedingAnalysis" AS
SELECT 
  m.id,
  m.conversationid,
  m.actor_type,
  m.message_parts,
  m.created_time
FROM "Message" m
LEFT JOIN "MessageAnalysis" ma ON m.id = ma.message_id
LEFT JOIN "AnalysisFailures" af ON m.id = af.message_id
WHERE ma.id IS NULL  -- not yet analyzed
  AND m.message_parts IS NOT NULL
  AND m.message_parts != ''
  AND m.actor_type = 'user'  -- only analyze user messages
  AND (af.message_id IS NULL OR af.attempts < 3)  -- not failed or has retries left
  -- Filter out short messages (≤2 words or ≤10 characters)
  AND array_length(regexp_split_to_array(TRIM(m.message_parts), E'\\s+'), 1) > 2
  AND LENGTH(TRIM(m.message_parts)) > 10
ORDER BY m.created_time DESC;

-- 4. Show counts after cleanup
SELECT 
  'After Cleanup' as status,
  'AnalysisFailures' as table_name,
  COUNT(*) as total_count
FROM "AnalysisFailures"
UNION ALL
SELECT 
  'After Cleanup' as status,
  'FailedMessagesForRetry (View)' as table_name,
  COUNT(*) as total_count
FROM "FailedMessagesForRetry"
UNION ALL
SELECT 
  'After Cleanup' as status,
  'MessagesNeedingAnalysis (View)' as table_name,
  COUNT(*) as total_count
FROM "MessagesNeedingAnalysis";

-- 5. Show sample of remaining failed messages
SELECT 
  message_id,
  conversation_id,
  attempts,
  error_message,
  LEFT(message_parts, 50) as message_preview,
  array_length(regexp_split_to_array(TRIM(message_parts), E'\\s+'), 1) as word_count,
  LENGTH(TRIM(message_parts)) as char_count
FROM "FailedMessagesForRetry"
ORDER BY next_retry ASC
LIMIT 10;

