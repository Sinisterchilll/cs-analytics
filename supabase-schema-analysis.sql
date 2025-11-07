-- MessageAnalysis table to store LLM analysis results
CREATE TABLE IF NOT EXISTS "MessageAnalysis" (
  id SERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL REFERENCES "Message"(id) ON DELETE CASCADE,
  language VARCHAR(10),           -- 'en', 'hi', 'hi-en' (Hinglish), 'ta', 'te', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa'
  category VARCHAR(50),            -- 'kyc', 'bike_not_moving', 'battery_problem', 'price_inquiry', 'offer_inquiry', 'app_related', 'hub_inquiry', 'payment', 'others'
  tag VARCHAR(20),                 -- 'cs', 'bot', or 'escalated'
  confidence FLOAT CHECK (confidence >= 0 AND confidence <= 1),
  analyzed_at TIMESTAMPTZ DEFAULT NOW(),
  model_version VARCHAR(30) DEFAULT 'gpt-4o-mini-2024-07-18'
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_msg_analysis_message ON "MessageAnalysis"(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_analysis_category ON "MessageAnalysis"(category);
CREATE INDEX IF NOT EXISTS idx_msg_analysis_tag ON "MessageAnalysis"(tag);
CREATE INDEX IF NOT EXISTS idx_msg_analysis_language ON "MessageAnalysis"(language);

-- AnalysisFailures table to track and retry failed analyses
CREATE TABLE IF NOT EXISTS "AnalysisFailures" (
  message_id TEXT PRIMARY KEY REFERENCES "Message"(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  error_message TEXT,
  error_type VARCHAR(50),         -- 'rate_limit', 'api_error', 'parse_error', etc.
  attempts INT DEFAULT 1,
  last_attempt TIMESTAMPTZ DEFAULT NOW(),
  next_retry TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_failures_retry ON "AnalysisFailures"(next_retry)
WHERE next_retry IS NOT NULL;

-- View to easily find messages needing analysis
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
ORDER BY m.created_time DESC;

-- View for failed messages ready for retry
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
ORDER BY af.next_retry ASC;

COMMENT ON TABLE "MessageAnalysis" IS 'Stores LLM analysis results for messages including language, category, and tags';
COMMENT ON TABLE "AnalysisFailures" IS 'Tracks failed analysis attempts for retry with exponential backoff';
COMMENT ON VIEW "MessagesNeedingAnalysis" IS 'Messages that need LLM analysis (not yet analyzed and not permanently failed)';
COMMENT ON VIEW "FailedMessagesForRetry" IS 'Failed messages ready for retry based on backoff schedule';

