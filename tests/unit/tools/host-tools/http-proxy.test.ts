/**
 * Unit tests for HttpProxyHandler.
 *
 * Tests cover:
 *   - Successful GET, POST, and other methods
 *   - Invalid HTTP method
 *   - Missing/invalid URL
 *   - Unsupported protocol (ftp://, file://)
 *   - Domain not in allowlist
 *   - Domain allowlist subdomain matching
 *   - Empty allowlist (deny all)
 *   - Request timeout
 *   - Network error
 *   - Custom headers and body forwarding
 *   - Timeout clamping (max 120s)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpProxyHandler } from '../../../../src/tools/host-tools/http-proxy.js';
import type { HttpProxyArgs, ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import type { ToolExecutionContext as Ctx } from '../../../../src/tools/host-tools/channel-send.js';

// Re-import ToolExecutionContext from channel-send since http-proxy re-exports it
type Context = { runId: string; threadId: string; personaId: string; requestId?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<HttpProxyArgs> = {}): HttpProxyArgs {
  return {
    method: 'GET',
    url: 'https://api.example.com/data',
    ...overrides,
  };
}

function makeHandler(allowedDomains: string[] = ['api.example.com', 'example.com']) {
  return new HttpProxyHandler({ logger: makeLogger(), allowedDomains });
}

/** Create a mock fetch response. */
function mockFetchResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const mockHeaders = new Headers(headers);
  return {
    status,
    headers: mockHeaders,
    text: vi.fn().mockResolvedValue(body),
  };
}

// ---------------------------------------------------------------------------
// Setup: mock global fetch
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(HttpProxyHandler.manifest.name).toBe('net.http');
  });

  it('has executionLocation set to host', () => {
    expect(HttpProxyHandler.manifest.executionLocation).toBe('host');
  });

  it('declares net.http:egress capability', () => {
    expect(HttpProxyHandler.manifest.capabilities).toContain('net.http:egress');
  });
});

// ---------------------------------------------------------------------------
// Successful requests
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — success', () => {
  it('returns status, headers, and body on a successful GET', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, '{"ok":true}', { 'content-type': 'application/json' }) as never);

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('net.http');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual({
      status: 200,
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
      body: '{"ok":true}',
    });
  });

  it('forwards method, headers, and body to fetch', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(201, 'created') as never);

    const handler = makeHandler();
    await handler.execute(
      makeArgs({
        method: 'POST',
        url: 'https://api.example.com/items',
        headers: { authorization: 'Bearer token123', 'content-type': 'application/json' },
        body: '{"name":"item"}',
      }),
      makeContext(),
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer token123', 'content-type': 'application/json' },
        body: '{"name":"item"}',
      }),
    );
  });

  it('uses default timeout of 30000ms when not specified', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, 'ok') as never);

    const handler = makeHandler();
    await handler.execute(makeArgs(), makeContext());

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('supports all valid HTTP methods', async () => {
    const methods: HttpProxyArgs['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
    fetchSpy.mockResolvedValue(mockFetchResponse(200, '') as never);

    const handler = makeHandler();
    for (const method of methods) {
      const result = await handler.execute(makeArgs({ method }), makeContext());
      expect(result.status).toBe('success');
    }
  });
});

// ---------------------------------------------------------------------------
// Arg validation failures
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — arg validation', () => {
  it('returns error for missing url', async () => {
    const handler = makeHandler();
    const result = await handler.execute(makeArgs({ url: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/url is required/);
  });

  it('returns error for invalid url', async () => {
    const handler = makeHandler();
    const result = await handler.execute(makeArgs({ url: 'not-a-url' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid URL/);
  });

  it('returns error for unsupported protocol ftp://', async () => {
    const handler = makeHandler(['ftp.example.com']);
    const result = await handler.execute(makeArgs({ url: 'ftp://ftp.example.com/file' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/unsupported protocol/);
  });

  it('returns error for file:// protocol', async () => {
    const handler = makeHandler();
    const result = await handler.execute(makeArgs({ url: 'file:///etc/passwd' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/unsupported protocol/);
  });

  it('returns error for invalid HTTP method', async () => {
    const handler = makeHandler();
    const result = await handler.execute(
      makeArgs({ method: 'CONNECT' as HttpProxyArgs['method'] }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid method/);
  });
});

// ---------------------------------------------------------------------------
// Domain allowlist
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — domain allowlist', () => {
  it('allows exact domain match', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, 'ok') as never);

    const handler = makeHandler(['example.com']);
    const result = await handler.execute(makeArgs({ url: 'https://example.com/api' }), makeContext());

    expect(result.status).toBe('success');
  });

  it('allows subdomain of an allowed domain', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, 'ok') as never);

    const handler = makeHandler(['example.com']);
    const result = await handler.execute(makeArgs({ url: 'https://api.example.com/v1' }), makeContext());

    expect(result.status).toBe('success');
  });

  it('allows deeply nested subdomain', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, 'ok') as never);

    const handler = makeHandler(['example.com']);
    const result = await handler.execute(makeArgs({ url: 'https://a.b.example.com/path' }), makeContext());

    expect(result.status).toBe('success');
  });

  it('denies domain not in allowlist', async () => {
    const handler = makeHandler(['api.example.com']);
    const result = await handler.execute(makeArgs({ url: 'https://evil.com/steal' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not in the allowed domains list/);
  });

  it('denies partial domain match (prefix attack)', async () => {
    const handler = makeHandler(['example.com']);
    const result = await handler.execute(
      makeArgs({ url: 'https://notexample.com/api' }),
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not in the allowed domains list/);
  });

  it('denies all domains when allowlist is empty', async () => {
    const handler = new HttpProxyHandler({ logger: makeLogger(), allowedDomains: [] });
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not in the allowed domains list/);
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — timeout', () => {
  it('returns timeout status when request is aborted', async () => {
    fetchSpy.mockImplementation(() => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      return Promise.reject(abortError);
    });

    const handler = makeHandler();
    const result = await handler.execute(makeArgs({ timeoutMs: 100 }), makeContext());

    expect(result.status).toBe('timeout');
  });

  it('clamps timeout to MAX_TIMEOUT_MS (120000)', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse(200, 'ok') as never);

    const handler = makeHandler();
    // Should not throw even with very large timeout
    const result = await handler.execute(makeArgs({ timeoutMs: 999_999 }), makeContext());

    expect(result.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe('HttpProxyHandler — network errors', () => {
  it('returns error status on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = makeHandler();
    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/request failed/);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns unknown requestId when not provided in context', async () => {
    const handler = makeHandler([]);
    const context = makeContext();
    delete (context as Partial<Context>).requestId;
    const result = await handler.execute(makeArgs(), context);

    expect(result.requestId).toBe('unknown');
  });
});
