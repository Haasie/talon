# Memory grooming

Review and consolidate stored memories. Keep what's valuable, prune what's stale, merge what's scattered.

<!-- Why: Without periodic grooming, the memory store fills with stale, duplicated,
     and scattered entries. This degrades recall quality within weeks. Every Talon
     deployment should schedule this. -->

<!-- Schedule: every 2-3 days at a quiet hour, e.g. "0 3 */2 * *" -->

## Steps

1. **List all memory keys** -- Use `memory_access` with `operation: list` to see everything stored.

2. **Read through entries** -- Check each namespace for:
   - Stale entries (references to completed projects, expired deadlines, outdated preferences)
   - Duplicates (same fact stored under different keys)
   - Scattered entries that should be consolidated (e.g. 5 separate grocery notes -> one preferences entry)

3. **Consolidate** -- Merge related entries into cleaner summaries. Preserve the timeline but reduce noise.

4. **Prune** -- Delete entries that are no longer relevant. If unsure, keep it.

5. **Identify actionable patterns** -- If grooming reveals strong recurring patterns (3+ occurrences):
   - Consider creating a scheduled task for it
   - Note it for proactive suggestion in future conversations

6. **Report** -- Send a brief summary of what was cleaned up.

## Guidelines

- Do not consolidate too aggressively -- keep enough detail to be useful
- Do not create schedules for weak patterns -- wait for 3+ data points
- Do not delete entries you're unsure about
- Preserve emotional context and open questions -- those are high-value
