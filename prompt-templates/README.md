# Prompt templates

Ready-to-use task prompts for Talon personas. Copy what you need into `personas/<name>/prompts/` and adapt to your setup.

## scheduled-tasks/

| Prompt | Schedule | What it does |
|--------|----------|-------------|
| `memory-grooming.md` | Every 2-3 days | Prunes stale/duplicate memory entries. **Required for long-term health.** |
| `morning-briefing.md` | Weekday mornings | Calendar, email, tickets, PRs, focus windows. Auto-schedules meeting prep. |
| `end-of-day-summary.md` | Weekday evenings | Recap of the day, open items, tomorrow preview. |
| `weekly-review.md` | Friday afternoon | Stale tickets, forgotten follow-ups, unactioned meeting items. |
| `week-planning.md` | Sunday evening | Full week overview grouped by day with focus/heavy day flags. |
| `meeting-prep.md` | Auto-scheduled | Context brief from all systems, delivered before each meeting. |
| `grocery-check.md` | Weekly | Grocery order suggestions from memory. Adapt to your service. |

Each template has an HTML comment at the top explaining why it exists and a suggested cron expression. The prompts reference generic tools (calendar, issue tracker, email) rather than specific products. Replace with your actual tool names.

To schedule a prompt:

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel my-telegram \
  --cron "0 7 * * 1-5" \
  --label "Morning briefing" \
  --prompt "Run the morning-briefing task prompt"
```
