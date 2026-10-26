import { describe, expect, it, beforeEach, vi } from 'vitest';
import { api, ApiError } from './client';

const OK = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('returns parsed JSON on 2xx with cookies included', async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      expect(url).toBe('/api/me');
      expect(init.credentials).toBe('include');
      return OK({ username: 'admin', role: 'superadmin' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const me = await api('/api/me');
    expect(me.username).toBe('admin');
  });

  it('throws ApiError with code/status on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 })
    ));
    try {
      await api('/api/me');
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(401);
      expect(err.code).toBe('UNAUTHORIZED');
    }
  });

  it('passes method/body through', async () => {
    const fetchMock = vi.fn(async (_url: any, init?: any) => {
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ a: 1 }));
      return OK({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/auth/login', { method: 'POST', body: { a: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
