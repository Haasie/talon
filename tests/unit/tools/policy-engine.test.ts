/**
 * Unit tests for PolicyEngine.
 *
 * Tests cover:
 *   - allow: all capabilities granted and in allow list
 *   - deny: missing granted capability
 *   - deny: capability not in allow list (default deny)
 *   - require_approval: capability in requireApproval (takes priority over allow)
 *   - multiple capabilities: all must be granted for allow
 *   - multiple capabilities: any requireApproval triggers require_approval
 *   - multiple capabilities: any missing triggers deny
 *   - empty capabilities: tool with no required capabilities
 */

import { describe, it, expect, vi } from 'vitest';
import { PolicyEngine } from '../../../src/tools/policy-engine.js';
import type { PolicyConfig } from '../../../src/tools/policy-engine.js';
import type { ToolCallRequest, ToolManifest } from '../../../src/tools/tool-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silence pino output in tests. */
function makeLogger(): ReturnType<typeof import('pino').default> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ReturnType<typeof import('pino').default>;
}

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'req-001',
    tool: 'test.tool',
    args: {},
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    ...overrides,
  };
}

function makeManifest(capabilities: string[], name = 'test.tool'): ToolManifest {
  return {
    name,
    description: 'A test tool',
    capabilities,
    executionLocation: 'host',
  };
}

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    allow: [],
    requireApproval: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// allow decisions
// ---------------------------------------------------------------------------

describe('PolicyEngine — allow', () => {
  it('allows when single capability is granted and in allow list', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace']),
      makePolicy({ allow: ['fs.read:workspace'] }),
      ['fs.read:workspace'],
    );
    expect(decision).toBe('allow');
  });

  it('allows when all capabilities are granted and in allow list', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'net.http:egress']),
      makePolicy({ allow: ['fs.read:workspace', 'net.http:egress'] }),
      ['fs.read:workspace', 'net.http:egress'],
    );
    expect(decision).toBe('allow');
  });

  it('allows when tool has no required capabilities', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest([]),
      makePolicy({ allow: [], requireApproval: [] }),
      [],
    );
    expect(decision).toBe('allow');
  });

  it('allows when granted set is a superset of required capabilities', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace']),
      makePolicy({ allow: ['fs.read:workspace', 'net.http:egress'] }),
      ['fs.read:workspace', 'net.http:egress', 'memory.read:thread'],
    );
    expect(decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// deny decisions — missing granted capability
// ---------------------------------------------------------------------------

describe('PolicyEngine — deny (missing granted capability)', () => {
  it('denies when capability is not in grantedCapabilities', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace']),
      makePolicy({ allow: ['fs.read:workspace'] }),
      [], // not granted
    );
    expect(decision).toBe('deny');
  });

  it('denies when some capabilities are granted but one is missing', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'net.http:egress']),
      makePolicy({ allow: ['fs.read:workspace', 'net.http:egress'] }),
      ['fs.read:workspace'], // net.http:egress not granted
    );
    expect(decision).toBe('deny');
  });

  it('denies when all capabilities are missing from granted set', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['channel.send:telegram', 'net.http:egress']),
      makePolicy({ allow: ['channel.send:telegram', 'net.http:egress'] }),
      [],
    );
    expect(decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// deny decisions — default deny (not in allow list)
// ---------------------------------------------------------------------------

describe('PolicyEngine — deny (default deny, not in allow list)', () => {
  it('denies when capability is granted but not in allow list', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace']),
      makePolicy({ allow: [] }), // not in allow
      ['fs.read:workspace'], // but is granted
    );
    expect(decision).toBe('deny');
  });

  it('denies when one capability is in allow but another is not', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'net.http:egress']),
      makePolicy({ allow: ['fs.read:workspace'] }), // net.http:egress missing from allow
      ['fs.read:workspace', 'net.http:egress'],
    );
    expect(decision).toBe('deny');
  });

  it('denies when requireApproval is empty and allow is empty but capability is granted', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['memory.write:thread']),
      makePolicy({ allow: [], requireApproval: [] }),
      ['memory.write:thread'],
    );
    expect(decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// require_approval decisions
// ---------------------------------------------------------------------------

describe('PolicyEngine — require_approval', () => {
  it('returns require_approval when capability is in requireApproval', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['channel.send:telegram']),
      makePolicy({ allow: [], requireApproval: ['channel.send:telegram'] }),
      ['channel.send:telegram'],
    );
    expect(decision).toBe('require_approval');
  });

  it('require_approval takes priority over allow (capability in both lists)', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['channel.send:telegram']),
      makePolicy({
        allow: ['channel.send:telegram'],
        requireApproval: ['channel.send:telegram'],
      }),
      ['channel.send:telegram'],
    );
    expect(decision).toBe('require_approval');
  });

  it('returns require_approval when any capability requires approval (others are allowed)', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'channel.send:telegram']),
      makePolicy({
        allow: ['fs.read:workspace', 'channel.send:telegram'],
        requireApproval: ['channel.send:telegram'],
      }),
      ['fs.read:workspace', 'channel.send:telegram'],
    );
    expect(decision).toBe('require_approval');
  });
});

// ---------------------------------------------------------------------------
// deny takes priority over require_approval
// ---------------------------------------------------------------------------

describe('PolicyEngine — deny takes priority over require_approval', () => {
  it('denies when capability is not granted even if it is in requireApproval', () => {
    const engine = new PolicyEngine(makeLogger());
    // Capability is in requireApproval but NOT in grantedCapabilities.
    // Missing grant → deny (step 1 fires before step 2).
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['channel.send:telegram']),
      makePolicy({ allow: [], requireApproval: ['channel.send:telegram'] }),
      [], // not granted
    );
    expect(decision).toBe('deny');
  });

  it('denies on missing grant even when some other capability needs approval', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'channel.send:telegram']),
      makePolicy({
        allow: ['fs.read:workspace'],
        requireApproval: ['channel.send:telegram'],
      }),
      ['fs.read:workspace'], // channel.send:telegram not granted
    );
    expect(decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Multiple capabilities — interaction tests
// ---------------------------------------------------------------------------

describe('PolicyEngine — multiple capabilities', () => {
  it('all granted and all in allow → allow', () => {
    const engine = new PolicyEngine(makeLogger());
    const caps = ['fs.read:workspace', 'memory.read:thread', 'net.http:egress'];
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(caps),
      makePolicy({ allow: caps }),
      caps,
    );
    expect(decision).toBe('allow');
  });

  it('one missing grant → deny even if others are allowed', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'net.http:egress', 'memory.read:thread']),
      makePolicy({ allow: ['fs.read:workspace', 'net.http:egress', 'memory.read:thread'] }),
      ['fs.read:workspace', 'memory.read:thread'], // net.http:egress missing
    );
    expect(decision).toBe('deny');
  });

  it('one in requireApproval while others are allowed → require_approval', () => {
    const engine = new PolicyEngine(makeLogger());
    const decision = engine.evaluate(
      makeRequest(),
      makeManifest(['fs.read:workspace', 'channel.send:telegram']),
      makePolicy({
        allow: ['fs.read:workspace', 'channel.send:telegram'],
        requireApproval: ['channel.send:telegram'],
      }),
      ['fs.read:workspace', 'channel.send:telegram'],
    );
    expect(decision).toBe('require_approval');
  });
});

// ---------------------------------------------------------------------------
// Request context is not relevant to the decision logic
// ---------------------------------------------------------------------------

describe('PolicyEngine — request metadata does not affect decision', () => {
  it('same capability policy produces same decision for different requestIds', () => {
    const engine = new PolicyEngine(makeLogger());
    const manifest = makeManifest(['fs.read:workspace']);
    const policy = makePolicy({ allow: ['fs.read:workspace'] });
    const granted = ['fs.read:workspace'];

    const d1 = engine.evaluate(makeRequest({ requestId: 'req-A' }), manifest, policy, granted);
    const d2 = engine.evaluate(makeRequest({ requestId: 'req-B' }), manifest, policy, granted);
    expect(d1).toBe('allow');
    expect(d2).toBe('allow');
  });

  it('same policy produces same decision for different personaIds', () => {
    const engine = new PolicyEngine(makeLogger());
    const manifest = makeManifest(['net.http:egress']);
    const policy = makePolicy({ allow: [] });
    const granted: string[] = [];

    const d1 = engine.evaluate(makeRequest({ personaId: 'persona-A' }), manifest, policy, granted);
    const d2 = engine.evaluate(makeRequest({ personaId: 'persona-B' }), manifest, policy, granted);
    expect(d1).toBe('deny');
    expect(d2).toBe('deny');
  });
});
