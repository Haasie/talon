import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

export interface SearchMatch {
  path: string;
  line: number;
  content: string;
  context: string;
}

const DEFAULT_EXTENSIONS = ['.md', '.txt', '.ts', '.js'];
const MAX_FILE_SIZE = 1_048_576; // 1 MB
const NULL_BYTE_CHECK_SIZE = 512;

interface SearchOptions {
  extensions?: string[];
  maxResults?: number;
  contextLines?: number;
}

/**
 * Recursively search files within the given root paths for lines matching
 * the query string. Returns matches with surrounding context lines.
 */
export async function searchFiles(
  rootPaths: string[],
  query: string,
  options?: SearchOptions,
): Promise<SearchMatch[]> {
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  const maxResults = options?.maxResults ?? 50;
  const contextLines = options?.contextLines ?? 2;
  const matches: SearchMatch[] = [];

  const pattern = new RegExp(escapeRegExp(query), 'i');

  for (const rootPath of rootPaths) {
    if (matches.length >= maxResults) break;

    let entries: string[];
    try {
      entries = await listFiles(rootPath, extensions);
    } catch {
      // Skip inaccessible directories
      continue;
    }

    for (const filePath of entries) {
      if (matches.length >= maxResults) break;

      try {
        const content = await readFileSafe(filePath);
        if (content === null) continue;

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;

          if (pattern.test(lines[i])) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            const contextSlice = lines.slice(start, end + 1).join('\n');

            matches.push({
              path: filePath,
              line: i + 1,
              content: lines[i],
              context: contextSlice,
            });
          }
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }
  }

  return matches;
}

/**
 * Recursively list all files under `dir` that match the given extensions.
 */
async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!extensions.includes(ext)) continue;
    const fullPath = join(entry.parentPath ?? entry.path, entry.name);
    results.push(fullPath);
  }

  return results;
}

/**
 * Read a file safely: skip if too large or if it appears to be binary.
 * Returns null if the file should be skipped.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    // Check size before reading to avoid loading huge files into memory
    const st = await stat(filePath);
    if (st.size > MAX_FILE_SIZE) return null;

    const buf = await readFile(filePath);

    // Check for null bytes in the first chunk — indicates binary
    const checkLen = Math.min(buf.length, NULL_BYTE_CHECK_SIZE);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) return null;
    }

    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
