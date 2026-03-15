# Morning briefing

Compile and deliver a daily briefing. Be compact and scannable -- lead with what needs action.

<!-- Why: Starting the day with a compiled view of calendar, messages, and tasks
     saves 15-20 minutes of manual checking across systems. The meeting prep
     auto-scheduling means you walk into every meeting with context already pulled. -->

<!-- Schedule: weekdays at your preferred start time, e.g. "0 7 * * 1-5" -->

## Steps

1. **Calendar** -- List today's meetings with times, attendees, and linked docs. Check all configured calendars.

2. **Email** -- Scan unread messages. Flag anything urgent or requiring a response. Skip newsletters and automated notifications.

3. **Issue tracker** -- Check assigned tickets: status changes, new comments, approaching deadlines.

4. **Code review** -- PR reviews requested, CI failures on owned repos.

5. **Focus windows** -- Identify gaps between meetings >= 90 minutes. These are deep work opportunities -- call them out.

## Meeting prep scheduling

After compiling the briefing, create a scheduled task for each meeting today:
- Schedule each 30 minutes before the meeting start time
- Use `promptFile: "meeting-prep"` for each
- Include the meeting title and time in the task label
- Clean up any expired meeting prep schedules from yesterday

## Format

```
## Good morning -- [Day, Date]

### Today's schedule
[Meetings with times, attendees, key context]

### Needs attention
[Urgent emails, ticket updates, PR reviews]

### Focus windows
[Time blocks >= 90min with no meetings]
```
