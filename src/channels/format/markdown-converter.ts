/**
 * Base Markdown utilities for channel-specific format conversions.
 *
 * These functions provide two primitives that channel connectors can build on:
 * - `stripMarkdown`     — convert Markdown to plain text (last-resort fallback)
 * - `escapeForChannel` — escape special characters for a named channel format
 *
 * Individual connectors apply their own richer conversions on top of these
 * (e.g. Telegram MarkdownV2, Slack mrkdwn, Discord markdown).
 */

// ---------------------------------------------------------------------------
// Strip Markdown
// ---------------------------------------------------------------------------

/**
 * Remove all Markdown syntax and return plain text.
 *
 * Handles the most common Markdown constructs:
 *   - ATX headings (`# Heading`)
 *   - Setext headings (underline with `===` or `---`)
 *   - Bold (`**text**`, `__text__`)
 *   - Italic (`*text*`, `_text_`)
 *   - Strikethrough (`~~text~~`)
 *   - Inline code (`` `code` ``)
 *   - Fenced code blocks (``` or ~~~)
 *   - Block quotes (`> `)
 *   - Unordered list markers (`- `, `* `, `+ `)
 *   - Ordered list markers (`1. `)
 *   - Inline links `[label](url)` — keeps the label
 *   - Reference links `[label][ref]` — keeps the label
 *   - Images `![alt](url)` — keeps the alt text
 *   - Horizontal rules (`---`, `***`, `___`)
 *
 * @param md - Markdown input string.
 * @returns Plain text string with all Markdown syntax removed.
 */
export function stripMarkdown(md: string): string {
  let text = md;

  // Fenced code blocks — replace with content only (keep the code itself)
  text = text.replace(/^```[\w]*\n([\s\S]*?)^```$/gm, '$1');
  text = text.replace(/^~~~[\w]*\n([\s\S]*?)^~~~$/gm, '$1');

  // ATX headings: # Heading -> Heading
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // Setext headings: underlined with === or ---
  text = text.replace(/^(.+)\n[=]{2,}$/gm, '$1');
  text = text.replace(/^(.+)\n[-]{2,}$/gm, '$1');

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // Images: ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Inline links: [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Reference links: [label][ref] -> label
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Bold + italic: ***text*** or ___text___
  text = text.replace(/\*{3}([^*]+)\*{3}/g, '$1');
  text = text.replace(/_{3}([^_]+)_{3}/g, '$1');

  // Bold: **text** or __text__
  text = text.replace(/\*{2}([^*]+)\*{2}/g, '$1');
  text = text.replace(/_{2}([^_]+)_{2}/g, '$1');

  // Italic: *text* or _text_
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, '$1');

  // Block quotes: > text
  text = text.replace(/^>\s?/gm, '');

  // Unordered list markers
  text = text.replace(/^[*\-+]\s+/gm, '');

  // Ordered list markers
  text = text.replace(/^\d+\.\s+/gm, '');

  // Collapse multiple blank lines to a single blank line
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// ---------------------------------------------------------------------------
// Channel-specific escaping
// ---------------------------------------------------------------------------

/**
 * Known channel identifiers for which escaping is implemented.
 * Additional channel types will fall through to no-op escaping.
 */
type KnownChannel = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'email';

/**
 * Escape special characters in `text` for use in the given channel's native
 * message format.
 *
 * This function operates on plain text fragments (not full Markdown documents).
 * Use it when assembling channel-native formatted strings from sub-components.
 *
 * | Channel   | Spec / target format  | Characters escaped                          |
 * |-----------|-----------------------|---------------------------------------------|
 * | telegram  | MarkdownV2            | `_ * [ ] ( ) ~ \` > # + - = | { } . !`     |
 * | slack     | mrkdwn                | `& < >`                                     |
 * | discord   | Discord Markdown      | `\ * _ ~ \` | > [ ]`                        |
 * | whatsapp  | WhatsApp Markdown     | `* _ ~ \`` (limited set)                    |
 * | email     | HTML                  | `& < > " '`                                 |
 * | (other)   | plain text            | no escaping                                 |
 *
 * @param text    - Plain text fragment to escape.
 * @param channel - Target channel identifier (case-insensitive).
 * @returns Escaped string ready for inclusion in a channel-native message.
 */
export function escapeForChannel(text: string, channel: string): string {
  const ch = channel.toLowerCase() as KnownChannel;

  switch (ch) {
    case 'telegram':
      // Telegram MarkdownV2 requires escaping these characters with a backslash.
      return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

    case 'slack':
      // Slack mrkdwn uses HTML entities for &, < and >.
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    case 'discord':
      // Discord Markdown special characters.
      return text.replace(/([\\*_~`|>[\]])/g, '\\$1');

    case 'whatsapp':
      // WhatsApp supports a limited Markdown subset.
      return text.replace(/([*_~`\\])/g, '\\$1');

    case 'email':
      // HTML escaping for email body content.
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    default:
      // Unknown channel — return text unchanged (plain-text fallback).
      return text;
  }
}
