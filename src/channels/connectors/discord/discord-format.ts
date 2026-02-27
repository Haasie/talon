/**
 * Discord Markdown format conversion utilities.
 *
 * Discord supports near-standard Markdown natively, so most constructs pass
 * through unchanged. This module strips or transforms the small set of
 * Markdown features that Discord does not render correctly:
 *
 * - Images (![alt](url)) → alt text followed by the URL
 * - HTML tables → simplified plain-text representation
 * - ATX headings (# ## ###) — Discord supports these natively, pass through
 *
 * Reference: https://support.discord.com/hc/en-us/articles/210298617
 */

// ---------------------------------------------------------------------------
// markdownToDiscord
// ---------------------------------------------------------------------------

/**
 * Convert a standard Markdown string to Discord-compatible format.
 *
 * Most Markdown constructs pass through unchanged because Discord renders
 * a large subset natively. The following transformations are applied:
 *
 * - Images (`![alt](url)`) → `alt text (url)` — Discord cannot embed images
 *   via message content; the alt text plus URL is preserved as plain text.
 * - Markdown tables → simplified text representation — complex table syntax
 *   does not render in Discord; rows are joined with pipe separators.
 *
 * @param markdown - Standard Markdown input.
 * @returns Discord-compatible formatted string.
 */
export function markdownToDiscord(markdown: string): string {
  if (!markdown) return markdown;

  let result = markdown;

  // Step 1: Process fenced code blocks first to extract and protect their
  // contents from being modified by subsequent passes.
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `\x00CODE_BLOCK_${codeBlocks.length}\x00`;
    codeBlocks.push(match);
    return placeholder;
  });

  // Step 2: Also protect inline code from modification.
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    const placeholder = `\x00INLINE_CODE_${inlineCodes.length}\x00`;
    inlineCodes.push(match);
    return placeholder;
  });

  // Step 3: Convert images to alt text + URL.
  result = convertImages(result);

  // Step 4: Convert markdown tables to simplified text.
  result = convertTables(result);

  // Step 5: Restore inline codes.
  result = result.replace(/\x00INLINE_CODE_(\d+)\x00/g, (_match, idx: string) => {
    return inlineCodes[parseInt(idx, 10)] ?? '';
  });

  // Step 6: Restore code blocks.
  result = result.replace(/\x00CODE_BLOCK_(\d+)\x00/g, (_match, idx: string) => {
    return codeBlocks[parseInt(idx, 10)] ?? '';
  });

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert Markdown image syntax to alt text followed by the URL.
 *
 * Discord cannot display embedded images in message content. Instead, the
 * image alt text is preserved and the URL is appended so the user still has
 * access to the image.
 *
 * Examples:
 * - `![screenshot](https://example.com/img.png)` → `screenshot (https://example.com/img.png)`
 * - `![](https://example.com/img.png)` → `https://example.com/img.png`
 *
 * @param text - Text to process (code blocks should already be protected).
 * @returns Text with image syntax replaced.
 */
function convertImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, url: string) => {
    if (alt.trim()) {
      return `${alt.trim()} (${url})`;
    }
    return url;
  });
}

/**
 * Convert Markdown table syntax to a simplified plain-text representation.
 *
 * Discord's message renderer does not support Markdown tables. This function
 * strips the separator row and joins data rows with ` | ` delimiters so the
 * table content remains legible as plain text.
 *
 * A Markdown table looks like:
 * ```
 * | Col A | Col B |
 * |-------|-------|
 * | val1  | val2  |
 * ```
 *
 * @param text - Text to process.
 * @returns Text with table syntax simplified.
 */
function convertTables(text: string): string {
  // Match a block of lines where at least one line starts and ends with |
  // and there is a separator row (|---|) present.
  const tablePattern = /^(\|.+\|\n)((?:\|[-:| ]+\|\n))(\|.+\|\n?)+/gm;

  return text.replace(tablePattern, (tableMatch) => {
    const lines = tableMatch.split('\n').filter((line) => line.trim() !== '');

    const result: string[] = [];
    for (const line of lines) {
      // Skip separator rows (lines like |---|---|).
      if (/^\|[\s\-:| ]+\|$/.test(line.trim())) {
        continue;
      }
      // Parse cells: split by | and trim each cell.
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '');
      if (cells.length > 0) {
        result.push(cells.join(' | '));
      }
    }

    return result.join('\n');
  });
}
