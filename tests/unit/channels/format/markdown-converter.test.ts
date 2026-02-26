/**
 * Unit tests for markdown-converter utilities.
 */

import { describe, it, expect } from 'vitest';
import { stripMarkdown, escapeForChannel } from '../../../../src/channels/format/markdown-converter.js';

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe('stripMarkdown', () => {
  it('returns plain text unchanged', () => {
    expect(stripMarkdown('Hello, world!')).toBe('Hello, world!');
  });

  it('strips ATX headings', () => {
    expect(stripMarkdown('# Heading 1')).toBe('Heading 1');
    expect(stripMarkdown('## Heading 2')).toBe('Heading 2');
    expect(stripMarkdown('### Heading 3')).toBe('Heading 3');
  });

  it('strips bold markers', () => {
    expect(stripMarkdown('**bold text**')).toBe('bold text');
    expect(stripMarkdown('__bold text__')).toBe('bold text');
  });

  it('strips italic markers', () => {
    expect(stripMarkdown('*italic text*')).toBe('italic text');
    expect(stripMarkdown('_italic text_')).toBe('italic text');
  });

  it('strips strikethrough', () => {
    expect(stripMarkdown('~~struck text~~')).toBe('struck text');
  });

  it('strips inline code', () => {
    expect(stripMarkdown('`code snippet`')).toBe('code snippet');
  });

  it('strips fenced code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const result = stripMarkdown(md);
    expect(result).toContain('const x = 1;');
    expect(result).not.toContain('```');
  });

  it('strips block quotes', () => {
    expect(stripMarkdown('> quoted text')).toBe('quoted text');
    expect(stripMarkdown('> line one\n> line two')).toBe('line one\nline two');
  });

  it('strips unordered list markers', () => {
    expect(stripMarkdown('- item one')).toBe('item one');
    expect(stripMarkdown('* item two')).toBe('item two');
    expect(stripMarkdown('+ item three')).toBe('item three');
  });

  it('strips ordered list markers', () => {
    expect(stripMarkdown('1. first item')).toBe('first item');
    expect(stripMarkdown('2. second item')).toBe('second item');
  });

  it('replaces inline links with the link label', () => {
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here');
  });

  it('replaces image syntax with alt text', () => {
    expect(stripMarkdown('![alt text](image.png)')).toBe('alt text');
  });

  it('replaces reference links with the link label', () => {
    expect(stripMarkdown('[label][ref]')).toBe('label');
  });

  it('strips horizontal rules', () => {
    const result = stripMarkdown('before\n\n---\n\nafter');
    expect(result).not.toContain('---');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('trims leading and trailing whitespace', () => {
    expect(stripMarkdown('  \n# Heading\n  ')).toBe('Heading');
  });

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('handles a complex multi-element document', () => {
    const md = `# Title\n\nSome **bold** and _italic_ text.\n\n- list item\n\n> quote\n\n[link](http://example.com)`;
    const result = stripMarkdown(md);
    expect(result).toContain('Title');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).toContain('list item');
    expect(result).toContain('quote');
    expect(result).toContain('link');
    expect(result).not.toContain('**');
    expect(result).not.toContain('#');
    expect(result).not.toContain('http://example.com');
  });
});

// ---------------------------------------------------------------------------
// escapeForChannel
// ---------------------------------------------------------------------------

describe('escapeForChannel', () => {
  // -------------------------------------------------------------------------
  // Telegram MarkdownV2
  // -------------------------------------------------------------------------

  describe('telegram', () => {
    it('escapes Telegram MarkdownV2 special characters', () => {
      // Every special char should be backslash-escaped.
      const input = 'Hello_world. 1+1=2 (test) [link] {x} ~y~ #tag! |pipe|';
      const result = escapeForChannel(input, 'telegram');
      // Each special char should be preceded by a backslash.
      expect(result).toContain('\\_');
      expect(result).toContain('\\.');
      expect(result).toContain('\\+');
      expect(result).toContain('\\(');
      expect(result).toContain('\\[');
      expect(result).toContain('\\#');
    });

    it('handles text with no special chars unchanged', () => {
      const result = escapeForChannel('hello world', 'telegram');
      expect(result).toBe('hello world');
    });

    it('is case-insensitive for channel name', () => {
      const lower = escapeForChannel('_', 'telegram');
      const upper = escapeForChannel('_', 'TELEGRAM');
      expect(lower).toBe(upper);
    });
  });

  // -------------------------------------------------------------------------
  // Slack mrkdwn
  // -------------------------------------------------------------------------

  describe('slack', () => {
    it('escapes & as &amp;', () => {
      expect(escapeForChannel('a & b', 'slack')).toBe('a &amp; b');
    });

    it('escapes < as &lt;', () => {
      expect(escapeForChannel('a < b', 'slack')).toBe('a &lt; b');
    });

    it('escapes > as &gt;', () => {
      expect(escapeForChannel('a > b', 'slack')).toBe('a &gt; b');
    });

    it('handles combined entities', () => {
      expect(escapeForChannel('<b>&c</b>', 'slack')).toBe('&lt;b&gt;&amp;c&lt;/b&gt;');
    });
  });

  // -------------------------------------------------------------------------
  // Discord markdown
  // -------------------------------------------------------------------------

  describe('discord', () => {
    it('escapes Discord Markdown special characters with backslash', () => {
      const result = escapeForChannel('*bold* _italic_', 'discord');
      expect(result).toContain('\\*');
      expect(result).toContain('\\_');
    });
  });

  // -------------------------------------------------------------------------
  // WhatsApp
  // -------------------------------------------------------------------------

  describe('whatsapp', () => {
    it('escapes WhatsApp formatting characters', () => {
      const result = escapeForChannel('*bold* _italic_ ~strike~', 'whatsapp');
      expect(result).toContain('\\*');
      expect(result).toContain('\\_');
      expect(result).toContain('\\~');
    });
  });

  // -------------------------------------------------------------------------
  // Email HTML
  // -------------------------------------------------------------------------

  describe('email', () => {
    it('escapes HTML entities', () => {
      const result = escapeForChannel('<p class="x">a & b</p>', 'email');
      expect(result).toBe('&lt;p class=&quot;x&quot;&gt;a &amp; b&lt;/p&gt;');
    });

    it("escapes single quotes as &#39;", () => {
      expect(escapeForChannel("it's", 'email')).toBe('it&#39;s');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown channel — plain text fallback
  // -------------------------------------------------------------------------

  describe('unknown channel', () => {
    it('returns text unchanged for an unknown channel type', () => {
      const text = 'hello *world* [link](url)';
      expect(escapeForChannel(text, 'unknown-channel')).toBe(text);
    });
  });
});
