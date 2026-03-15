# Meeting preparation

Prepare a context brief for an upcoming meeting. Deliver at least 15 minutes before the meeting starts.

<!-- Why: Walking into a meeting cold wastes everyone's time. This prompt pulls
     context from every connected system so you have the full picture before
     the meeting starts. Best used auto-scheduled by the morning briefing. -->

<!-- Schedule: not directly scheduled. The morning briefing creates a schedule
     for each meeting 30 minutes before start time. -->

## Steps

1. **Identify the meeting** -- Get details from Calendar: attendees, agenda, description, linked docs.

2. **Pull context from connected systems**:
   - **Wiki/docs**: Search for pages related to the meeting topic or project. Check recent updates.
   - **Issue tracker**: Find relevant tickets -- sprint status, blockers, recent transitions. Check open tickets involving attendees.
   - **Notes**: Search your notes for previous sessions on this topic (use `file-searcher` sub-agent).
   - **Email**: Recent threads with attendees or about the meeting topic.
   - **Memory**: Check for stored context about attendees, project state, past decisions.

3. **Synthesize** into a prep brief:
   - What this meeting is about (1-2 sentences)
   - Key context you need (decisions pending, blockers, recent changes)
   - Your open items related to this topic
   - Suggested talking points or questions
   - Any cross-system connections (e.g. "The RFC updated yesterday covers the same topic as TICKET-1234")

## Format

```
## Prep: [Meeting Title] -- [Time]

**About**: [1-2 sentence summary]

**Key context**:
- [Decision pending / blocker / recent change]
- [Relevant ticket status]
- [Doc/wiki page updated]

**Your open items**:
- [Related tasks/tickets]

**Suggested talking points**:
- [Question or topic to raise]
```
