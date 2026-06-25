// manifest-schema.mjs — hand-rolled validator for the schema-1.1 manifest.
// Zero dependencies. Returns an array of human-readable error strings ([] = valid).

const SOURCES = new Set(["x-seed", "rss", "github", "arxiv", "telegram"]);

function isStr(v) { return typeof v === "string"; }
function isArr(v) { return Array.isArray(v); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

function validateItem(item, i, errors) {
  const at = `items[${i}]`;
  if (!isObj(item)) { errors.push(`${at} is not an object`); return; }
  if (!SOURCES.has(item.source)) errors.push(`${at}.source "${item.source}" is not a known source`);
  if (!isStr(item.url)) errors.push(`${at}.url is missing or not a string`);
  if (item.author != null && !isObj(item.author)) errors.push(`${at}.author must be an object`);
  if (item.engagement != null && !isObj(item.engagement)) errors.push(`${at}.engagement must be an object`);
  const m = item.metadata;
  if (m != null) {
    if (!isObj(m)) errors.push(`${at}.metadata must be an object`);
    else {
      for (const key of ["eip_numbers", "anchor_domain_links", "tracked_companies", "tracked_protocols", "technical_markers"]) {
        if (m[key] != null && !isArr(m[key])) errors.push(`${at}.metadata.${key} must be an array`);
      }
      for (const key of ["has_eip_reference", "has_code_block"]) {
        if (m[key] != null && typeof m[key] !== "boolean") errors.push(`${at}.metadata.${key} must be a boolean`);
      }
    }
  }
}

export function validateManifest(manifest) {
  const errors = [];
  if (!isObj(manifest)) return ["manifest is not an object"];
  if (manifest.schema_version !== "1.1") errors.push(`schema_version must be "1.1" (got ${JSON.stringify(manifest.schema_version)})`);
  if (!isStr(manifest.captured_at)) errors.push("captured_at is missing or not a string");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.date_utc || "")) errors.push("date_utc must be YYYY-MM-DD");
  if (!isObj(manifest.window_hours)) errors.push("window_hours must be an object");
  if (!isStr(manifest.signals_dir)) errors.push("signals_dir is missing or not a string");
  if (!isArr(manifest.previous_signals_files)) errors.push("previous_signals_files must be an array");
  if (typeof manifest.weekly_report_due !== "boolean") errors.push("weekly_report_due must be a boolean");
  if (!isObj(manifest.collection_diagnostics)) errors.push("collection_diagnostics must be an object");
  if (!isArr(manifest.items)) errors.push("items must be an array");
  else manifest.items.forEach((item, i) => validateItem(item, i, errors));
  return errors;
}
