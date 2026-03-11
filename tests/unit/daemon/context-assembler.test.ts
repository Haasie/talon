import { describe, it, expect, vi } from 'vitest';
import { ok } from 'neverthrow';

import { ContextAssembler, type ContextAssemblerDeps } from '../../../src/daemon/context-assembler.js';

const makeDeps = (overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    findByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  recentMessageCount: 10,
  ...overrides,
});

describe('ContextAssembler', () => {
  it('returns empty string when no summary and no recent messages', () => {
    const assembler = new ContextAssembler(makeDeps());
    const result = assembler.assemble('thread-1');
    expect(result).toBe('');
  });

  it('includes session summary when available', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          {
            id: 'sum-1',
            thread_id: 'thread-1',
            type: 'summary',
            content: 'Discussed deployment plans.\n\nKey facts:\n- Using Docker\n\nOpen threads:\n- CI pipeline',
            created_at: 1000,
          },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Previous Context');
    expect(result).toContain('read-only summary');
    expect(result).toContain('Discussed deployment plans');
    expect(result).toContain('Using Docker');
  });

  it('includes recent messages when available', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'how is the deploy going?' }) },
          { direction: 'outbound', content: JSON.stringify({ body: 'All green, deployed 5 minutes ago.' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Recent Messages');
    expect(result).toContain('User: how is the deploy going?');
    expect(result).toContain('Assistant: All green, deployed 5 minutes ago.');
  });

  it('includes both summary and recent messages', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-1', type: 'summary', content: 'Previous session summary.', created_at: 1000 },
        ])),
      } as any,
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'latest question' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Previous Context');
    expect(result).toContain('Previous session summary.');
    expect(result).toContain('Recent Messages');
    expect(result).toContain('User: latest question');
  });

  it('uses only the most recent summary', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThread: vi.fn().mockReturnValue(ok([
          { id: 'sum-new', type: 'summary', content: 'New summary.', created_at: 2000 },
          { id: 'sum-old', type: 'summary', content: 'Old summary.', created_at: 1000 },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('New summary.');
    // Should only include one Previous Context section
    expect(result.match(/## Previous Context/g)?.length).toBe(1);
  });

  it('handles non-JSON message content', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: 'plain text' },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('User: plain text');
  });
});
