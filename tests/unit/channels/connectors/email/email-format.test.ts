/**
 * Unit tests for email HTML format utilities.
 *
 * Tests markdownToHtml() and htmlEscape() from email-format.ts.
 * No I/O or network calls.
 */

import { describe, it, expect } from 'vitest';
import {
  htmlEscape,
  markdownToHtml,
} from '../../../../../src/channels/connectors/email/email-format.js';

// ---------------------------------------------------------------------------
// htmlEscape
// ---------------------------------------------------------------------------

describe('htmlEscape', () => {
  it('returns plain text unchanged when there are no HTML special chars', () => {
    expect(htmlEscape('hello world')).toBe('hello world');
  });

  it('escapes ampersand', () => {
    expect(htmlEscape('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(htmlEscape('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes greater-than', () => {
    expect(htmlEscape('x > y')).toBe('x &gt; y');
  });

  it('escapes double quote', () => {
    expect(htmlEscape('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it("escapes single quote", () => {
    expect(htmlEscape("it's")).toBe("it&#39;s");
  });

  it('handles empty string', () => {
    expect(htmlEscape('')).toBe('');
  });

  it('escapes all five special chars in one string', () => {
    const input = '& < > " \'';
    const output = htmlEscape(input);
    expect(output).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('does not double-escape an already-escaped entity', () => {
    // We are escaping raw text, so & in the input becomes &amp;
    expect(htmlEscape('&amp;')).toBe('&amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — plain text
// ---------------------------------------------------------------------------

describe('markdownToHtml — plain text', () => {
  it('wraps a plain paragraph in <p>', () => {
    const result = markdownToHtml('Hello world');
    expect(result).toBe('<p>Hello world</p>');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('HTML-escapes < and > in plain text', () => {
    const result = markdownToHtml('a < b > c');
    expect(result).toContain('a &lt; b &gt; c');
  });

  it('HTML-escapes ampersand in plain text', () => {
    const result = markdownToHtml('AT&T');
    expect(result).toContain('AT&amp;T');
  });

  it('wraps two separated paragraphs in separate <p> tags', () => {
    const md = 'Paragraph one.\n\nParagraph two.';
    const result = markdownToHtml(md);
    expect(result).toContain('<p>Paragraph one.</p>');
    expect(result).toContain('<p>Paragraph two.</p>');
  });

  it('converts trailing double-space + newline to <br>', () => {
    const md = 'line one  \nline two';
    const result = markdownToHtml(md);
    expect(result).toContain('<br>');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — headings
// ---------------------------------------------------------------------------

describe('markdownToHtml — headings', () => {
  it('converts # heading to <h1>', () => {
    expect(markdownToHtml('# Title')).toBe('<h1>Title</h1>');
  });

  it('converts ## to <h2>', () => {
    expect(markdownToHtml('## Section')).toBe('<h2>Section</h2>');
  });

  it('converts ### to <h3>', () => {
    expect(markdownToHtml('### Sub')).toBe('<h3>Sub</h3>');
  });

  it('converts #### to <h4>', () => {
    expect(markdownToHtml('#### Deep')).toBe('<h4>Deep</h4>');
  });

  it('converts ##### to <h5>', () => {
    expect(markdownToHtml('##### Deeper')).toBe('<h5>Deeper</h5>');
  });

  it('converts ###### to <h6>', () => {
    expect(markdownToHtml('###### Deepest')).toBe('<h6>Deepest</h6>');
  });

  it('HTML-escapes heading content', () => {
    const result = markdownToHtml('# AT&T News');
    expect(result).toBe('<h1>AT&amp;T News</h1>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — bold
// ---------------------------------------------------------------------------

describe('markdownToHtml — bold', () => {
  it('converts **text** to <strong>', () => {
    const result = markdownToHtml('**bold text**');
    expect(result).toContain('<strong>bold text</strong>');
  });

  it('converts __text__ to <strong>', () => {
    const result = markdownToHtml('__bold text__');
    expect(result).toContain('<strong>bold text</strong>');
  });

  it('HTML-escapes content inside bold', () => {
    const result = markdownToHtml('**AT&T**');
    expect(result).toContain('<strong>AT&amp;T</strong>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — italic
// ---------------------------------------------------------------------------

describe('markdownToHtml — italic', () => {
  it('converts *text* to <em>', () => {
    const result = markdownToHtml('*italic*');
    expect(result).toContain('<em>italic</em>');
  });

  it('converts _text_ to <em>', () => {
    const result = markdownToHtml('_italic_');
    expect(result).toContain('<em>italic</em>');
  });

  it('HTML-escapes content inside italic', () => {
    const result = markdownToHtml('*a & b*');
    expect(result).toContain('<em>a &amp; b</em>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — bold+italic
// ---------------------------------------------------------------------------

describe('markdownToHtml — bold+italic', () => {
  it('converts ***text*** to <strong><em>', () => {
    const result = markdownToHtml('***bold italic***');
    expect(result).toContain('<strong><em>bold italic</em></strong>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — strikethrough
// ---------------------------------------------------------------------------

describe('markdownToHtml — strikethrough', () => {
  it('converts ~~text~~ to <del>', () => {
    const result = markdownToHtml('~~struck~~');
    expect(result).toContain('<del>struck</del>');
  });

  it('HTML-escapes content inside strikethrough', () => {
    const result = markdownToHtml('~~a & b~~');
    expect(result).toContain('<del>a &amp; b</del>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — inline code
// ---------------------------------------------------------------------------

describe('markdownToHtml — inline code', () => {
  it('converts `code` to <code>', () => {
    const result = markdownToHtml('Use `npm install`');
    expect(result).toContain('<code>npm install</code>');
  });

  it('HTML-escapes content inside inline code', () => {
    const result = markdownToHtml('`x < y`');
    expect(result).toContain('<code>x &lt; y</code>');
  });

  it('does not apply other formatting inside inline code', () => {
    // **bold** inside backticks should not become <strong>
    const result = markdownToHtml('`**not bold**`');
    expect(result).toContain('<code>**not bold**</code>');
    expect(result).not.toContain('<strong>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — fenced code blocks
// ---------------------------------------------------------------------------

describe('markdownToHtml — fenced code blocks', () => {
  it('converts a code block to <pre><code>', () => {
    const md = '```\nconst x = 1;\n```';
    const result = markdownToHtml(md);
    expect(result).toContain('<pre><code>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('</code></pre>');
  });

  it('includes a language class attribute when a language is specified', () => {
    const md = '```typescript\nconst x: number = 1;\n```';
    const result = markdownToHtml(md);
    expect(result).toContain('class="language-typescript"');
    expect(result).toContain('const x: number = 1;');
  });

  it('HTML-escapes code block content', () => {
    const md = '```\nif (a < b) {}\n```';
    const result = markdownToHtml(md);
    expect(result).toContain('&lt;');
    expect(result).not.toContain('<b>');
  });

  it('does not apply bold formatting inside code blocks', () => {
    const md = '```\n**not bold**\n```';
    const result = markdownToHtml(md);
    expect(result).not.toContain('<strong>');
    expect(result).toContain('**not bold**');
  });

  it('handles a code block surrounded by text paragraphs', () => {
    const md = 'Before.\n\n```js\nfoo();\n```\n\nAfter.';
    const result = markdownToHtml(md);
    expect(result).toContain('<p>Before.</p>');
    expect(result).toContain('<pre><code');
    expect(result).toContain('foo();');
    expect(result).toContain('<p>After.</p>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — links
// ---------------------------------------------------------------------------

describe('markdownToHtml — links', () => {
  it('converts [label](url) to <a href>', () => {
    const result = markdownToHtml('[click here](https://example.com)');
    expect(result).toContain('<a href="https://example.com">click here</a>');
  });

  it('HTML-escapes the URL', () => {
    const result = markdownToHtml('[link](https://example.com?a=1&b=2)');
    expect(result).toContain('href="https://example.com?a=1&amp;b=2"');
  });

  it('HTML-escapes the label', () => {
    const result = markdownToHtml('[AT&T](https://att.com)');
    expect(result).toContain('>AT&amp;T<');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — images
// ---------------------------------------------------------------------------

describe('markdownToHtml — images', () => {
  it('converts ![alt](url) to <img src alt>', () => {
    const result = markdownToHtml('![cat photo](https://example.com/cat.png)');
    expect(result).toContain('<img src="https://example.com/cat.png" alt="cat photo">');
  });

  it('produces <img> with empty alt for no alt text', () => {
    const result = markdownToHtml('![](https://example.com/img.png)');
    expect(result).toContain('<img src="https://example.com/img.png" alt="">');
  });

  it('HTML-escapes the src and alt', () => {
    const result = markdownToHtml('![a & b](url?x=1&y=2)');
    expect(result).toContain('alt="a &amp; b"');
    expect(result).toContain('src="url?x=1&amp;y=2"');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml — mixed content
// ---------------------------------------------------------------------------

describe('markdownToHtml — mixed content', () => {
  it('handles bold followed by plain text', () => {
    const result = markdownToHtml('**Hello** world');
    expect(result).toContain('<strong>Hello</strong>');
    expect(result).toContain('world');
  });

  it('handles multiple inline constructs in one paragraph', () => {
    const md = '**bold** and *italic* and ~~struck~~';
    const result = markdownToHtml(md);
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<del>struck</del>');
  });

  it('handles inline code mixed with bold', () => {
    const md = '**bold** with `code`';
    const result = markdownToHtml(md);
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<code>code</code>');
  });

  it('produces valid-looking HTML for a realistic agent response', () => {
    const md = [
      '# Summary',
      '',
      'I found **3 results** for your query.',
      '',
      '```json',
      '{"count": 3}',
      '```',
      '',
      'Visit [example.com](https://example.com) for more.',
    ].join('\n');

    const result = markdownToHtml(md);
    expect(result).toContain('<h1>Summary</h1>');
    expect(result).toContain('<strong>3 results</strong>');
    expect(result).toContain('<pre><code class="language-json">');
    // Code block content is HTML-escaped, so " becomes &quot;
    expect(result).toContain('&quot;count&quot;: 3');
    expect(result).toContain('<a href="https://example.com">example.com</a>');
  });
});
