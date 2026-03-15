# Grocery check

Weekly check-in for grocery ordering. Use memory to personalize suggestions.

<!-- Why: Automating the "what do we need this week" question saves time and
     reduces forgotten items. The agent learns your preferences over time
     through memory. Adapt this to your local grocery service. -->

<!-- Schedule: weekly before your usual order day, e.g. "0 18 * * 0" -->

## Steps

1. **Check memory** -- Look up grocery preferences, order history, and any recent grocery-related conversations.

2. **Check current cart** -- If your grocery service has an API/tool, check if there's already a cart in progress.

3. **Check delivery slots** -- See what's available for the coming days.

4. **Suggest an order** -- Based on:
   - Known preferences and staples from memory
   - Time since last order
   - Any specific requests from recent conversations

5. **Ask for confirmation** -- Do not auto-order. Present the suggestion and ask if you want to proceed.

## Format

```
## Grocery check

**Last order**: [date, if known from memory]
**Delivery slots**: [next available]

**Suggested items** (based on your usual order):
- [Item 1]
- [Item 2]
- ...

Want me to add these to the cart?
```
