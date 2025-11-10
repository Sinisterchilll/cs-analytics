# Message Backfill Script

## Overview

The `backfillMessages.ts` script fetches **all messages** for **all conversations** stored in your database from Freshchat and upserts them into the `Message` table. It intelligently skips messages that already exist to avoid duplicates.

## Use Cases

- **Initial setup**: Populate messages for conversations that were imported without messages
- **Data recovery**: Re-sync messages after a database issue
- **Historical backfill**: Fill in gaps for conversations created before the automated fetcher was running
- **Manual sync**: One-time sync for all 700+ conversations

## Key Features

✅ **Batch processing**: Processes conversations in configurable batches (default: 50)  
✅ **Rate limiting**: Built-in delays to avoid Freshchat API rate limits  
✅ **Duplicate prevention**: Checks existing messages before inserting  
✅ **Progress tracking**: Real-time logging of progress and stats  
✅ **Error resilience**: Continues processing even if individual conversations fail  
✅ **System message filtering**: Automatically filters out `actor_type = 'system'`  
✅ **Content cleaning**: Extracts clean text from nested `message_parts` JSON  

---

## Configuration

### Environment Variables

Required (same as other scripts):
```bash
FRESHCHAT_TOKEN=your_token
FRESHCHAT_DOMAIN=your_domain.freshchat.com
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
# OR
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

Optional (for fine-tuning):
```bash
BATCH_SIZE=50                  # Number of conversations per batch (default: 50)
RATE_LIMIT_DELAY=1000          # Delay between API calls in ms (default: 1000)
BATCH_DELAY=5000               # Delay between batches in ms (default: 5000)
VERBOSE_LOG=0                  # Set to 1 for detailed logging
```

---

## How It Works

### Step-by-Step Process

1. **Fetch all conversations** from your Supabase `Conversation` table (ordered by `created_time`, oldest first)

2. **For each conversation**:
   - Query Supabase to get existing message IDs for that conversation
   - Fetch all messages from Freshchat API (from conversation `created_time` to now)
   - Compare: Skip messages that already exist in database
   - Upsert only new messages

3. **Process in batches**:
   - Process `BATCH_SIZE` conversations (default: 50)
   - Wait `BATCH_DELAY` ms (default: 5 seconds) between batches
   - Wait `RATE_LIMIT_DELAY` ms (default: 1 second) between individual API calls

4. **Apply filters**:
   - Skip `actor_type = 'system'` messages
   - Clean `message_parts` to store only text content

5. **Log progress**:
   - Per conversation: `✓ Conversation abc123: 5 new, 3 skipped, 8 total`
   - Final summary with total stats

---

## Usage

### Run Locally

```bash
npm run backfill:run
```

### Expected Output

```
=== Backfill Messages - Start ===
Configuration: BATCH_SIZE=50, RATE_LIMIT_DELAY=1000ms, BATCH_DELAY=5000ms
[Backfill] Fetching all conversations from database...
[Backfill] Found 700 conversations to process

[Backfill] === Batch 1/14 (50 conversations) ===
[Backfill] ✓ Conversation conv_abc123: 15 new, 2 skipped, 17 total
[Backfill] ✓ Conversation conv_def456: 8 new, 0 skipped, 8 total
[Backfill] ✓ Conversation conv_ghi789: 0 new, 12 skipped, 12 total
...
[Backfill] Waiting 5000ms before next batch...

[Backfill] === Batch 2/14 (50 conversations) ===
...

=== Backfill Messages - Complete ===
Summary: {
  totalConversations: 700,
  conversationsProcessed: 695,
  conversationsFailed: 5,
  totalMessagesInserted: 4523,
  totalMessagesFailed: 12,
  durationSeconds: '1850.45'
}
```

---

## Performance Estimation

### For 700 Conversations

**Assumptions**:
- Average 10 messages per conversation
- `BATCH_SIZE=50`
- `RATE_LIMIT_DELAY=1000ms` (1 second per conversation)
- `BATCH_DELAY=5000ms` (5 seconds per batch)

**Calculation**:
- 700 conversations ÷ 50 per batch = 14 batches
- Time per batch: 50 conversations × 1 second = 50 seconds
- Batch delays: 13 delays × 5 seconds = 65 seconds
- **Total time: ~15-20 minutes**

If you have more messages per conversation or stricter rate limits, it could take longer (30-45 minutes).

---

## Rate Limiting Strategy

The script uses a **3-tier delay system** to avoid rate limits:

1. **Per-message pagination**: 500ms between pages (inside `paginate()`)
2. **Per-conversation**: `RATE_LIMIT_DELAY` (default: 1000ms) after fetching each conversation's messages
3. **Per-batch**: `BATCH_DELAY` (default: 5000ms) between batches

### If You Hit Rate Limits

Increase the delays:

```bash
RATE_LIMIT_DELAY=2000 BATCH_DELAY=10000 npm run backfill:run
```

This will make it slower but safer:
- 2 seconds between conversations
- 10 seconds between batches

---

## Monitoring Progress

### Real-time Logs

```bash
# Watch the script run with detailed logging
VERBOSE_LOG=1 npm run backfill:run
```

### Database Queries

**Check message count per conversation**:
```sql
SELECT 
  c.id as conversation_id,
  c.status,
  COUNT(m.id) as message_count
FROM "Conversation" c
LEFT JOIN "Message" m ON m.conversationid = c.id
GROUP BY c.id, c.status
ORDER BY message_count ASC;
```

**Find conversations with no messages**:
```sql
SELECT c.id, c.status, c.created_time
FROM "Conversation" c
LEFT JOIN "Message" m ON m.conversationid = c.id
WHERE m.id IS NULL
ORDER BY c.created_time DESC;
```

**Check backfill progress during run**:
```sql
-- Run this query periodically to see new messages being inserted
SELECT 
  COUNT(*) as total_messages,
  COUNT(DISTINCT conversationid) as conversations_with_messages,
  MIN(created_time) as oldest_message,
  MAX(created_time) as newest_message
FROM "Message";
```

---

## Error Handling

### Conversation-level Errors

If a conversation fails:
- Error is logged: `✗ Failed to process conversation conv_123: Connection timeout`
- Script continues with next conversation
- Failed count tracked in final summary

### API Rate Limiting

If Freshchat returns `429 Too Many Requests`:
- Automatic retry with exponential backoff (1s, 2s, 4s)
- Up to 3 attempts per API call
- If all retries fail, conversation is marked as failed and script continues

### Fatal Errors

If script crashes:
- Exit code 1
- Safe to restart - will skip already-processed messages
- Progress is saved in database after each message upsert

---

## Best Practices

### First Run

1. **Test with small batch first**:
   ```bash
   BATCH_SIZE=5 npm run backfill:run
   ```
   Check logs and database to ensure it's working correctly.

2. **Run full backfill**:
   ```bash
   npm run backfill:run
   ```

3. **Monitor progress** in another terminal:
   ```bash
   # Check message count every 30 seconds
   watch -n 30 'psql $DATABASE_URL -c "SELECT COUNT(*) FROM Message"'
   ```

### Subsequent Runs

The script is **idempotent** - safe to run multiple times:
- Already-existing messages are skipped
- Only new messages are inserted
- No duplicates created

You can run it periodically to catch any gaps:
```bash
# Once a week to ensure consistency
npm run backfill:run
```

---

## Troubleshooting

### Issue: Script is too slow

**Solution**: Decrease delays (but watch for rate limits)
```bash
RATE_LIMIT_DELAY=500 BATCH_DELAY=2000 npm run backfill:run
```

### Issue: Getting rate limited (429 errors)

**Solution**: Increase delays
```bash
RATE_LIMIT_DELAY=2000 BATCH_DELAY=10000 npm run backfill:run
```

### Issue: Script stops/crashes mid-run

**Solution**: Just restart it - it will skip already-processed messages
```bash
npm run backfill:run
```

### Issue: Some conversations have 0 messages

**Possible reasons**:
1. Conversation truly has no messages in Freshchat
2. All messages were `actor_type = 'system'` (filtered out)
3. API error during fetch (check logs for that conversation ID)

**Check manually**:
```bash
# Check Freshchat API directly
curl -H "Authorization: Bearer $FRESHCHAT_TOKEN" \
  "https://$FRESHCHAT_DOMAIN/v2/conversations/{conv_id}/messages"
```

### Issue: Duplicate messages

**Should not happen** - script checks existing IDs before inserting. If it does:
1. Check if message IDs are being generated consistently
2. Verify `onConflict: 'id'` is working in Supabase upsert
3. Check for race conditions (don't run backfill while main fetch script is running)

---

## Integration with Other Scripts

### Recommended Order

1. **Run backfill once** (one-time, historical data):
   ```bash
   npm run backfill:run
   ```

2. **Let scheduled scripts run** (ongoing, incremental):
   - `fetchData.ts` - every 2 hours at :00
   - `analyzeMessages.ts` - every 2 hours at :20
   - `refetchUnresolved.ts` - every 2 hours at :30

### When to Re-run Backfill

- After database migration/restore
- If you notice conversations with missing messages
- As a periodic consistency check (e.g., monthly)

---

## Advanced Configuration

### Process Specific Date Range

Modify the query in `backfillAllMessages()`:

```typescript
const { data: conversations, error } = await supabase
  .from('Conversation')
  .select('id, created_time')
  .gte('created_time', '2024-01-01T00:00:00Z')  // Only conversations after Jan 1, 2024
  .lte('created_time', '2024-12-31T23:59:59Z')  // Before Dec 31, 2024
  .order('created_time', { ascending: true });
```

### Process Specific Conversations

```typescript
const specificConvIds = ['conv_123', 'conv_456', 'conv_789'];

const { data: conversations, error } = await supabase
  .from('Conversation')
  .select('id, created_time')
  .in('id', specificConvIds);
```

---

## Summary

✅ **Safe**: Skips existing messages, no duplicates  
✅ **Resilient**: Handles errors gracefully, can be restarted  
✅ **Fast**: Batch processing with configurable rate limiting  
✅ **Transparent**: Detailed logging and progress tracking  
✅ **Consistent**: Uses same logic as main fetch script  

**For 700 conversations**: Expect 15-30 minutes runtime with default settings.

Run it once to backfill historical data, then let your scheduled scripts handle incremental updates! 🚀

