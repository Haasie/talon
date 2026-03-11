import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory filesystem stub
// ---------------------------------------------------------------------------

interface FsEntry {
  name: string;
  parentPath: string;
  isFile: () => boolean;
}

let fileSystem: Record<string, Buffer> = {};

function buildEntries(root: string): FsEntry[] {
  const entries: FsEntry[] = [];
  for (const fullPath of Object.keys(fileSystem)) {
    if (!fullPath.startsWith(root + '/') && fullPath !== root) continue;
    const relative = fullPath.slice(root.length + 1);
    const parts = relative.split('/');
    const name = parts[parts.length - 1];
    const parentPath = fullPath.slice(0, fullPath.length - name.length - 1) || root;
    entries.push({
      name,
      parentPath,
      isFile: () => true,
    });
  }
  return entries;
}

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async (dir: string, _opts?: any) => {
    const entries = buildEntries(dir);
    if (entries.length === 0 && !Object.keys(fileSystem).some((k) => k.startsWith(dir))) {
      throw new Error(`ENOENT: no such directory '${dir}'`);
    }
    return entries;
  }),
  readFile: vi.fn(async (path: string) => {
    const buf = fileSystem[path];
    if (!buf) throw new Error(`ENOENT: no such file '${path}'`);
    return buf;
  }),
  stat: vi.fn(async (path: string) => {
    const buf = fileSystem[path];
    if (!buf) throw new Error(`ENOENT: no such file '${path}'`);
    return { size: buf.length };
  }),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify([
      { path: '/test/root/notes.md', snippet: 'deployment steps for production', relevance: 0.95 },
      { path: '/test/root/log.md', snippet: 'deployed to production yesterday', relevance: 0.7 },
    ]),
    usage: { inputTokens: 300, outputTokens: 100 },
  }),
}));

import { searchFiles } from '../../../subagents/file-searcher/lib/search.js';
import { run } from '../../../subagents/file-searcher/index.js';

const makeCtx = () => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a search ranking assistant.',
  model: {} as any,
  maxOutputTokens: 4096,
  services: {
    memory: {} as any,
    schedules: {} as any,
    personas: {} as any,
    channels: {} as any,
    threads: {} as any,
    messages: {} as any,
    runs: {} as any,
    queue: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  },
});

function setFs(files: Record<string, string>): void {
  fileSystem = {};
  for (const [path, content] of Object.entries(files)) {
    fileSystem[path] = Buffer.from(content, 'utf-8');
  }
}

function setFsBinary(files: Record<string, Buffer>): void {
  for (const [path, buf] of Object.entries(files)) {
    fileSystem[path] = buf;
  }
}

beforeEach(() => {
  fileSystem = {};
});

// ---------------------------------------------------------------------------
// search helper tests
// ---------------------------------------------------------------------------

describe('searchFiles', () => {
  it('finds matching files and returns results', async () => {
    setFs({
      '/test/root/readme.md': 'line one\nfind this needle here\nline three',
      '/test/root/other.txt': 'nothing useful\njust filler',
    });

    const results = await searchFiles(['/test/root'], 'needle');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/test/root/readme.md');
    expect(results[0].line).toBe(2);
    expect(results[0].content).toContain('needle');
    expect(results[0].context).toContain('line one');
    expect(results[0].context).toContain('line three');
  });

  it('returns empty for no matches', async () => {
    setFs({
      '/test/root/readme.md': 'nothing here at all',
    });

    const results = await searchFiles(['/test/root'], 'nonexistent');
    expect(results).toHaveLength(0);
  });

  it('skips binary files (null bytes)', async () => {
    setFs({
      '/test/root/clean.md': 'this has the needle keyword',
    });
    // Add a binary file with null bytes
    const binaryBuf = Buffer.alloc(100);
    binaryBuf.write('text');
    binaryBuf[4] = 0; // null byte
    binaryBuf.write('needle', 10);
    setFsBinary({
      '/test/root/binary.md': binaryBuf,
    });

    const results = await searchFiles(['/test/root'], 'needle');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/test/root/clean.md');
  });

  it('respects maxResults limit', async () => {
    setFs({
      '/test/root/file.md': 'match\nmatch\nmatch\nmatch\nmatch\nmatch',
    });

    const results = await searchFiles(['/test/root'], 'match', { maxResults: 3 });
    expect(results).toHaveLength(3);
  });

  it('filters by file extension', async () => {
    setFs({
      '/test/root/notes.md': 'find this needle',
      '/test/root/data.json': 'also has needle',
    });

    const results = await searchFiles(['/test/root'], 'needle', {
      extensions: ['.md'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/test/root/notes.md');
  });

  it('handles inaccessible directories gracefully', async () => {
    const results = await searchFiles(['/nonexistent/path'], 'query');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// run function tests
// ---------------------------------------------------------------------------

describe('file-searcher run', () => {
  it('returns error for empty query', async () => {
    const result = await run(makeCtx(), { query: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('returns error when query is not provided', async () => {
    const result = await run(makeCtx(), {});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('rejects rootPaths outside allowed scope', async () => {
    const result = await run(makeCtx(), {
      query: 'test',
      rootPaths: ['/etc/shadow'],
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('outside the allowed search scope');
  });

  it('accepts rootPaths that are sub-paths of allowed roots', async () => {
    setFs({
      '/home/talon/cf-notes/sub/readme.md': 'some content with needle',
    });

    const result = await run(makeCtx(), {
      query: 'needle',
      rootPaths: ['/home/talon/cf-notes/sub'],
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('1 match');
  });

  it('returns empty results when no files match', async () => {
    setFs({
      '/home/talon/cf-notes/readme.md': 'nothing relevant',
    });

    // Uses default rootPaths (no override)
    const result = await run(makeCtx(), {
      query: 'nonexistent',
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('No files matched');
    expect((value.data as any).results).toHaveLength(0);
  });

  it('returns matches directly when count is within threshold', async () => {
    setFs({
      '/home/talon/cf-notes/notes.md': 'deployment steps for production',
    });

    const result = await run(makeCtx(), {
      query: 'deployment',
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('1 match');
    expect((value.data as any).results).toHaveLength(1);
    expect((value.data as any).results[0].path).toBe('/home/talon/cf-notes/notes.md');
    // No LLM was used, so no usage stats
    expect(value.usage).toBeUndefined();
  });

  it('uses LLM ranking when matches exceed threshold', async () => {
    // Create enough matches to trigger LLM ranking (> 20)
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(`line ${i} has the deploy keyword`);
    }
    setFs({
      '/home/talon/cf-notes/big.md': lines.join('\n'),
    });

    const result = await run(makeCtx(), {
      query: 'deploy',
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('ranked');
    expect(value.usage).toBeDefined();
    expect(value.usage!.inputTokens).toBe(300);
  });
});
