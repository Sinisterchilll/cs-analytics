# LLM Message Analysis System

Complete setup guide for the automated message analysis system using OpenAI GPT-4o-mini.

## Architecture Overview

```
Freshchat API → fetchData.ts (every 2h) → Supabase (User, Conversation, Message)
                                              ↓
                          analyzeMessages.ts (20min after fetch)
                                              ↓
                   OpenAI GPT-4o-mini (conversation batching)
                                              ↓
                      Supabase (MessageAnalysis, AnalysisFailures)
                                              ↓
                          Metabase Dashboards
```

## Setup Instructions

### 1. Create Supabase Tables

Run this SQL in Supabase SQL Editor:

```bash
# Execute the schema file
cat supabase-schema-analysis.sql
```

This creates:
- `MessageAnalysis` table (stores language, category, tags, confidence)
- `AnalysisFailures` table (tracks retry logic)
- Views for easy querying

### 2. Set Environment Variables

Add to your `.env.local`:

```bash
# OpenAI
OPENAI_API_KEY=sk-proj-...

# Supabase (already set)
NEXT_PUBLIC_SUPABASE_URL=https://...
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=...
```

### 3. Install Dependencies

```bash
npm install
```

This installs `openai` package (v4.67.3).

### 4. GitHub Actions Secrets

Add to GitHub repo secrets (Settings → Secrets and variables → Actions):

```
OPENAI_API_KEY=sk-proj-...
NEXT_PUBLIC_SUPABASE_URL=https://...
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=...
```

### 5. Test Locally

```bash
# Run analysis once
npm run analyze:run

# With verbose logging
VERBOSE_LOG=1 npm run analyze:run
```

## How It Works

### Conversation Batching
- Groups messages by `conversationid`
- **Only analyzes user messages** (bot/system messages excluded)
- Sends up to 20 messages per conversation to OpenAI in single API call
- Maintains conversation context for better classification
- **10-50x cheaper** than per-message analysis

### Categories (9 types)
1. `kyc` - KYC verification, document submission
2. `bike_not_moving` - Bike won't start, stuck, immobile
3. `battery_problem` - Battery issues, charging problems
4. `price_inquiry` - Price questions, cost, EMI
5. `offer_inquiry` - Discount, offers, promotions
6. `app_related` - Mobile app issues, login problems
7. `hub_inquiry` - Hub/service center location
8. `payment` - Payment failures, transaction issues
9. `others` - General queries, greetings

### Tags (3 types - auto-assigned by category)
- **`cs`** - Customer service team handles
  - Categories: `kyc`, `app_related`, `payment`, `others`
- **`bot`** - Bot can handle
  - Categories: `price_inquiry`, `hub_inquiry`, `offer_inquiry`
- **`escalated`** - Technical team needed
  - Categories: `bike_not_moving`, `battery_problem`

### Language Detection (11 languages)
- `en` - English
- `hi` - Hindi
- `hi-en` - Hinglish (mixed Hindi-English)
- `ta` - Tamil
- `te` - Telugu
- `kn` - Kannada
- `ml` - Malayalam
- `bn` - Bengali
- `mr` - Marathi
- `gu` - Gujarati
- `pa` - Punjabi

### Error Handling
- **429 (Rate Limit)**: Exponential backoff 2s, 4s, 8s
- **500 (Server Error)**: Retry with 1s, 2s, 4s backoff
- **400 (Client Error)**: Log and skip (don't retry)
- Failed messages stored in `AnalysisFailures` table
- Auto-retry up to 3 times with 1-hour spacing

### Rate Limiting
- Token bucket algorithm: 500 requests/minute
- Automatic throttling to stay within OpenAI limits
- 100ms delay between conversation batches

## Cost Estimation

**GPT-4o-mini pricing:**
- Input: $0.15 per 1M tokens
- Output: $0.60 per 1M tokens

**Example: 1000 messages/day**
- Avg 50 tokens/message input
- Avg 30 tokens/message output
- With 10 msgs/batch average:
  - 100 API calls (not 1000)
  - Input: 1000 × 50 × $0.15/1M = $0.0075/day
  - Output: 1000 × 30 × $0.60/1M = $0.018/day
  - **Total: ~$0.75/month**

## Scheduling

### GitHub Actions (Production)
- **Fetch**: Every 2 hours (`0 */2 * * *`)
- **Analysis**: 20 minutes after fetch (`20 */2 * * *`)

### Local Testing
```bash
# Run fetch
npm run fetch:run

# Wait, then run analysis
npm run analyze:run
```

## Monitoring

### Check Analysis Status
```sql
-- Analysis coverage
SELECT 
  COUNT(DISTINCT m.id) as total_user_messages,
  COUNT(DISTINCT ma.message_id) as analyzed_messages,
  ROUND(COUNT(DISTINCT ma.message_id)::numeric / COUNT(DISTINCT m.id) * 100, 2) as coverage_pct
FROM "Message" m
LEFT JOIN "MessageAnalysis" ma ON m.id = ma.message_id
WHERE m.actor_type = 'user'
  AND m.message_parts IS NOT NULL 
  AND m.message_parts != '';

-- Category distribution
SELECT category, COUNT(*) as count
FROM "MessageAnalysis"
GROUP BY category
ORDER BY count DESC;

-- Tag distribution
SELECT tag, COUNT(*) as count
FROM "MessageAnalysis"
GROUP BY tag
ORDER BY count DESC;

-- Language distribution
SELECT language, COUNT(*) as count
FROM "MessageAnalysis"
GROUP BY language
ORDER BY count DESC;

-- Failed analyses
SELECT 
  error_type,
  COUNT(*) as count,
  AVG(attempts) as avg_attempts
FROM "AnalysisFailures"
WHERE attempts < 3
GROUP BY error_type;
```

### Logs
- GitHub Actions: Check workflow logs in Actions tab
- Local: Console output shows progress and errors
- Enable `VERBOSE_LOG=1` for detailed logging

## Metabase Integration

### Sample Queries

**1. Bot Resolution by Category**
```sql
SELECT 
  ma.category,
  COUNT(*) as conversations,
  AVG(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END) * 100 as resolution_rate
FROM "MessageAnalysis" ma
JOIN "Message" m ON ma.message_id = m.id
JOIN "Conversation" c ON m.conversationid = c.id
WHERE m.actor_type = 'user'
GROUP BY ma.category
ORDER BY conversations DESC;
```

**2. Message Volume by Tag Over Time**
```sql
SELECT 
  DATE_TRUNC('day', m.created_time) as date,
  ma.tag,
  COUNT(*) as message_count
FROM "Message" m
JOIN "MessageAnalysis" ma ON m.id = ma.message_id
GROUP BY date, ma.tag
ORDER BY date DESC, message_count DESC;
```

**3. Language-Specific Performance**
```sql
SELECT 
  ma.language,
  AVG(ma.confidence) as avg_confidence,
  COUNT(*) as message_count
FROM "MessageAnalysis" ma
GROUP BY ma.language;
```

## Troubleshooting

### No messages being analyzed
1. Check `MessagesNeedingAnalysis` view has rows
2. Verify `OPENAI_API_KEY` is set
3. Check GitHub Actions logs for errors
4. Run locally with `VERBOSE_LOG=1`

### High failure rate
1. Check `AnalysisFailures` table for error types
2. If `rate_limit`: Reduce `MAX_CONVERSATIONS` env var
3. If `parse_error`: Review OpenAI response format
4. If `api_error`: Check OpenAI status page

### Analysis taking too long
1. Reduce `MAX_CONVERSATIONS` (default 100)
2. Increase batch size (up to 20 msgs/batch)
3. Run more frequently (every hour vs 2 hours)

## Files Created

```
.
├── supabase-schema-analysis.sql   # Database schema
├── lib/openai.ts                   # OpenAI client + rate limiter
├── analyzeMessages.ts              # Main analysis script
├── .github/workflows/
│   └── analyze-messages.yml        # GitHub Actions workflow
└── README-ANALYSIS.md              # This file
```

## Next Steps

1. Run the SQL schema in Supabase
2. Add `OPENAI_API_KEY` to env files
3. Install deps: `npm install`
4. Test locally: `npm run analyze:run`
5. Push to GitHub (workflows will auto-run)
6. Build Metabase dashboards using `MessageAnalysis` table

---

**Questions?** Check logs with `VERBOSE_LOG=1` or review the error types in `AnalysisFailures` table.

