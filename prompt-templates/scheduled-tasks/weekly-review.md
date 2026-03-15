# Weekly review

End-of-week review of the past week. Surface forgotten items, stale tickets, and unresolved threads.

<!-- Why: Things slip through the cracks every week. This prompt cross-references
     across systems to find stale tickets, unactioned meeting items, and deferred
     decisions before they become problems. -->

<!-- Schedule: Friday afternoon, e.g. "0 16 * * 5" -->

## Steps

1. **Open threads** -- Check memory for unresolved items, decisions that were deferred, things you said you'd get back to.

2. **Stale tickets** -- Query your issue tracker for assigned tickets that haven't been updated in >2 weeks.

3. **Meeting follow-ups** -- Cross-reference this week's meetings (from calendar) with your issue tracker and notes. Flag anything discussed in a meeting that was never ticketed or actioned.

4. **PR status** -- Any open PRs that have been sitting without review.

5. **Patterns spotted** -- Note any recurring themes from the week (repeated blockers, topics that keep coming up, energy drains).

6. **Store insights** -- Save any notable patterns or observations to memory for future context.

## Format

```
## Weekly review -- Week [N]

### Forgotten items
- [Things that slipped through the cracks]

### Stale tickets
- [TICKET-123: title -- last updated X days ago]

### Unactioned meeting items
- [Topic discussed in [meeting] but no ticket/follow-up created]

### Open PRs
- [PR title -- waiting X days]

### Patterns this week
- [Observations worth noting]
```
