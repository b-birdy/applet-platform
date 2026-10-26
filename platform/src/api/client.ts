// fetch 包装：cookie 凭证、统一错误对象
export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export async function api<T = any>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const init: RequestInit = {
    method: opts?.method ?? 'GET',
    credentials: 'include',
    headers: {} as Record<string, string>,
  };
  if (opts?.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let detail: unknown = null;
    try {
      const json = await res.json();
      code = json.error ?? json.code ?? code;
      detail = json;
    } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(res.status, code, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
