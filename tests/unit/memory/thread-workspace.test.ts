import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ThreadWorkspace } from '../../../src/memory/thread-workspace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thread-workspace-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ThreadWorkspace', () => {
  let dataDir: string;
  let workspace: ThreadWorkspace;

  beforeEach(() => {
    dataDir = makeTmpDir();
    workspace = new ThreadWorkspace(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  describe('path helpers', () => {
    it('getThreadDir returns correct path', () => {
      expect(workspace.getThreadDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001'),
      );
    });

    it('getMemoryDir returns correct path', () => {
      expect(workspace.getMemoryDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'memory'),
      );
    });

    it('getAttachmentsDir returns correct path', () => {
      expect(workspace.getAttachmentsDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'attachments'),
      );
    });

    it('getArtifactsDir returns correct path', () => {
      expect(workspace.getArtifactsDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'artifacts'),
      );
    });

    it('getIpcInputDir returns correct path', () => {
      expect(workspace.getIpcInputDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'ipc', 'input'),
      );
    });

    it('getIpcOutputDir returns correct path', () => {
      expect(workspace.getIpcOutputDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'ipc', 'output'),
      );
    });

    it('getIpcErrorsDir returns correct path', () => {
      expect(workspace.getIpcErrorsDir('t-001')).toBe(
        path.join(dataDir, 'threads', 't-001', 'ipc', 'errors'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // ensureDirectories
  // -------------------------------------------------------------------------

  describe('ensureDirectories()', () => {
    it('returns Ok with the thread directory path', () => {
      const result = workspace.ensureDirectories('t-001');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(workspace.getThreadDir('t-001'));
    });

    it('creates all required subdirectories', () => {
      workspace.ensureDirectories('t-002');

      const expectedDirs = [
        workspace.getMemoryDir('t-002'),
        workspace.getAttachmentsDir('t-002'),
        workspace.getArtifactsDir('t-002'),
        workspace.getIpcInputDir('t-002'),
        workspace.getIpcOutputDir('t-002'),
        workspace.getIpcErrorsDir('t-002'),
      ];

      for (const dir of expectedDirs) {
        const stat = fs.statSync(dir);
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it('is idempotent — calling twice does not error', () => {
      workspace.ensureDirectories('t-003');
      const result = workspace.ensureDirectories('t-003');
      expect(result.isOk()).toBe(true);
    });

    it('returns Err when dataDir is not writable', () => {
      // Create a file where the threads directory should be to block creation.
      const threadsPath = path.join(dataDir, 'threads');
      fs.writeFileSync(threadsPath, 'block');

      const result = workspace.ensureDirectories('t-004');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('MEMORY_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // exists()
  // -------------------------------------------------------------------------

  describe('exists()', () => {
    it('returns false for a thread that has no directory', () => {
      expect(workspace.exists('nonexistent')).toBe(false);
    });

    it('returns true after ensureDirectories', () => {
      workspace.ensureDirectories('t-005');
      expect(workspace.exists('t-005')).toBe(true);
    });

    it('returns false when the path is a file, not a directory', () => {
      const threadsDir = path.join(dataDir, 'threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      const filePath = path.join(threadsDir, 't-file');
      fs.writeFileSync(filePath, 'not a dir');

      expect(workspace.exists('t-file')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // listThreads()
  // -------------------------------------------------------------------------

  describe('listThreads()', () => {
    it('returns empty array when threads root does not exist', () => {
      const emptyWorkspace = new ThreadWorkspace(path.join(dataDir, 'nonexistent'));
      expect(emptyWorkspace.listThreads()).toEqual([]);
    });

    it('returns thread IDs for all thread directories', () => {
      workspace.ensureDirectories('thread-a');
      workspace.ensureDirectories('thread-b');
      workspace.ensureDirectories('thread-c');

      const threads = workspace.listThreads();
      expect(threads).toHaveLength(3);
      expect(threads).toContain('thread-a');
      expect(threads).toContain('thread-b');
      expect(threads).toContain('thread-c');
    });

    it('excludes files from the threads root', () => {
      const threadsRoot = path.join(dataDir, 'threads');
      fs.mkdirSync(threadsRoot, { recursive: true });
      // Create a file inside threads/ — should not appear in results.
      fs.writeFileSync(path.join(threadsRoot, 'not-a-thread.txt'), 'data');
      workspace.ensureDirectories('valid-thread');

      const threads = workspace.listThreads();
      expect(threads).toContain('valid-thread');
      expect(threads).not.toContain('not-a-thread.txt');
    });

    it('returns distinct thread IDs', () => {
      workspace.ensureDirectories('dup-a');
      workspace.ensureDirectories('dup-b');

      const threads = workspace.listThreads();
      const unique = new Set(threads);
      expect(unique.size).toBe(threads.length);
    });
  });
});
