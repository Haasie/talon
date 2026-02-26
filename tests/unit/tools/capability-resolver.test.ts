/**
 * Unit tests for capability-resolver utilities.
 *
 * Tests cover:
 *   - resolveCapabilities: full intersection, partial intersection, no intersection,
 *     empty inputs, duplicates, unmet only
 *   - hasCapability: present, absent, empty granted, empty required string
 *   - isValidCapabilityLabel: valid labels, missing scope, missing action,
 *     empty string, wrong separators, extra segments
 */

import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities,
  hasCapability,
  isValidCapabilityLabel,
} from '../../../src/tools/capability-resolver.js';

// ---------------------------------------------------------------------------
// resolveCapabilities
// ---------------------------------------------------------------------------

describe('resolveCapabilities — full intersection', () => {
  it('all skill requirements satisfied by persona allowlist', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace', 'net.http:egress', 'channel.send:telegram'],
      ['fs.read:workspace', 'net.http:egress'],
    );
    expect(result.granted).toHaveLength(2);
    expect(result.granted).toContain('fs.read:workspace');
    expect(result.granted).toContain('net.http:egress');
    expect(result.unmet).toHaveLength(0);
  });

  it('single capability fully satisfied', () => {
    const result = resolveCapabilities(['memory.write:thread'], ['memory.write:thread']);
    expect(result.granted).toEqual(['memory.write:thread']);
    expect(result.unmet).toEqual([]);
  });
});

describe('resolveCapabilities — partial intersection', () => {
  it('some skill requirements in allowlist, some not', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace', 'net.http:egress'],
      ['fs.read:workspace', 'channel.send:telegram'],
    );
    expect(result.granted).toEqual(['fs.read:workspace']);
    expect(result.unmet).toEqual(['channel.send:telegram']);
  });

  it('one granted one unmet', () => {
    const result = resolveCapabilities(
      ['memory.read:thread'],
      ['memory.read:thread', 'memory.write:thread'],
    );
    expect(result.granted).toContain('memory.read:thread');
    expect(result.unmet).toContain('memory.write:thread');
  });
});

describe('resolveCapabilities — no intersection', () => {
  it('none of the skill requirements are in the allowlist', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace'],
      ['net.http:egress', 'channel.send:telegram'],
    );
    expect(result.granted).toHaveLength(0);
    expect(result.unmet).toHaveLength(2);
    expect(result.unmet).toContain('net.http:egress');
    expect(result.unmet).toContain('channel.send:telegram');
  });
});

describe('resolveCapabilities — empty inputs', () => {
  it('empty allowlist and empty required → both empty', () => {
    const result = resolveCapabilities([], []);
    expect(result.granted).toEqual([]);
    expect(result.unmet).toEqual([]);
  });

  it('empty allowlist, non-empty required → all unmet', () => {
    const result = resolveCapabilities([], ['fs.read:workspace', 'net.http:egress']);
    expect(result.granted).toEqual([]);
    expect(result.unmet).toHaveLength(2);
  });

  it('non-empty allowlist, empty required → both empty', () => {
    const result = resolveCapabilities(['fs.read:workspace', 'net.http:egress'], []);
    expect(result.granted).toEqual([]);
    expect(result.unmet).toEqual([]);
  });
});

describe('resolveCapabilities — duplicates', () => {
  it('deduplicates repeated entries in skillRequired', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace'],
      ['fs.read:workspace', 'fs.read:workspace'],
    );
    // Deduplication means only one entry
    expect(result.granted).toHaveLength(1);
    expect(result.granted).toContain('fs.read:workspace');
  });

  it('deduplicates repeated entries in personaAllow', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace', 'fs.read:workspace'],
      ['fs.read:workspace'],
    );
    expect(result.granted).toHaveLength(1);
  });

  it('deduplicates repeated unmet entries', () => {
    const result = resolveCapabilities(
      [],
      ['net.http:egress', 'net.http:egress'],
    );
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet).toContain('net.http:egress');
  });
});

describe('resolveCapabilities — allowlist superset of required', () => {
  it('extra allowlist entries do not appear in granted or unmet', () => {
    const result = resolveCapabilities(
      ['fs.read:workspace', 'net.http:egress', 'memory.write:thread'],
      ['fs.read:workspace'],
    );
    expect(result.granted).toEqual(['fs.read:workspace']);
    expect(result.unmet).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe('hasCapability', () => {
  it('returns true when the required capability is in the granted array', () => {
    expect(hasCapability(['fs.read:workspace', 'net.http:egress'], 'fs.read:workspace')).toBe(true);
  });

  it('returns false when the required capability is NOT in the granted array', () => {
    expect(hasCapability(['fs.read:workspace'], 'net.http:egress')).toBe(false);
  });

  it('returns false for an empty granted array', () => {
    expect(hasCapability([], 'fs.read:workspace')).toBe(false);
  });

  it('returns false when required is empty string', () => {
    expect(hasCapability(['fs.read:workspace'], '')).toBe(false);
  });

  it('is case-sensitive — different case does not match', () => {
    expect(hasCapability(['FS.READ:WORKSPACE'], 'fs.read:workspace')).toBe(false);
  });

  it('requires exact match — prefix does not match', () => {
    expect(hasCapability(['fs.read:workspace'], 'fs.read')).toBe(false);
  });

  it('requires exact match — suffix does not match', () => {
    expect(hasCapability(['fs.read:workspace'], 'read:workspace')).toBe(false);
  });

  it('returns true when the capability is the only element', () => {
    expect(hasCapability(['channel.send:telegram'], 'channel.send:telegram')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidCapabilityLabel
// ---------------------------------------------------------------------------

describe('isValidCapabilityLabel — valid labels', () => {
  it('accepts a standard domain.action:scope label', () => {
    expect(isValidCapabilityLabel('fs.read:workspace')).toBe(true);
  });

  it('accepts net.http:egress', () => {
    expect(isValidCapabilityLabel('net.http:egress')).toBe(true);
  });

  it('accepts channel.send:telegram', () => {
    expect(isValidCapabilityLabel('channel.send:telegram')).toBe(true);
  });

  it('accepts memory.write:thread', () => {
    expect(isValidCapabilityLabel('memory.write:thread')).toBe(true);
  });

  it('accepts labels with underscores in each segment', () => {
    expect(isValidCapabilityLabel('my_domain.some_action:my_scope')).toBe(true);
  });

  it('accepts single-character segments', () => {
    expect(isValidCapabilityLabel('a.b:c')).toBe(true);
  });
});

describe('isValidCapabilityLabel — invalid labels', () => {
  it('rejects an empty string', () => {
    expect(isValidCapabilityLabel('')).toBe(false);
  });

  it('rejects a label missing the scope (no colon)', () => {
    expect(isValidCapabilityLabel('fs.read')).toBe(false);
  });

  it('rejects a label missing the action (no dot)', () => {
    expect(isValidCapabilityLabel('fs:workspace')).toBe(false);
  });

  it('rejects a label with only domain (no separators)', () => {
    expect(isValidCapabilityLabel('fsread')).toBe(false);
  });

  it('rejects a label with empty domain segment', () => {
    expect(isValidCapabilityLabel('.read:workspace')).toBe(false);
  });

  it('rejects a label with empty action segment', () => {
    expect(isValidCapabilityLabel('fs.:workspace')).toBe(false);
  });

  it('rejects a label with empty scope segment', () => {
    expect(isValidCapabilityLabel('fs.read:')).toBe(false);
  });

  it('rejects a label with a space in it', () => {
    expect(isValidCapabilityLabel('fs.read: workspace')).toBe(false);
  });

  it('rejects a label with a hyphen (not a word character)', () => {
    expect(isValidCapabilityLabel('fs.read:my-scope')).toBe(false);
  });

  it('rejects a label with extra colon segments', () => {
    expect(isValidCapabilityLabel('fs.read:workspace:extra')).toBe(false);
  });

  it('rejects a label with extra dot segments', () => {
    expect(isValidCapabilityLabel('fs.sub.read:workspace')).toBe(false);
  });
});
