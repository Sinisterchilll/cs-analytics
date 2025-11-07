# Updated Deployment Guide

## ✅ Changes Made

All three scripts now **run once and exit** immediately after completion. This is perfect for GitHub Actions scheduled workflows.

### Modified Scripts

1. **`fetchData.ts`**
   - ✅ Removed `node-cron` scheduling
   - ✅ Runs once and exits with `process.exit(0)` on success
   - ✅ Exits with `process.exit(1)` on error

2. **`analyzeMessages.ts`**
   - ✅ Already configured to exit after completion
   - ✅ No changes needed

3. **`refetchUnresolved.ts`**
   - ✅ Already configured to exit after completion
   - ✅ No changes needed

4. **`package.json`**
   - ✅ Removed `node-cron` dependency (no longer needed)
   - ✅ Removed `@types/node-cron` dev dependency

---

## 🚀 How It Works Now

### Local Testing
Each script runs once and exits:

```bash
# Fetch data - runs once and exits
npm run fetch:run

# Refetch unresolved - runs once and exits
npm run refetch:run

# Analyze messages - runs once and exits
npm run analyze:run
```

### GitHub Actions
GitHub Actions handles the scheduling:

| Workflow | Schedule | Script |
|----------|----------|--------|
| **Fetch Data** | `0 */2 * * *` (every 2h at :00) | `fetchData.ts` |
| **Analyze Messages** | `20 */2 * * *` (every 2h at :20) | `analyzeMessages.ts` |
| **Refetch Unresolved** | `30 */2 * * *` (every 2h at :30) | `refetchUnresolved.ts` |

---

## 📋 Deployment Steps

### 1. Install Dependencies (if needed)

Since we removed `node-cron`, run:

```bash
npm install
```

This will update your `node_modules` to remove the unused dependencies.

### 2. Test Locally

Test each script to ensure it runs and exits properly:

```bash
# Test fetch
npm run fetch:run
# Should see: "=== Fetch Cycle Complete ===" and exit

# Test refetch
npm run refetch:run
# Should see: "=== Refetch Complete ===" and exit

# Test analyze
npm run analyze:run
# Should see: "--- Analysis complete ---" and exit
```

### 3. Commit and Push

```bash
git add .
git commit -m "Update scripts to run once and exit (remove cron scheduling)"
git push origin main
```

### 4. Verify GitHub Actions

1. Go to your GitHub repository
2. Navigate to **Actions** tab
3. You should see 3 workflows:
   - ✅ Freshchat fetch every 2 hours
   - ✅ Analyze Messages
   - ✅ Refetch Unresolved Conversations

4. Manually trigger one to test:
   - Click on a workflow
   - Click **"Run workflow"**
   - Select branch: `main`
   - Click **"Run workflow"**

5. Watch the logs - it should:
   - ✅ Run the script
   - ✅ Complete successfully
   - ✅ Exit (workflow shows as complete)

---

## 🎯 Expected Behavior

### ✅ Success Case
```
=== Fetch Cycle Start ===
[Fetch] Starting window ...
[Fetch] Users updated in last 2h: 5
[Fetch] Completed. Summary: {...}
=== Fetch Cycle Complete ===
Process exited with code 0
```

### ❌ Error Case
```
=== Fetch Cycle Start ===
[Fetch] Starting window ...
Fetch cycle failed: Connection timeout
Process exited with code 1
```

GitHub Actions will:
- ✅ Mark workflow as **successful** (green ✓) if exit code is 0
- ❌ Mark workflow as **failed** (red ✗) if exit code is 1

---

## 📊 Timeline (Every 2 Hours)

```
00:00 → Fetch new data (5-10 min) → Exit
00:20 → Analyze messages (2-5 min) → Exit
00:30 → Refetch unresolved (30-45 min) → Exit

02:00 → Fetch new data → Exit
02:20 → Analyze messages → Exit
02:30 → Refetch unresolved → Exit

... (continues every 2 hours)
```

---

## 🔧 Troubleshooting

### Issue: Script hangs and doesn't exit
**Cause**: Database connection or API call not closing properly
**Fix**: Check logs for stuck operations, ensure all async operations complete

### Issue: GitHub Action shows "cancelled"
**Cause**: Workflow timeout (default 6 hours)
**Fix**: If refetch takes too long, add a limit:
```typescript
.limit(500) // in refetchUnresolved.ts query
```

### Issue: Exit code 1 but no error shown
**Cause**: Unhandled promise rejection
**Fix**: Check logs for stack traces, ensure all errors are caught

---

## ✨ Benefits of This Approach

✅ **Clean execution**: Each run is independent  
✅ **Proper exit codes**: GitHub Actions knows if workflow succeeded/failed  
✅ **No hanging processes**: Scripts exit immediately after completion  
✅ **Resource efficient**: No idle processes waiting for next cron  
✅ **Easy to test**: Run locally and see immediate results  
✅ **GitHub Actions native**: Let GitHub handle scheduling, not your code  

---

## 🎉 You're All Set!

Your scripts are now optimized for GitHub Actions. Each workflow will:
1. Start on schedule
2. Run the script once
3. Exit with success/failure code
4. GitHub Actions logs the result
5. Repeat on next schedule

No more hanging processes! 🚀


