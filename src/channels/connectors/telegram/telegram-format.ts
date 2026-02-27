/**
 * Telegram MarkdownV2 format conversion utilities.
 *
 * Converts standard Markdown input into Telegram's MarkdownV2 format, which
 * has strict escaping requirements: every special character outside of
 * formatting constructs must be preceded by a backslash.
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * All characters that must be escaped in Telegram MarkdownV2 plain text.
 * This is the full set from the API docs.
 */
const TELEGRAM_SPECIAL_CHARS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

/**
 * Escape a plain text string for safe use inside Telegram MarkdownV2.
 *
 * All characters that Telegram MarkdownV2 treats as special are preceded
 * by a backslash. Apply this to text fragments that should be rendered as
 * literal characters, not as formatting.
 *
 * @param text - Plain text fragment to escape.
 * @returns The escaped string.
 */
export function telegramEscape(text: string): string {
  return text.replace(TELEGRAM_SPECIAL_CHARS, '\\$1');
}

// ---------------------------------------------------------------------------
// Markdown to Telegram MarkdownV2 conversion
// ---------------------------------------------------------------------------

/**
 * Convert a standard Markdown string to Telegram MarkdownV2 format.
 *
 * Handles the following Markdown constructs:
 * - Fenced code blocks (``` ... ```) — rendered as MarkdownV2 ```code``` blocks
 * - Inline code (`code`) — rendered as MarkdownV2 `code`
 * - Bold (**text** or __text__) — rendered as *text*
 * - Italic (*text* or _text_) — rendered as _text_
 * - Strikethrough (~~text~~) — rendered as ~text~
 * - Inline links [label](url) — rendered as [label](url) with proper escaping
 * - Headings (# text) — rendered as *bold text* (Telegram has no headings)
 * - Plain text — escaped to prevent accidental formatting
 *
 * @param markdown - Standard Markdown input.
 * @returns Telegram MarkdownV2 formatted string.
 */
export function markdownToTelegram(markdown: string): string {
  // Process the input segment by segment. We handle fenced code blocks and
  // inline code first (before any other escaping) to avoid double-escaping
  // their content. Then we process formatting markers on normal text.

  let result = '';
  let remaining = markdown;

  while (remaining.length > 0) {
    // --- Fenced code block ---
    const fenceMatch = remaining.match(/^(```(?:\w*)\n)([\s\S]*?)(^```)/m);
    if (fenceMatch && fenceMatch.index === 0) {
      const lang = fenceMatch[1].slice(3).trimEnd().replace(/\n$/, '');
      const code = fenceMatch[2];
      // Telegram MarkdownV2: ```[lang]\ncontent\n```
      // The language tag and content must not be escaped with backslash
      // (Telegram handles code blocks verbatim).
      result += '```' + lang + '\n' + code + '```';
      remaining = remaining.slice(fenceMatch[0].length);
      continue;
    }

    // --- Fenced code block (tilde variant) ---
    const tildeFenceMatch = remaining.match(/^(~~~(?:\w*)\n)([\s\S]*?)(^~~~)/m);
    if (tildeFenceMatch && tildeFenceMatch.index === 0) {
      const lang = tildeFenceMatch[1].slice(3).trimEnd().replace(/\n$/, '');
      const code = tildeFenceMatch[2];
      result += '```' + lang + '\n' + code + '```';
      remaining = remaining.slice(tildeFenceMatch[0].length);
      continue;
    }

    // Find the next special construct to determine where plain text ends.
    const nextSpecial = findNextSpecial(remaining);

    if (nextSpecial === null) {
      // Rest of input is plain text — escape it and done.
      result += telegramEscape(remaining);
      break;
    }

    // Append any plain text that precedes this construct.
    if (nextSpecial.index > 0) {
      result += telegramEscape(remaining.slice(0, nextSpecial.index));
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
  /** Telegram MarkdownV2 representation. */
  formatted: string;
}

/**
 * Search `text` for the first Markdown formatting construct and return
 * information needed to process it. Returns null if no construct is found.
 *
 * Constructs checked (in order of precedence):
 * 1. Fenced code block  ``` ... ```
 * 2. Inline code        `code`
 * 3. Bold+italic        ***text***
 * 4. Bold               **text** or __text__
 * 5. Italic             *text* or _text_
 * 6. Strikethrough      ~~text~~
 * 7. Inline link        [label](url)
 * 8. Image              ![alt](url)  — rendered as alt text only
 * 9. ATX heading        # text
 */
function findNextSpecial(text: string): SpecialConstruct | null {
  const candidates: Array<SpecialConstruct | null> = [
    matchFencedCode(text),
    matchInlineCode(text),
    matchBoldItalic(text),
    matchBold(text),
    matchItalic(text),
    matchStrikethrough(text),
    matchLink(text),
    matchImage(text),
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
  // We only match at non-zero indices here (index 0 is handled in main loop).
  const re = /```(?:\w*)\n[\s\S]*?^```/gm;
  const m = re.exec(text);
  if (!m) return null;

  const lang = m[0].match(/^```(\w*)/)?.[1] ?? '';
  const body = m[0].slice(3 + lang.length + 1, m[0].length - 3); // content between opening ``` and closing ```
  return {
    index: m.index,
    length: m[0].length,
    formatted: '```' + lang + '\n' + body + '```',
  };
}

function matchInlineCode(text: string): SpecialConstruct | null {
  const re = /`([^`\n]+)`/g;
  const m = re.exec(text);
  if (!m) return null;
  // Inline code content does not need MarkdownV2 escaping.
  return {
    index: m.index,
    length: m[0].length,
    formatted: '`' + m[1] + '`',
  };
}

function matchBoldItalic(text: string): SpecialConstruct | null {
  const re = /\*{3}([^*]+)\*{3}/g;
  const m = re.exec(text);
  if (!m) return null;
  // Bold italic in MarkdownV2: ***text*** — wrap content in *_ ... _*
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*_' + telegramEscape(m[1]) + '_*',
  };
}

function matchBold(text: string): SpecialConstruct | null {
  // **text** or __text__
  const re = /(\*{2}|_{2})([^*_\n]+)\1/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + telegramEscape(m[2]) + '*',
  };
}

function matchItalic(text: string): SpecialConstruct | null {
  // *text* (single asterisk) or _text_ (single underscore)
  // Avoid matching ** or __ by requiring non-* and non-_ boundaries.
  const re = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)|(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
  const m = re.exec(text);
  if (!m) return null;
  const inner = m[1] ?? m[2];
  return {
    index: m.index,
    length: m[0].length,
    formatted: '_' + telegramEscape(inner) + '_',
  };
}

function matchStrikethrough(text: string): SpecialConstruct | null {
  const re = /~~([^~\n]+)~~/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '~' + telegramEscape(m[1]) + '~',
  };
}

function matchLink(text: string): SpecialConstruct | null {
  // [label](url) — exclude image syntax by requiring no preceding !
  const re = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  const m = re.exec(text);
  if (!m) return null;
  const label = telegramEscape(m[1]);
  // URLs in Telegram MarkdownV2 inline links need only ) escaped.
  const url = m[2].replace(/\)/g, '\\)');
  return {
    index: m.index,
    length: m[0].length,
    formatted: '[' + label + '](' + url + ')',
  };
}

function matchImage(text: string): SpecialConstruct | null {
  // ![alt](url) — Telegram can't embed images via MarkdownV2, render as alt text.
  const re = /!\[([^\]]*)\]\([^)]+\)/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    // Render alt text as italic fallback.
    formatted: m[1] ? '_' + telegramEscape(m[1]) + '_' : '',
  };
}

function matchHeading(text: string): SpecialConstruct | null {
  // ATX heading: # text or ## text etc. at start of a line.
  const re = /^#{1,6}\s+(.+)$/m;
  const m = re.exec(text);
  if (!m) return null;
  // Render headings as bold text.
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + telegramEscape(m[1]) + '*',
  };
}
