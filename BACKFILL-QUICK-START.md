# Backfill Messages - Quick Start

## What It Does

Fetches **all messages** for **all 700 conversations** from Freshchat and stores them in your database. Skips messages that already exist - no duplicates!

---

## Quick Run

```bash
# Test with small batch first
BATCH_SIZE=5 npm run backfill:run

# If looks good, run full backfill
npm run backfill:run
```

---

## Expected Results

**For 700 conversations**:
- ⏱️ Duration: ~15-30 minutes
- 📦 Batches: 14 batches of 50 conversations
- 💾 Messages: ~4,000-7,000 messages (depends on your data)
- ✅ Safe: Skips existing messages automatically

---

## What You'll See

```bash
=== Backfill Messages - Start ===
[Backfill] Found 700 conversations to process

[Backfill] === Batch 1/14 (50 conversations) ===
[Backfill] ✓ Conversation abc123: 15 new, 2 skipped, 17 total
[Backfill] ✓ Conversation def456: 8 new, 0 skipped, 8 total
...

=== Backfill Messages - Complete ===
Summary: {
  totalConversations: 700,
  conversationsProcessed: 695,
  totalMessagesInserted: 4523,
  durationSeconds: '1245.67'
}
```

---

## Rate Limiting

The script has **built-in delays** to avoid Freshchat rate limits:

- ⏱️ 1 second between conversations
- ⏱️ 5 seconds between batches of 50

**If you get rate limited**, increase delays:
```bash
RATE_LIMIT_DELAY=2000 BATCH_DELAY=10000 npm run backfill:run
```

---

## Features

✅ **Smart skipping**: Only inserts new messages  
✅ **Batch processing**: Processes 50 conversations at a time  
✅ **Error resilient**: Continues even if some conversations fail  
✅ **Progress tracking**: Real-time logs showing progress  
✅ **Clean data**: Filters out system messages, extracts clean text  
✅ **Safe to restart**: If it crashes, just run again - won't create duplicates  

---

## Monitor Progress

While script is running, check database in another terminal:

```sql
-- Total messages inserted so far
SELECT COUNT(*) FROM "Message";

-- Messages per conversation
SELECT conversationid, COUNT(*) as msg_count 
FROM "Message" 
GROUP BY conversationid 
ORDER BY msg_count DESC 
LIMIT 20;

-- Conversations without messages
SELECT c.id 
FROM "Conversation" c 
LEFT JOIN "Message" m ON m.conversationid = c.id 
WHERE m.id IS NULL;
```

---

## Configuration Options

Default settings work well, but you can customize:

```bash
# Faster (but might hit rate limits)
BATCH_SIZE=100 RATE_LIMIT_DELAY=500 npm run backfill:run

# Slower (safer for rate limits)
BATCH_SIZE=25 RATE_LIMIT_DELAY=2000 BATCH_DELAY=10000 npm run backfill:run

# Verbose logging
VERBOSE_LOG=1 npm run backfill:run
```

---

## When to Run

### One-Time Backfill
Run it **once** to populate historical messages:
```bash
npm run backfill:run
```

### Re-run If Needed
Safe to run multiple times:
- After database restore
- To fill gaps in data
- As periodic consistency check (monthly)

### Don't Run During Scheduled Fetch
Avoid running while `fetchData.ts` is running (could cause conflicts). Best to run manually during a quiet time.

---

## Troubleshooting

**Too slow?**
```bash
RATE_LIMIT_DELAY=500 npm run backfill:run
```

**Getting 429 errors?**
```bash
RATE_LIMIT_DELAY=2000 BATCH_DELAY=10000 npm run backfill:run
```

**Script crashed?**
Just restart - it will skip already-processed messages:
```bash
npm run backfill:run
```

---

## What Happens Next?

After backfill completes:

1. ✅ **Historical data**: All past messages are in database
2. ✅ **Scheduled scripts continue**: 
   - `fetchData.ts` - fetches new data every 2 hours
   - `analyzeMessages.ts` - analyzes messages every 2 hours
   - `refetchUnresolved.ts` - updates unresolved conversations
3. ✅ **Ready for analytics**: Connect Metabase and build dashboards!

---

## Full Documentation

See `README-BACKFILL.md` for detailed information.

---

## Quick Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `BATCH_SIZE` | 50 | Conversations per batch |
| `RATE_LIMIT_DELAY` | 1000ms | Delay between API calls |
| `BATCH_DELAY` | 5000ms | Delay between batches |
| `VERBOSE_LOG` | 0 | Set to 1 for detailed logs |

**Just run it!** 🚀

```bash
npm run backfill:run
```

