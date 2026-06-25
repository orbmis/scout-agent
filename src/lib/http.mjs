// http.mjs — the single network seam. Collectors call only these helpers, so
// tests can stub the whole module to run end-to-end with no network.

const DEFAULT_TIMEOUT_MS = 30000;

export async function getText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, ua } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua || "scout-signal-scan", ...headers },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, opts = {}) {
  const res = await getText(url, opts);
  if (!res.ok) return { ...res, json: null };
  try {
    return { ...res, json: JSON.parse(res.text) };
  } catch {
    return { ...res, json: null };
  }
}
