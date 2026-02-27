/**
 * Slack mrkdwn format conversion utilities.
 *
 * Converts standard Markdown input into Slack's mrkdwn format.
 * Slack's mrkdwn is similar to Markdown but with important differences:
 * - Bold: *text* (single asterisk, not double)
 * - Italic: _text_ (underscore)
 * - Strikethrough: ~text~ (single tilde, not double)
 * - Inline links: <url|label>
 * - No heading support — use bold as fallback
 * - Code blocks don't support language hints
 *
 * Reference: https://api.slack.com/reference/surfaces/formatting
 */

// ---------------------------------------------------------------------------
// Markdown to Slack mrkdwn conversion
// ---------------------------------------------------------------------------

/**
 * Convert a standard Markdown string to Slack mrkdwn format.
 *
 * Handles the following Markdown constructs:
 * - Fenced code blocks (``` ... ```) — rendered as ``` code ``` (no lang hint)
 * - Inline code (`code`) — preserved as-is (same syntax)
 * - Bold (**text** or __text__) — rendered as *text*
 * - Italic (*text* or _text_) — rendered as _text_
 * - Strikethrough (~~text~~) — rendered as ~text~
 * - Inline links [label](url) — rendered as <url|label>
 * - Headings (# text) — rendered as *text* (bold fallback)
 * - Plain text — preserved as-is (Slack does not require special escaping)
 * - Lists — preserved as-is
 *
 * @param markdown - Standard Markdown input.
 * @returns Slack mrkdwn formatted string.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  // Process the input segment by segment. We handle fenced code blocks and
  // inline code first (before any other processing) to avoid transforming
  // content inside code spans.

  let result = '';
  let remaining = markdown;

  while (remaining.length > 0) {
    // --- Fenced code block (backtick variant) ---
    const fenceMatch = remaining.match(/^```(?:\w*)\n([\s\S]*?)^```/m);
    if (fenceMatch && fenceMatch.index === 0) {
      const code = fenceMatch[1];
      // Slack doesn't support language hints in code blocks; strip them.
      result += '```\n' + code + '```';
      remaining = remaining.slice(fenceMatch[0].length);
      continue;
    }

    // --- Fenced code block (tilde variant) ---
    const tildeFenceMatch = remaining.match(/^~~~(?:\w*)\n([\s\S]*?)^~~~/m);
    if (tildeFenceMatch && tildeFenceMatch.index === 0) {
      const code = tildeFenceMatch[1];
      result += '```\n' + code + '```';
      remaining = remaining.slice(tildeFenceMatch[0].length);
      continue;
    }

    // Find the next special construct to determine where plain text ends.
    const nextSpecial = findNextSpecial(remaining);

    if (nextSpecial === null) {
      // Rest of input is plain text — pass through as-is.
      result += remaining;
      break;
    }

    // Append any plain text that precedes this construct.
    if (nextSpecial.index > 0) {
      result += remaining.slice(0, nextSpecial.index);
    }

    result += nextSpecial.formatted;
    remaining = remaining.slice(nextSpecial.index + nextSpecial.length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SpecialConstruct {
  /** Offset in the input string where the construct starts. */
  index: number;
  /** Number of characters consumed from the input. */
  length: number;
  /** Slack mrkdwn representation. */
  formatted: string;
}

/**
 * Search `text` for the first Markdown formatting construct and return
 * information needed to process it. Returns null if no construct is found.
 *
 * Constructs checked (in order of precedence):
 * 1. Fenced code block  ``` ... ```
 * 2. Inline code        `code`
 * 3. Bold               **text** or __text__
 * 4. Italic             *text* or _text_
 * 5. Strikethrough      ~~text~~
 * 6. Inline link        [label](url)
 * 7. ATX heading        # text
 */
function findNextSpecial(text: string): SpecialConstruct | null {
  const candidates: Array<SpecialConstruct | null> = [
    matchFencedCode(text),
    matchInlineCode(text),
    matchBold(text),
    matchItalic(text),
    matchStrikethrough(text),
    matchLink(text),
    matchHeading(text),
  ];

  // Pick the candidate with the smallest index (earliest in the string).
  let best: SpecialConstruct | null = null;
  for (const c of candidates) {
    if (c === null) continue;
    if (best === null || c.index < best.index) {
      best = c;
    }
  }
  return best;
}

function matchFencedCode(text: string): SpecialConstruct | null {
  // Match fenced code blocks at any position (not just index 0 — that's handled
  // in the main loop).
  const re = /```(?:\w*)\n[\s\S]*?^```/gm;
  const m = re.exec(text);
  if (!m) return null;

  // Extract content between opening ``` (with optional lang) and closing ```.
  const openingLine = m[0].match(/^```(\w*)\n/);
  const langLen = openingLine ? openingLine[1].length : 0;
  // Skip: ``` + lang + \n at start, and ``` at end.
  const code = m[0].slice(3 + langLen + 1, m[0].length - 3);

  return {
    index: m.index,
    length: m[0].length,
    formatted: '```\n' + code + '```',
  };
}

function matchInlineCode(text: string): SpecialConstruct | null {
  const re = /`([^`\n]+)`/g;
  const m = re.exec(text);
  if (!m) return null;
  // Inline code is the same syntax in Slack mrkdwn — pass through.
  return {
    index: m.index,
    length: m[0].length,
    formatted: '`' + m[1] + '`',
  };
}

function matchBold(text: string): SpecialConstruct | null {
  // **text** or __text__ — Slack bold is *text*
  const re = /(\*{2}|_{2})([^*_\n]+)\1/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + m[2] + '*',
  };
}

function matchItalic(text: string): SpecialConstruct | null {
  // *text* (single asterisk) or _text_ (single underscore) — Slack italic is _text_
  // Avoid matching ** or __ by requiring non-* and non-_ boundaries.
  const re = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)|(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
  const m = re.exec(text);
  if (!m) return null;
  const inner = m[1] ?? m[2];
  return {
    index: m.index,
    length: m[0].length,
    formatted: '_' + inner + '_',
  };
}

function matchStrikethrough(text: string): SpecialConstruct | null {
  // ~~text~~ — Slack strikethrough is ~text~
  const re = /~~([^~\n]+)~~/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '~' + m[1] + '~',
  };
}

function matchLink(text: string): SpecialConstruct | null {
  // [label](url) — Slack format is <url|label>
  // Exclude image syntax by requiring no preceding !
  const re = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  const m = re.exec(text);
  if (!m) return null;
  const label = m[1];
  const url = m[2];
  return {
    index: m.index,
    length: m[0].length,
    formatted: '<' + url + '|' + label + '>',
  };
}

function matchHeading(text: string): SpecialConstruct | null {
  // ATX heading: # text or ## text etc. at start of a line.
  // Slack has no native headings — render as bold.
  const re = /^#{1,6}\s+(.+)$/m;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + m[1] + '*',
  };
}
