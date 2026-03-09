/**
 * Email HTML format conversion utilities.
 *
 * Converts standard Markdown input into HTML suitable for email clients.
 * No external dependencies — entirely hand-rolled using regex-based parsing.
 *
 * Handles fenced code blocks first to avoid double-processing their contents,
 * then processes inline and block-level Markdown constructs.
 */

// ---------------------------------------------------------------------------
// HTML entity escaping
// ---------------------------------------------------------------------------

/**
 * Escape a plain text string for safe embedding in HTML.
 *
 * Replaces the five characters that have special meaning in HTML with their
 * named character references.
 *
 * @param text - Raw plain text to escape.
 * @returns HTML-safe string.
 */
export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Markdown-to-HTML conversion
// ---------------------------------------------------------------------------

/**
 * Convert a standard Markdown string to HTML for email delivery.
 *
 * Handles the following Markdown constructs:
 * - Fenced code blocks (``` ... ```) — rendered as `<pre><code>`
 * - Headings (#, ##, …, ######) — rendered as `<h1>` … `<h6>`
 * - Bold+italic (***text***) — rendered as `<strong><em>`
 * - Bold (**text** or __text__) — rendered as `<strong>`
 * - Italic (*text* or _text_) — rendered as `<em>`
 * - Strikethrough (~~text~~) — rendered as `<del>`
 * - Inline code (`code`) — rendered as `<code>`
 * - Images (![alt](url)) — rendered as `<img>`
 * - Links ([label](url)) — rendered as `<a href>`
 * - Paragraphs separated by blank lines — wrapped in `<p>`
 * - Hard line breaks (trailing two spaces + newline) — rendered as `<br>`
 * - Plain text is HTML-escaped to prevent injection
 *
 * @param markdown - Standard Markdown input.
 * @returns HTML string.
 */
export function markdownToHtml(markdown: string): string {
  // Split the input into blocks separated by fenced code fences.
  // We process fenced code blocks in a first pass to avoid applying inline
  // formatting rules inside code content.
  const segments = splitOnFencedCode(markdown);

  let html = '';
  for (const seg of segments) {
    if (seg.type === 'code') {
      const langAttr = seg.lang ? ` class="language-${htmlEscape(seg.lang)}"` : '';
      html += `<pre><code${langAttr}>${htmlEscape(seg.content)}</code></pre>\n`;
    } else {
      html += processText(seg.content);
    }
  }

  return html.trim();
}

// ---------------------------------------------------------------------------
// Internal: fenced code block splitting
// ---------------------------------------------------------------------------

interface TextSegment {
  type: 'text';
  content: string;
}

interface CodeSegment {
  type: 'code';
  lang: string;
  content: string;
}

type Segment = TextSegment | CodeSegment;

/**
 * Split the input Markdown into alternating text and fenced-code segments.
 * This prevents inline formatting from being applied inside code blocks.
 */
function splitOnFencedCode(input: string): Segment[] {
  const segments: Segment[] = [];
  // Matches ``` (with optional language) ... ``` fenced blocks.
  const fenceRe = /^(`{3,})(\w*)\n([\s\S]*?)^\1\s*$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(input)) !== null) {
    // Text before the code block.
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: input.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', lang: match[2] ?? '', content: match[3] ?? '' });
    lastIndex = match.index + match[0].length;
  }

  // Any remaining text after the last code block.
  if (lastIndex < input.length) {
    segments.push({ type: 'text', content: input.slice(lastIndex) });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Internal: block-level and inline text processing
// ---------------------------------------------------------------------------

/**
 * Process a non-code text segment: split into paragraphs, apply heading
 * detection, then apply inline formatting to each paragraph.
 */
function processText(text: string): string {
  // Normalise line endings.
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split on blank lines to identify paragraph boundaries.
  const paragraphs = normalised.split(/\n{2,}/);

  let html = '';
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed === '') continue;

    const headingResult = tryHeading(trimmed);
    if (headingResult !== null) {
      html += headingResult + '\n';
    } else {
      // Apply inline formatting and wrap in <p>.
      const inlined = applyInlineFormatting(trimmed);
      html += `<p>${inlined}</p>\n`;
    }
  }

  return html;
}

/**
 * Attempt to parse the paragraph as an ATX heading.
 * Returns the HTML heading string if it matches, or null otherwise.
 */
function tryHeading(para: string): string | null {
  const m = para.match(/^(#{1,6})\s+(.+)$/);
  if (!m) return null;
  const level = m[1].length;
  const content = applyInlineFormatting(m[2].trimEnd());
  return `<h${level}>${content}</h${level}>`;
}

/**
 * Apply all inline Markdown formatting rules to a single line / paragraph of
 * non-heading text. Processing order follows decreasing specificity so that
 * e.g. `***` is matched before `**`.
 */
function applyInlineFormatting(text: string): string {
  // Process segment by segment, extracting formatted constructs greedily.
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    const next = findNextInlineConstruct(remaining);
    if (next === null) {
      // Remainder is plain text — escape and append.
      result += escapeAndBreak(remaining);
      break;
    }

    // Plain text before the construct.
    if (next.index > 0) {
      result += escapeAndBreak(remaining.slice(0, next.index));
    }

    result += next.html;
    remaining = remaining.slice(next.index + next.length);
  }

  return result;
}

/**
 * Escape plain text for HTML, converting trailing double-space newlines to
 * `<br>` and escaping HTML special characters.
 *
 * We split on the hard-break marker `  \n` so that the `<br>` literal we
 * insert is not re-escaped, then HTML-escape each plain-text fragment.
 */
function escapeAndBreak(text: string): string {
  // Split on hard line breaks (two trailing spaces + newline).
  const parts = text.split(/ {2}\n/);
  return parts.map((part) => htmlEscape(part)).join('<br>\n');
}

// ---------------------------------------------------------------------------
// Internal: inline construct matching
// ---------------------------------------------------------------------------

interface InlineConstruct {
  /** Byte offset in the input string where the construct starts. */
  index: number;
  /** Number of characters consumed from the input. */
  length: number;
  /** Resulting HTML. */
  html: string;
}

/**
 * Scan `text` for the earliest inline Markdown construct and return metadata
 * needed to process it. Returns null if no construct is found.
 */
function findNextInlineConstruct(text: string): InlineConstruct | null {
  const candidates: Array<InlineConstruct | null> = [
    matchInlineCode(text),
    matchImage(text),
    matchLink(text),
    matchBoldItalic(text),
    matchBold(text),
    matchItalic(text),
    matchStrikethrough(text),
  ];

  let best: InlineConstruct | null = null;
  for (const c of candidates) {
    if (c === null) continue;
    if (best === null || c.index < best.index) {
      best = c;
    }
  }
  return best;
}

function matchInlineCode(text: string): InlineConstruct | null {
  const re = /`([^`\n]+)`/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    html: `<code>${htmlEscape(m[1])}</code>`,
  };
}

function matchImage(text: string): InlineConstruct | null {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const m = re.exec(text);
  if (!m) return null;
  const alt = htmlEscape(m[1]);
  const src = htmlEscape(m[2]);
  return {
    index: m.index,
    length: m[0].length,
    html: `<img src="${src}" alt="${alt}">`,
  };
}

function matchLink(text: string): InlineConstruct | null {
  // Exclude image syntax by requiring no preceding !
  const re = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  const m = re.exec(text);
  if (!m) return null;
  const label = applyInlineFormattingNoLinks(m[1]);
  const href = htmlEscape(m[2]);
  return {
    index: m.index,
    length: m[0].length,
    html: `<a href="${href}">${label}</a>`,
  };
}

/**
 * Apply inline formatting to link label text, but skip link matching to
 * avoid infinite recursion.
 */
function applyInlineFormattingNoLinks(text: string): string {
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    const candidates: Array<InlineConstruct | null> = [
      matchInlineCode(remaining),
      matchBoldItalic(remaining),
      matchBold(remaining),
      matchItalic(remaining),
      matchStrikethrough(remaining),
    ];

    let best: InlineConstruct | null = null;
    for (const c of candidates) {
      if (c === null) continue;
      if (best === null || c.index < best.index) best = c;
    }

    if (best === null) {
      result += htmlEscape(remaining);
      break;
    }

    if (best.index > 0) result += htmlEscape(remaining.slice(0, best.index));
    result += best.html;
    remaining = remaining.slice(best.index + best.length);
  }

  return result;
}

function matchBoldItalic(text: string): InlineConstruct | null {
  const re = /\*{3}([^*]+)\*{3}/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    html: `<strong><em>${htmlEscape(m[1])}</em></strong>`,
  };
}

function matchBold(text: string): InlineConstruct | null {
  const re = /(\*{2}|_{2})([^*_\n]+)\1/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    html: `<strong>${htmlEscape(m[2])}</strong>`,
  };
}

function matchItalic(text: string): InlineConstruct | null {
  const re = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)|(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
  const m = re.exec(text);
  if (!m) return null;
  const inner = m[1] ?? m[2] ?? '';
  return {
    index: m.index,
    length: m[0].length,
    html: `<em>${htmlEscape(inner)}</em>`,
  };
}

function matchStrikethrough(text: string): InlineConstruct | null {
  const re = /~~([^~\n]+)~~/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    html: `<del>${htmlEscape(m[1])}</del>`,
  };
}
