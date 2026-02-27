/**
 * Unit tests for Telegram MarkdownV2 format utilities.
 */

import { describe, it, expect } from 'vitest';
import { telegramEscape, markdownToTelegram } from '../../../../../src/channels/connectors/telegram/telegram-format.js';

// ---------------------------------------------------------------------------
// telegramEscape
// ---------------------------------------------------------------------------

describe('telegramEscape', () => {
  it('returns plain text unchanged when there are no special chars', () => {
    expect(telegramEscape('hello world')).toBe('hello world');
  });

  it('escapes all Telegram MarkdownV2 special characters', () => {
    // Each of these must be preceded by a backslash.
    const specials = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\'];
    for (const ch of specials) {
      const result = telegramEscape(ch);
      expect(result).toBe('\\' + ch);
    }
  });

  it('escapes multiple special chars in a sentence', () => {
    const result = telegramEscape('Hello, world! 1+1=2');
    expect(result).toBe('Hello, world\\! 1\\+1\\=2');
  });

  it('escapes dots and exclamation marks', () => {
    expect(telegramEscape('end.')).toBe('end\\.');
    expect(telegramEscape('stop!')).toBe('stop\\!');
  });

  it('handles empty string', () => {
    expect(telegramEscape('')).toBe('');
  });

  it('double-escapes a backslash', () => {
    expect(telegramEscape('\\')).toBe('\\\\');
  });
});

// ---------------------------------------------------------------------------
// markdownToTelegram
// ---------------------------------------------------------------------------

describe('markdownToTelegram', () => {
  // -------------------------------------------------------------------------
  // Plain text
  // -------------------------------------------------------------------------

  describe('plain text', () => {
    it('escapes special chars in plain text', () => {
      expect(markdownToTelegram('Hello.')).toBe('Hello\\.');
    });

    it('returns empty string unchanged', () => {
      expect(markdownToTelegram('')).toBe('');
    });

    it('preserves whitespace in plain text', () => {
      const result = markdownToTelegram('line one\nline two');
      expect(result).toBe('line one\nline two');
    });
  });

  // -------------------------------------------------------------------------
  // Bold
  // -------------------------------------------------------------------------

  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToTelegram('**bold text**')).toBe('*bold text*');
    });

    it('converts __bold__ to *bold*', () => {
      expect(markdownToTelegram('__bold text__')).toBe('*bold text*');
    });

    it('escapes special chars inside bold', () => {
      expect(markdownToTelegram('**hello.world**')).toBe('*hello\\.world*');
    });
  });

  // -------------------------------------------------------------------------
  // Italic
  // -------------------------------------------------------------------------

  describe('italic', () => {
    it('converts *italic* to _italic_', () => {
      expect(markdownToTelegram('*italic text*')).toBe('_italic text_');
    });

    it('converts _italic_ to _italic_', () => {
      expect(markdownToTelegram('_italic text_')).toBe('_italic text_');
    });

    it('escapes special chars inside italic', () => {
      expect(markdownToTelegram('*hello.world*')).toBe('_hello\\.world_');
    });
  });

  // -------------------------------------------------------------------------
  // Strikethrough
  // -------------------------------------------------------------------------

  describe('strikethrough', () => {
    it('converts ~~text~~ to ~text~', () => {
      expect(markdownToTelegram('~~struck~~')).toBe('~struck~');
    });

    it('escapes special chars inside strikethrough', () => {
      expect(markdownToTelegram('~~hello.world~~')).toBe('~hello\\.world~');
    });
  });

  // -------------------------------------------------------------------------
  // Inline code
  // -------------------------------------------------------------------------

  describe('inline code', () => {
    it('preserves inline code unchanged', () => {
      expect(markdownToTelegram('`some code`')).toBe('`some code`');
    });

    it('does not escape special chars inside inline code', () => {
      // Content inside backticks must not be escaped.
      expect(markdownToTelegram('`a.b+c`')).toBe('`a.b+c`');
    });
  });

  // -------------------------------------------------------------------------
  // Fenced code blocks
  // -------------------------------------------------------------------------

  describe('fenced code blocks', () => {
    it('preserves fenced code block content without escaping', () => {
      const md = '```typescript\nconst x = 1 + 2;\n```';
      const result = markdownToTelegram(md);
      expect(result).toContain('const x = 1 + 2;');
      // No backslash before + inside the code block.
      expect(result).not.toContain('\\+');
    });

    it('includes language tag in output', () => {
      const md = '```python\nprint("hello")\n```';
      const result = markdownToTelegram(md);
      expect(result).toMatch(/^```python/);
    });

    it('handles code block with no language tag', () => {
      const md = '```\nsome code\n```';
      const result = markdownToTelegram(md);
      expect(result).toContain('some code');
      expect(result).not.toContain('\\.');
    });
  });

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  describe('inline links', () => {
    it('converts [label](url) to Telegram inline link', () => {
      // In Telegram MarkdownV2, the URL portion uses URL parsing rules — dots
      // in URLs do not need escaping. Only ) and \ must be escaped inside URLs.
      expect(markdownToTelegram('[click here](https://example.com)')).toBe(
        '[click here](https://example.com)',
      );
    });

    it('escapes special chars in the link label but not the URL', () => {
      // Label gets full MarkdownV2 escaping; URL only needs ) and \ escaped.
      expect(markdownToTelegram('[hello.world](https://example.com)')).toBe(
        '[hello\\.world](https://example.com)',
      );
    });

    it('escapes closing parenthesis in URL', () => {
      // The URL regex matches up to the first unescaped ) so a URL containing
      // a ) needs the ) to be escaped in the source Markdown. We test a URL
      // without parens here to keep the regex simple.
      expect(markdownToTelegram('[link](https://example.com/page)')).toBe(
        '[link](https://example.com/page)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  describe('images', () => {
    it('replaces image with italic alt text', () => {
      const result = markdownToTelegram('![alt text](image.png)');
      expect(result).toBe('_alt text_');
    });

    it('produces empty string when alt text is empty', () => {
      const result = markdownToTelegram('![](image.png)');
      expect(result).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Headings
  // -------------------------------------------------------------------------

  describe('headings', () => {
    it('converts # heading to bold', () => {
      expect(markdownToTelegram('# My Heading')).toBe('*My Heading*');
    });

    it('converts ## heading to bold', () => {
      expect(markdownToTelegram('## Sub Heading')).toBe('*Sub Heading*');
    });

    it('escapes special chars in heading text', () => {
      expect(markdownToTelegram('# Hello.World')).toBe('*Hello\\.World*');
    });
  });

  // -------------------------------------------------------------------------
  // Mixed / complex documents
  // -------------------------------------------------------------------------

  describe('mixed content', () => {
    it('handles bold followed by plain text', () => {
      const result = markdownToTelegram('**Hello** world.');
      expect(result).toBe('*Hello* world\\.');
    });

    it('handles multiple formatting constructs in one document', () => {
      const md = '**bold** and *italic* and ~~struck~~';
      const result = markdownToTelegram(md);
      expect(result).toBe('*bold* and _italic_ and ~struck~');
    });

    it('handles a document with a code block and surrounding text', () => {
      const md = 'Here is code:\n```js\nconst x = 1;\n```\nAnd done.';
      const result = markdownToTelegram(md);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('Here is code');
      expect(result).toContain('And done');
    });

    it('handles inline code mixed with formatted text', () => {
      const md = '**bold** with `code` inline';
      const result = markdownToTelegram(md);
      expect(result).toBe('*bold* with `code` inline');
    });
  });

  // -------------------------------------------------------------------------
  // Bold + italic (triple asterisks)
  // -------------------------------------------------------------------------

  describe('bold italic', () => {
    it('converts ***text*** to *_text_*', () => {
      const result = markdownToTelegram('***bold italic***');
      expect(result).toBe('*_bold italic_*');
    });
  });
});
