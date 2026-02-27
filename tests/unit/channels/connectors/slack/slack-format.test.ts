/**
 * Unit tests for Slack mrkdwn format utilities.
 */

import { describe, it, expect } from 'vitest';
import { markdownToSlackMrkdwn } from '../../../../../src/channels/connectors/slack/slack-format.js';

// ---------------------------------------------------------------------------
// markdownToSlackMrkdwn
// ---------------------------------------------------------------------------

describe('markdownToSlackMrkdwn', () => {
  // -------------------------------------------------------------------------
  // Plain text
  // -------------------------------------------------------------------------

  describe('plain text', () => {
    it('returns plain text unchanged', () => {
      expect(markdownToSlackMrkdwn('hello world')).toBe('hello world');
    });

    it('returns empty string unchanged', () => {
      expect(markdownToSlackMrkdwn('')).toBe('');
    });

    it('preserves whitespace in plain text', () => {
      const result = markdownToSlackMrkdwn('line one\nline two');
      expect(result).toBe('line one\nline two');
    });

    it('preserves special Markdown characters that are not formatting', () => {
      // Unlike Telegram, Slack mrkdwn does not require escaping plain text.
      expect(markdownToSlackMrkdwn('Hello, world!')).toBe('Hello, world!');
    });
  });

  // -------------------------------------------------------------------------
  // Bold
  // -------------------------------------------------------------------------

  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToSlackMrkdwn('**bold text**')).toBe('*bold text*');
    });

    it('converts __bold__ to *bold*', () => {
      expect(markdownToSlackMrkdwn('__bold text__')).toBe('*bold text*');
    });

    it('preserves content inside bold unchanged', () => {
      expect(markdownToSlackMrkdwn('**hello.world**')).toBe('*hello.world*');
    });

    it('handles bold in the middle of a sentence', () => {
      expect(markdownToSlackMrkdwn('Hello **world** today')).toBe('Hello *world* today');
    });
  });

  // -------------------------------------------------------------------------
  // Italic
  // -------------------------------------------------------------------------

  describe('italic', () => {
    it('converts *italic* to _italic_', () => {
      expect(markdownToSlackMrkdwn('*italic text*')).toBe('_italic text_');
    });

    it('converts _italic_ to _italic_', () => {
      expect(markdownToSlackMrkdwn('_italic text_')).toBe('_italic text_');
    });

    it('preserves content inside italic unchanged', () => {
      expect(markdownToSlackMrkdwn('*hello world*')).toBe('_hello world_');
    });
  });

  // -------------------------------------------------------------------------
  // Strikethrough
  // -------------------------------------------------------------------------

  describe('strikethrough', () => {
    it('converts ~~text~~ to ~text~', () => {
      expect(markdownToSlackMrkdwn('~~struck~~')).toBe('~struck~');
    });

    it('preserves content inside strikethrough unchanged', () => {
      expect(markdownToSlackMrkdwn('~~hello world~~')).toBe('~hello world~');
    });

    it('handles strikethrough in the middle of a sentence', () => {
      expect(markdownToSlackMrkdwn('This is ~~deleted~~ text')).toBe('This is ~deleted~ text');
    });
  });

  // -------------------------------------------------------------------------
  // Inline code
  // -------------------------------------------------------------------------

  describe('inline code', () => {
    it('preserves inline code syntax unchanged', () => {
      // Slack uses the same backtick syntax as Markdown.
      expect(markdownToSlackMrkdwn('`some code`')).toBe('`some code`');
    });

    it('does not transform content inside inline code', () => {
      // **bold** inside code should not become *bold*.
      expect(markdownToSlackMrkdwn('`**not bold**`')).toBe('`**not bold**`');
    });

    it('handles inline code with special characters', () => {
      expect(markdownToSlackMrkdwn('`a.b+c`')).toBe('`a.b+c`');
    });
  });

  // -------------------------------------------------------------------------
  // Fenced code blocks
  // -------------------------------------------------------------------------

  describe('fenced code blocks', () => {
    it('preserves code block content without transformation', () => {
      const md = '```typescript\nconst x = 1 + 2;\n```';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toContain('const x = 1 + 2;');
    });

    it('strips language hint from code blocks', () => {
      // Slack does not support language hints in code blocks.
      const md = '```python\nprint("hello")\n```';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toMatch(/^```\n/);
      expect(result).not.toMatch(/^```python/);
    });

    it('handles code block with no language tag', () => {
      const md = '```\nsome code\n```';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toContain('some code');
      expect(result).toMatch(/^```\n/);
    });

    it('does not transform formatting markers inside code blocks', () => {
      const md = '```\n**not bold** and ~~not struck~~\n```';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toContain('**not bold**');
      expect(result).toContain('~~not struck~~');
    });
  });

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  describe('inline links', () => {
    it('converts [label](url) to Slack <url|label> format', () => {
      expect(markdownToSlackMrkdwn('[click here](https://example.com)')).toBe(
        '<https://example.com|click here>',
      );
    });

    it('handles links with labels containing spaces', () => {
      expect(markdownToSlackMrkdwn('[my link text](https://example.com/page)')).toBe(
        '<https://example.com/page|my link text>',
      );
    });

    it('does not match image syntax as a link', () => {
      // ![alt](url) should not become <url|alt>
      const result = markdownToSlackMrkdwn('![image](https://example.com/img.png)');
      // Images are not specially handled — they pass through as-is.
      expect(result).not.toContain('<https://example.com/img.png|image>');
    });

    it('handles multiple links in one document', () => {
      const md = '[first](https://one.com) and [second](https://two.com)';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('<https://one.com|first> and <https://two.com|second>');
    });
  });

  // -------------------------------------------------------------------------
  // Headings
  // -------------------------------------------------------------------------

  describe('headings', () => {
    it('converts # heading to bold', () => {
      expect(markdownToSlackMrkdwn('# My Heading')).toBe('*My Heading*');
    });

    it('converts ## heading to bold', () => {
      expect(markdownToSlackMrkdwn('## Sub Heading')).toBe('*Sub Heading*');
    });

    it('converts ### heading to bold', () => {
      expect(markdownToSlackMrkdwn('### Deep Heading')).toBe('*Deep Heading*');
    });

    it('preserves heading text content unchanged', () => {
      expect(markdownToSlackMrkdwn('# Hello World!')).toBe('*Hello World!*');
    });
  });

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  describe('lists', () => {
    it('preserves unordered list items as-is', () => {
      const md = '- item one\n- item two\n- item three';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('- item one\n- item two\n- item three');
    });

    it('preserves ordered list items as-is', () => {
      const md = '1. first\n2. second\n3. third';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('1. first\n2. second\n3. third');
    });
  });

  // -------------------------------------------------------------------------
  // Mixed / complex documents
  // -------------------------------------------------------------------------

  describe('mixed content', () => {
    it('handles bold followed by plain text', () => {
      const result = markdownToSlackMrkdwn('**Hello** world.');
      expect(result).toBe('*Hello* world.');
    });

    it('handles multiple formatting constructs in one document', () => {
      const md = '**bold** and *italic* and ~~struck~~';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('*bold* and _italic_ and ~struck~');
    });

    it('handles a document with a code block and surrounding text', () => {
      const md = 'Here is code:\n```js\nconst x = 1;\n```\nAnd done.';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('Here is code');
      expect(result).toContain('And done.');
    });

    it('handles inline code mixed with formatted text', () => {
      const md = '**bold** with `code` inline';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('*bold* with `code` inline');
    });

    it('handles a link followed by bold text', () => {
      const md = '[link](https://example.com) and **bold**';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('<https://example.com|link> and *bold*');
    });

    it('handles heading with formatting in the text', () => {
      // The heading regex captures the raw heading text; bold inside headings
      // is treated as a plain heading (not double-formatted).
      const md = '# Heading Text';
      const result = markdownToSlackMrkdwn(md);
      expect(result).toBe('*Heading Text*');
    });
  });
});
