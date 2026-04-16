export function mockResponse({ status = 200, body = "", json, headers = {} } = {}) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => lowered[String(k).toLowerCase()] ?? null },
    async text() { return body; },
    async json() { return json ?? JSON.parse(body || "{}"); }
  };
}

export function installFetchMock(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = typeof url === "string" ? url : url.toString();
    const res = await handler(u, opts);
    if (!res) throw new Error(`no mock response configured for ${u}`);
    return res;
  };
  return () => { globalThis.fetch = orig; };
}

export function routeMock(routes) {
  return installFetchMock(async (url) => {
    for (const r of routes) {
      if (r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match)) {
        return mockResponse(r);
      }
    }
    return mockResponse({ status: 200, body: "" });
  });
}
