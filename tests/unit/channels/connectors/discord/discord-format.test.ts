/**
 * Unit tests for Discord Markdown format utilities.
 *
 * Discord supports near-standard Markdown natively, so most constructs pass
 * through unchanged. Only a few special cases (images, tables) require
 * transformation.
 */

import { describe, it, expect } from 'vitest';
import { markdownToDiscord } from '../../../../../src/channels/connectors/discord/discord-format.js';

// ---------------------------------------------------------------------------
// markdownToDiscord — pass-through constructs
// ---------------------------------------------------------------------------

describe('markdownToDiscord', () => {
  describe('plain text', () => {
    it('returns plain text unchanged', () => {
      expect(markdownToDiscord('Hello, Discord!')).toBe('Hello, Discord!');
    });

    it('returns empty string unchanged', () => {
      expect(markdownToDiscord('')).toBe('');
    });

    it('preserves newlines in plain text', () => {
      const input = 'line one\nline two\nline three';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('preserves multiple blank lines', () => {
      const input = 'para one\n\npara two';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Bold — passes through unchanged
  // -------------------------------------------------------------------------

  describe('bold', () => {
    it('passes **bold** through unchanged', () => {
      expect(markdownToDiscord('**bold text**')).toBe('**bold text**');
    });

    it('passes __bold__ through unchanged', () => {
      expect(markdownToDiscord('__bold text__')).toBe('__bold text__');
    });

    it('preserves bold in mixed content', () => {
      const input = 'Hello **world** and **everyone**';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Italic — passes through unchanged
  // -------------------------------------------------------------------------

  describe('italic', () => {
    it('passes *italic* through unchanged', () => {
      expect(markdownToDiscord('*italic text*')).toBe('*italic text*');
    });

    it('passes _italic_ through unchanged', () => {
      expect(markdownToDiscord('_italic text_')).toBe('_italic text_');
    });
  });

  // -------------------------------------------------------------------------
  // Strikethrough — passes through unchanged
  // -------------------------------------------------------------------------

  describe('strikethrough', () => {
    it('passes ~~strikethrough~~ through unchanged', () => {
      expect(markdownToDiscord('~~struck text~~')).toBe('~~struck text~~');
    });
  });

  // -------------------------------------------------------------------------
  // Inline code — passes through unchanged
  // -------------------------------------------------------------------------

  describe('inline code', () => {
    it('passes `code` through unchanged', () => {
      expect(markdownToDiscord('`some code`')).toBe('`some code`');
    });

    it('does not modify content inside inline code', () => {
      const input = '`a.b+c![img](url)`';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('preserves inline code mixed with text', () => {
      const input = 'Use `npm install` to install packages.';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Fenced code blocks — pass through unchanged
  // -------------------------------------------------------------------------

  describe('fenced code blocks', () => {
    it('passes fenced code blocks through unchanged', () => {
      const input = '```typescript\nconst x = 1 + 2;\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('preserves language tag in code block', () => {
      const input = '```python\nprint("hello")\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('preserves code block with no language tag', () => {
      const input = '```\nsome code\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('does not modify images inside code blocks', () => {
      const input = '```\n![not an image](url)\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('does not modify table syntax inside code blocks', () => {
      const input = '```\n| Col A | Col B |\n|-------|-------|\n| val1  | val2  |\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Headings — pass through unchanged (Discord supports # ## ###)
  // -------------------------------------------------------------------------

  describe('headings', () => {
    it('passes # heading through unchanged', () => {
      expect(markdownToDiscord('# Main Heading')).toBe('# Main Heading');
    });

    it('passes ## heading through unchanged', () => {
      expect(markdownToDiscord('## Sub Heading')).toBe('## Sub Heading');
    });

    it('passes ### heading through unchanged', () => {
      expect(markdownToDiscord('### Sub-sub Heading')).toBe('### Sub-sub Heading');
    });
  });

  // -------------------------------------------------------------------------
  // Links — pass through unchanged
  // -------------------------------------------------------------------------

  describe('links', () => {
    it('passes [text](url) links through unchanged', () => {
      expect(markdownToDiscord('[click here](https://example.com)')).toBe(
        '[click here](https://example.com)',
      );
    });

    it('passes bare URLs through unchanged', () => {
      const input = 'See https://discord.com for more info.';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Block quotes — pass through unchanged
  // -------------------------------------------------------------------------

  describe('block quotes', () => {
    it('passes > blockquote through unchanged', () => {
      expect(markdownToDiscord('> This is a quote')).toBe('> This is a quote');
    });

    it('passes multiline blockquote through unchanged', () => {
      const input = '> line one\n> line two';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Spoilers — pass through unchanged
  // -------------------------------------------------------------------------

  describe('spoilers', () => {
    it('passes ||spoiler|| through unchanged', () => {
      expect(markdownToDiscord('||spoiler content||')).toBe('||spoiler content||');
    });
  });

  // -------------------------------------------------------------------------
  // Lists — pass through unchanged
  // -------------------------------------------------------------------------

  describe('lists', () => {
    it('passes unordered list through unchanged', () => {
      const input = '- item one\n- item two\n- item three';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('passes ordered list through unchanged', () => {
      const input = '1. first\n2. second\n3. third';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('passes asterisk list through unchanged', () => {
      const input = '* item a\n* item b';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Images — converted to alt text + URL
  // -------------------------------------------------------------------------

  describe('images', () => {
    it('converts image to alt text + URL', () => {
      const input = '![screenshot](https://example.com/img.png)';
      expect(markdownToDiscord(input)).toBe('screenshot (https://example.com/img.png)');
    });

    it('converts image with empty alt to just the URL', () => {
      const input = '![](https://example.com/img.png)';
      expect(markdownToDiscord(input)).toBe('https://example.com/img.png');
    });

    it('converts image with whitespace-only alt to just the URL', () => {
      const input = '![   ](https://example.com/img.png)';
      expect(markdownToDiscord(input)).toBe('https://example.com/img.png');
    });

    it('handles multiple images in same document', () => {
      const input = '![first](url1) and ![second](url2)';
      expect(markdownToDiscord(input)).toBe('first (url1) and second (url2)');
    });

    it('handles image mixed with other content', () => {
      const input = 'See this image: ![diagram](https://example.com/diagram.svg) for details.';
      expect(markdownToDiscord(input)).toBe(
        'See this image: diagram (https://example.com/diagram.svg) for details.',
      );
    });

    it('does not convert image inside inline code', () => {
      const input = '`![not converted](url)`';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('does not convert image inside fenced code block', () => {
      const input = '```\n![not converted](url)\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Tables — converted to simplified text
  // -------------------------------------------------------------------------

  describe('tables', () => {
    it('converts a simple markdown table to simplified text', () => {
      const input = '| Col A | Col B |\n|-------|-------|\n| val1  | val2  |';
      const result = markdownToDiscord(input);
      // Separator row is stripped; data rows are pipe-joined.
      expect(result).toContain('Col A | Col B');
      expect(result).toContain('val1 | val2');
      expect(result).not.toContain('----');
    });

    it('handles table with multiple data rows', () => {
      const input =
        '| Name | Score |\n|------|-------|\n| Alice | 100 |\n| Bob | 95 |';
      const result = markdownToDiscord(input);
      expect(result).toContain('Name | Score');
      expect(result).toContain('Alice | 100');
      expect(result).toContain('Bob | 95');
      expect(result).not.toContain('------');
    });

    it('does not convert table inside fenced code block', () => {
      const input = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed content
  // -------------------------------------------------------------------------

  describe('mixed content', () => {
    it('handles bold + image combination', () => {
      const input = '**Important**: ![diagram](https://example.com/d.png)';
      expect(markdownToDiscord(input)).toBe(
        '**Important**: diagram (https://example.com/d.png)',
      );
    });

    it('handles document with code block and image', () => {
      const input =
        'See the image: ![demo](https://example.com/demo.png)\n\n```js\nconsole.log("hello");\n```';
      const result = markdownToDiscord(input);
      expect(result).toContain('demo (https://example.com/demo.png)');
      expect(result).toContain('console.log("hello");');
    });

    it('handles all pass-through formatting in one document', () => {
      const input = '**bold** *italic* ~~struck~~ `code` [link](url) > quote';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('handles a complex document with multiple element types', () => {
      const input = [
        '# Project Update',
        '',
        'Here is a screenshot: ![screenshot](https://example.com/ss.png)',
        '',
        '## Changes',
        '',
        '- **Fixed** the login bug',
        '- *Updated* the dashboard',
        '',
        '```diff',
        '- old line',
        '+ new line',
        '```',
      ].join('\n');

      const result = markdownToDiscord(input);

      // Heading passes through.
      expect(result).toContain('# Project Update');
      // Image is converted.
      expect(result).toContain('screenshot (https://example.com/ss.png)');
      // List passes through.
      expect(result).toContain('- **Fixed** the login bug');
      // Code block passes through.
      expect(result).toContain('```diff');
      expect(result).toContain('+ new line');
    });
  });
});
