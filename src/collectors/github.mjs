// github.mjs — releases on tracked repos + new/changed EIP files in ethereum/EIPs.

import { getJson } from "../lib/http.mjs";

export async function collect({
  windowHours,
  sources,
  secrets,
  filters,
  metadata,
  nowMs = Date.now(),
  http = { getJson },
}) {
  const cfg = sources.github || {};
  const diag = { repos_polled: 0, releases: 0, eip_changes: 0 };
  const cutoff = Math.floor(nowMs / 1000) - windowHours * 3600;
  const cutoffIso = new Date(cutoff * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const items = [];

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (secrets.GITHUB_TOKEN) headers.Authorization = `Bearer ${secrets.GITHUB_TOKEN}`;
  const api = (path) => http.getJson(`https://api.github.com${path}`, { headers, ua: "scout-github-scan" });

  // ----- Release watch -----
  for (const { owner, repo } of cfg.release_watch || []) {
    diag.repos_polled += 1;
    const res = await api(`/repos/${owner}/${repo}/releases?per_page=5`);
    if (!Array.isArray(res.json)) continue;
    for (const rel of res.json) {
      const published = rel.published_at || rel.created_at || "";
      if (!published) continue;
      const ts = Math.floor(Date.parse(published) / 1000);
      if (!Number.isFinite(ts) || ts < cutoff) continue;

      const name = rel.name || rel.tag_name || "";
      const text = `${name} ${rel.body || ""}`;
      if (!filters.passes(text)) continue;

      items.push({
        source: "github",
        subsource: `${owner}/${repo}`,
        event: "release",
        url: rel.html_url,
        title: `Release: ${name} (${rel.tag_name || ""})`,
        text,
        author: { handle: `${owner}/${repo}` },
        engagement: {},
        created_at: published,
        metadata: metadata.extract(text, [rel.html_url]),
      });
      diag.releases += 1;
    }
  }

  // ----- EIP repo: commits touching EIPS/ within the window -----
  const eip = cfg.eip_repo;
  if (eip) {
    const res = await api(`/repos/${eip.owner}/${eip.repo}/commits?path=EIPS&since=${cutoffIso}&per_page=30`);
    if (Array.isArray(res.json)) {
      for (const c of res.json) {
        const detailRes = await api(`/repos/${eip.owner}/${eip.repo}/commits/${c.sha}`);
        const detail = detailRes.json || {};
        const files = (detail.files || []).filter((f) => f.filename?.startsWith("EIPS/"));
        if (!files.length) continue;

        const msg = detail.commit?.message || "";
        const fileSummary = files
          .slice(0, 20)
          .map((f) => `- ${f.status}: ${f.filename}`)
          .join("\n");
        const text = `${msg}\n${fileSummary}`;
        if (!filters.passes(text)) continue;

        items.push({
          source: "github",
          subsource: `${eip.owner}/${eip.repo}`,
          event: "eip-commit",
          url: `https://github.com/${eip.owner}/${eip.repo}/commit/${c.sha}`,
          title: `EIPs commit: ${msg.split("\n")[0]}`,
          text,
          author: { handle: detail.commit?.author?.name || "" },
          engagement: {},
          created_at: detail.commit?.author?.date || "",
          metadata: metadata.extract(text),
        });
        diag.eip_changes += 1;
      }
    }
  }

  return { items, diag };
}
