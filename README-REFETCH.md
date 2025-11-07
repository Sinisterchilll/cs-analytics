# Refetch Unresolved Conversations

## Overview

This system refetches all unresolved conversations to capture their resolution timestamps accurately. It runs on a separate schedule from the main data fetch.

## Schedule

### Main Fetch (fetchData.ts)
- **Schedule**: Every 2 hours at :00 (00:00, 02:00, 04:00, etc.)
- **Purpose**: Fetch new users, conversations, and messages from the last 2 hours
- **Duration**: ~5-10 minutes per run
- **Workflow**: `.github/workflows/fetch-every-2-hours.yml`

### Refetch Unresolved (refetchUnresolved.ts)
- **Schedule**: Every 2 hours at :30 (00:30, 02:30, 04:30, etc.)
- **Purpose**: Check all unresolved conversations for status updates
- **Duration**: ~30-45 minutes per run (depends on volume)
- **Workflow**: `.github/workflows/refetch-unresolved.yml`

## How It Works

### 1. Main Fetch (Every 2 hours at :00)
```
00:00 → Fetch new/updated data from Freshchat
        ├─ Users updated in last 2 hours
        ├─ Their conversations
        └─ Messages in those conversations
```

### 2. Refetch Unresolved (30 minutes later at :30)
```
00:30 → Refetch ALL unresolved conversations
        ├─ Query DB for conversations where status != 'resolved'
        ├─ Fetch latest state from Freshchat API
        ├─ Update status and updated_time if changed
        └─ Log resolved conversations with timestamp
```

## Configuration

### Age Limits
- **MAX_AGE_DAYS**: 30 days (configurable in `refetchUnresolved.ts`)
  - Only checks conversations created within the last 30 days
  - Older conversations are considered abandoned

### Rate Limiting
- **300ms delay** between API calls
- **500ms delay** on errors
- **Exponential backoff** on 429 (rate limit) errors

### Progress Logging
- Logs progress every 50 conversations
- Final summary includes:
  - Total conversations checked
  - Number resolved
  - Number updated
  - Errors encountered
  - Still unresolved count

## Running Locally

### Run Main Fetch
```bash
npm run fetch:run
```

### Run Refetch Unresolved
```bash
npm run refetch:run
```

### Run with Verbose Logging
```bash
VERBOSE_LOG=1 npm run refetch:run
```

## GitHub Actions

### Workflows

1. **fetch-every-2-hours.yml**
   - Runs at: `0 */2 * * *` (every 2 hours at :00)
   - Fetches new/updated data

2. **refetch-unresolved.yml** (NEW)
   - Runs at: `30 */2 * * *` (every 2 hours at :30)
   - Refetches unresolved conversations

3. **analyze-messages.yml**
   - Runs at: `20 */2 * * *` (every 2 hours at :20)
   - Analyzes user messages with LLM

### Manual Trigger

You can manually trigger any workflow from GitHub Actions UI using the "workflow_dispatch" option.

## Expected Performance

### For 350 Conversations/Day

| Metric | Value |
|--------|-------|
| Unresolved conversations | ~350 (varies) |
| Refetch cycles per day | 12 |
| API calls per cycle | ~350 |
| Total API calls per day | ~4,200 |
| Time per cycle | ~30-45 minutes |
| Resolution detection delay | Max 2 hours |

## Benefits

✅ **Accurate Resolution Timestamps**: Captures exact time when conversations are resolved  
✅ **Comprehensive Coverage**: Checks ALL unresolved conversations, not just recent ones  
✅ **Separate Schedule**: Runs independently from main fetch, no overlap  
✅ **30-minute Delay**: Gives conversations time to potentially resolve after being fetched  
✅ **Rate-Limited**: Respects API limits with throttling and backoff  
✅ **Progress Tracking**: Detailed logging for monitoring  

## Monitoring

### Success Indicators
- `[Refetch] Found X unresolved conversations to check`
- `[Refetch] Progress: X/Y checked, Z resolved, W updated`
- `[Refetch] Completed. Summary: {...}`

### Error Indicators
- `[Refetch] Error fetching unresolved conversations`
- `[Refetch] Failed to refetch conversation X`
- High error count in final summary

## Database Schema

The refetch updates the `Conversation` table:

```sql
CREATE TABLE "Conversation" (
  id TEXT PRIMARY KEY,
  userid TEXT NOT NULL,
  status TEXT NOT NULL,           -- Updated when resolved
  channel_id TEXT NOT NULL,
  created_time TIMESTAMPTZ NOT NULL,
  updated_time TIMESTAMPTZ NOT NULL,  -- Updated with resolution timestamp
  assigned_to TEXT NOT NULL,
  custom_properties JSONB NOT NULL
);
```

## Troubleshooting

### Issue: Too many unresolved conversations
**Solution**: Adjust `MAX_AGE_DAYS` to exclude older conversations

### Issue: Rate limit errors (429)
**Solution**: Increase `sleep()` delay between API calls

### Issue: Taking too long
**Solution**: Add a limit to the query (e.g., `.limit(500)`)

### Issue: Missing resolutions
**Solution**: Check if conversations are older than `MAX_AGE_DAYS`

## Future Enhancements

- Add batch processing for large volumes
- Implement priority queue (check recently updated first)
- Add metrics tracking (avg resolution time, etc.)
- Email notifications for long-unresolved conversations

