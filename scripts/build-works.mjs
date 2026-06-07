#!/usr/bin/env node
/* =========================================================================
 * build-works.mjs — bake the "Latest Works" gallery into static HTML.
 *
 * Source priority:
 *   1. Google Drive folder (works.config.json -> driveFolderId) read via a
 *      service-account key in env GDRIVE_KEY. Drag-and-drop workflow:
 *        - caption  = file name (without extension)
 *        - medium   = text after the first "|" in the name, else the Drive
 *                     file's Description field
 *        - date     = text after the second "|", else the file's upload date
 *        - featured = the file lives in a (any-depth) "Featured" subfolder
 *      Sub-folders are scanned recursively; non-images (e.g. the Sheet) ignored.
 *   2. works.config.json csvUrl  (legacy published-Sheet CSV) — used only if no
 *      Drive folder/creds are configured.
 *   3. works.seed.json  (local static/portfolio/* images) — fallback so the
 *      gallery is never empty before the Drive folder is populated.
 *
 * For every entry it ensures an optimized image + thumbnail exist under
 * static/works/, then writes static/works/works.json and injects static
 * gallery + lightbox HTML between the markers in index.html and works/index.html.
 *
 * Idempotent: an image whose id already has a baked .jpg is not re-downloaded
 * or re-processed. Safe to run on a schedule.
 *
 * Usage:  GDRIVE_KEY="$(cat key.json)" node scripts/build-works.mjs
 * Deps:   sharp   (declared in package.json); Google auth is hand-rolled with
 *         node:crypto — no googleapis dependency.
 * ========================================================================= */

import { readFile, writeFile, mkdir, access, readdir, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKS_DIR = resolve(ROOT, "static/works");
const DRIVE_THUMB = "https://drive.google.com/thumbnail?id=";

const MAIN_WIDTH = 1600;
const THUMB_WIDTH = 700;
const MAIN_Q = 82;
const THUMB_Q = 78;

/* ---------- small helpers ---------- */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const exists = (p) => access(p, FS.F_OK).then(() => true, () => false);

function truthy(v) {
  v = String(v ?? "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "x", "✓"].includes(v);
}

function driveId(link) {
  if (!link) return "";
  link = String(link).trim();
  const m = link.match(/\/d\/([-\w]{20,})/) ||
            link.match(/[?&]id=([-\w]{20,})/) ||
            link.match(/^([-\w]{20,})$/);
  return m ? m[1] : "";
}

function slug(s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "work";
}

function dateValue(d) {
  if (!d) return 0;
  const m = String(d).match(/(\d{4})(?:[-/](\d{1,2}))?/);
  return m ? parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0) : 0;
}

/* ---------- CSV ---------- */

function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, j) => (o[h] = (r[j] || "").trim()));
    return o;
  }).filter((o) => o.image || o.caption);
}

/* ---------- Google Drive (service account, no external deps) ---------- */

let _creds = null;   // parsed service-account JSON
let _token = null;   // cached access token for this run

function b64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* GDRIVE_KEY may hold the JSON itself (CI secret) or a path to the key file. */
async function loadCreds() {
  let raw = process.env.GDRIVE_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (!raw) return null;
  if (!raw.trim().startsWith("{")) {
    try { raw = await readFile(raw.trim(), "utf8"); } catch { return null; }
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function driveToken() {
  if (_token) return _token;
  const iat = Math.floor(Date.now() / 1000);
  const aud = _creds.token_uri || "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: _creds.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud, iat, exp: iat + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(header + "." + claim); signer.end();
  const jwt = header + "." + claim + "." + b64url(signer.sign(_creds.private_key));

  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error("token " + res.status + " " + (await res.text()).slice(0, 200));
  _token = (await res.json()).access_token;
  return _token;
}

async function driveListChildren(folderId) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,description,createdTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      orderBy: "name",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch("https://www.googleapis.com/drive/v3/files?" + params, {
      headers: { Authorization: "Bearer " + (await driveToken()) },
    });
    if (!res.ok) throw new Error("list " + res.status + " " + (await res.text()).slice(0, 200));
    const json = await res.json();
    out.push(...(json.files || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return out;
}

/* Walk the folder tree; collect image files, flagging those under a "Featured" folder. */
async function driveCollectImages(folderId, featuredAncestor, depth = 0) {
  if (depth > 6) return [];
  const children = await driveListChildren(folderId);
  const imgs = [];
  for (const f of children) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      const feat = featuredAncestor || /^featured$/i.test((f.name || "").trim());
      imgs.push(...await driveCollectImages(f.id, feat, depth + 1));
    } else if ((f.mimeType || "").startsWith("image/")) {
      imgs.push({ file: f, featured: featuredAncestor });
    }
  }
  return imgs;
}

/* "Caption | Medium | 2024" → parts (medium/date optional). */
function parseDriveName(name) {
  const base = String(name).replace(/\.[a-z0-9]+$/i, "");
  const [caption, medium, date] = base.split("|").map((s) => s.trim());
  return { caption: caption || base, medium: medium || "", date: date || "" };
}

function ymFromCreated(t) {
  const m = String(t || "").match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

/* Collapse same-caption duplicates (e.g. a piece kept in the main folder AND
   copied into Featured) into one entry; featured wins. */
function dedupeByCaption(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.caption.trim().toLowerCase();
    const prev = map.get(key);
    if (!prev) { map.set(key, e); continue; }
    const winner = prev.featured ? prev : (e.featured ? e : prev);
    map.set(key, { ...winner, featured: prev.featured || e.featured });
  }
  return [...map.values()];
}

/* ---------- gather entries ---------- */

async function gather() {
  const cfg = JSON.parse(await readFile(resolve(ROOT, "works.config.json"), "utf8"));

  // 1. Google Drive folder (preferred). Drag-and-drop: filename = caption.
  _creds = await loadCreds();
  if (cfg.driveFolderId && _creds) {
    try {
      const imgs = await driveCollectImages(cfg.driveFolderId, false);
      if (imgs.length) {
        const mapped = imgs.map(({ file, featured }) => {
          const pn = parseDriveName(file.name);
          return {
            id: file.id, driveId: file.id, source: "drive-api", fileId: file.id,
            caption: pn.caption,
            medium: pn.medium || (file.description || "").trim(),
            date: pn.date || ymFromCreated(file.createdTime),
            featured,
          };
        });
        const deduped = dedupeByCaption(mapped);
        console.log(`  • Drive folder: ${imgs.length} image(s) → ${deduped.length} after de-dup`);
        return deduped;
      }
      console.warn("  ! Drive folder has no images — falling back to seed.");
    } catch (e) {
      console.warn("  ! Drive read failed (" + e.message + ") — falling back to seed/CSV.");
    }
  } else if (cfg.driveFolderId && !_creds) {
    console.warn("  ! driveFolderId set but no GDRIVE_KEY in env — falling back to seed/CSV.");
  }

  // 2/3. Fallback: local seed images + (legacy) published-Sheet CSV.
  let seed = [];
  try {
    seed = JSON.parse(await readFile(resolve(ROOT, "works.seed.json"), "utf8"));
  } catch { /* no seed file — fine */ }

  const entries = [];

  // Seed entries: local images already in the repo.
  for (const s of seed) {
    if (!s.file) continue;
    const id = s.id || slug(basename(s.file));
    entries.push({
      id, driveId: "",
      source: "local", localPath: resolve(ROOT, s.file),
      caption: s.caption || "Untitled",
      date: s.date || "", medium: s.medium || "",
      featured: truthy(s.featured),
    });
  }

  // Sheet entries: Drive links.
  if (cfg.csvUrl) {
    try {
      const res = await fetch(cfg.csvUrl, { redirect: "follow" });
      if (!res.ok) throw new Error("CSV fetch " + res.status);
      const objs = rowsToObjects(parseCSV(await res.text()));
      for (const o of objs) {
        const id = driveId(o.image);
        if (!id) { console.warn("  ! skipping row, no Drive id:", o.caption || o.image); continue; }
        entries.push({
          id, driveId: id, source: "drive",
          caption: o.caption || "Untitled",
          date: o.date || "", medium: o.medium || "",
          featured: truthy(o.featured),
        });
      }
    } catch (e) {
      console.warn("  ! could not read Sheet CSV (" + e.message + "); using seed only.");
    }
  } else {
    console.log("  (no csvUrl in works.config.json yet — seed only)");
  }

  // De-dupe by id (later/sheet entries win over seed).
  const byId = new Map();
  for (const e of entries) byId.set(e.id, e);
  return [...byId.values()];
}

/* ---------- image processing ---------- */

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureImages(e) {
  const mainPath = resolve(WORKS_DIR, e.id + ".jpg");
  const thumbPath = resolve(WORKS_DIR, e.id + ".thumb.jpg");

  // Full override: always re-download + re-optimize so the baked gallery is an
  // exact mirror of Drive on every run (no stale images, ever).
  let input;
  if (e.source === "local") {
    input = await readFile(e.localPath);
  } else if (e.source === "drive-api") {
    // Authenticated download of the full-resolution original.
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${e.fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: "Bearer " + (await driveToken()) } }
    );
    if (!res.ok) throw new Error("download " + res.status);
    input = Buffer.from(await res.arrayBuffer());
  } else {
    // Legacy CSV path: Drive share link. Thumbnail endpoint at large size is the
    // most reliable for <img>-style fetches; fall back to the uc download endpoint.
    try {
      input = await fetchBuffer(DRIVE_THUMB + e.driveId + "&sz=w2000");
      if (input.length < 2000) throw new Error("thumbnail too small");
    } catch {
      input = await fetchBuffer("https://drive.google.com/uc?export=download&id=" + e.driveId);
    }
  }

  const base = sharp(input).rotate(); // honor EXIF orientation
  const main = await base.clone()
    .resize({ width: MAIN_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: MAIN_Q, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  await writeFile(mainPath, main.data);

  await base.clone()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_Q, mozjpeg: true }).toFile(thumbPath);

  return { w: main.info.width, h: main.info.height };
}

/* ---------- HTML generation ---------- */

function cardHTML(w) {
  const meta = [];
  if (w.date) meta.push(`<time datetime="${esc(w.date)}">${esc(w.date)}</time>`);
  if (w.medium) meta.push(esc(w.medium));
  return [
    `<figure class="work" data-id="${esc(w.id)}">`,
    `  <a class="thumb" href="#lb-${esc(w.id)}" aria-label="Open: ${esc(w.caption)}">`,
    `    <img src="${esc(w.thumb)}" alt="${esc(w.alt)}" loading="lazy"${w.w ? ` width="${w.w}" height="${w.h}"` : ""}>`,
    `  </a>`,
    `  <figcaption>`,
    `    <div class="title">${esc(w.caption)}</div>`,
    meta.length ? `    <div class="meta">${meta.join(" · ")}</div>` : "",
    `  </figcaption>`,
    `</figure>`,
  ].filter(Boolean).join("\n");
}

function lightboxHTML(w) {
  const cap = [w.caption, w.medium].filter(Boolean).join(" — ");
  return [
    `<div class="lightbox" id="lb-${esc(w.id)}" role="dialog" aria-label="${esc(w.caption)}">`,
    `  <a class="close" href="#top" aria-label="Close">&times;</a>`,
    `  <img src="${esc(w.src)}" alt="${esc(w.alt)}">`,
    `  <figcaption>${esc(cap)}</figcaption>`,
    `</div>`,
  ].join("\n");
}

function inject(html, name, content) {
  const start = `<!-- ${name}:START -->`, end = `<!-- ${name}:END -->`;
  const s = html.indexOf(start), eIdx = html.indexOf(end);
  if (s === -1 || eIdx === -1) { console.warn("  ! markers not found:", name); return html; }
  return html.slice(0, s + start.length) + "\n" + content + "\n" + html.slice(eIdx);
}

/* ---------- main ---------- */

async function main() {
  console.log("• Gathering works…");
  await mkdir(WORKS_DIR, { recursive: true });
  const entries = await gather();
  console.log(`• ${entries.length} work(s) found`);

  const jsonPath = resolve(WORKS_DIR, "works.json");
  let prevWorks = null;
  try { prevWorks = JSON.parse(await readFile(jsonPath, "utf8")).works; } catch { /* none */ }

  const works = [];
  for (const e of entries) {
    try {
      const dim = await ensureImages(e);
      works.push({
        id: e.id, driveId: e.driveId,
        caption: e.caption, date: e.date, medium: e.medium, featured: e.featured,
        alt: `${e.caption} by Shibani Sehgal`,
        src: `/static/works/${e.id}.jpg`,
        thumb: `/static/works/${e.id}.thumb.jpg`,
        w: dim.w, h: dim.h,
      });
      console.log(`  ✓ ${e.id} (${e.source})`);
    } catch (err) {
      console.warn(`  ✗ ${e.id}: ${err.message}`);
    }
  }

  works.sort((a, b) => dateValue(b.date) - dateValue(a.date));

  // Only rewrite works.json when the meaningful payload changed, so idempotent
  // runs (e.g. the hourly Action with no new art) produce no spurious commit.
  if (JSON.stringify(prevWorks) !== JSON.stringify(works)) {
    await writeFile(jsonPath, JSON.stringify({ generated: new Date().toISOString(), works }, null, 2));
  }

  // Prune baked images no longer referenced (keeps static/works in sync with the
  // Drive folder — e.g. removes files that were renamed/deleted/re-uploaded).
  const keep = new Set(["works.json"]);
  for (const w of works) { keep.add(w.id + ".jpg"); keep.add(w.id + ".thumb.jpg"); }
  for (const f of await readdir(WORKS_DIR)) {
    if (!keep.has(f)) { await unlink(resolve(WORKS_DIR, f)); console.log(`  – pruned ${f}`); }
  }

  const featured = works.filter((w) => w.featured);
  const featuredOrAll = featured.length ? featured : works.slice(0, 6); // never empty
  const emptyMsg = `<p class="gallery-empty">New works will appear here soon.</p>`;

  // index.html — featured strip
  {
    const file = resolve(ROOT, "index.html");
    let html = await readFile(file, "utf8");
    html = inject(html, "WORKS:FEATURED",
      featuredOrAll.length ? featuredOrAll.map(cardHTML).join("\n") : emptyMsg);
    html = inject(html, "LIGHTBOX:FEATURED",
      featuredOrAll.map(lightboxHTML).join("\n"));
    await writeFile(file, html);
    console.log(`• index.html: ${featuredOrAll.length} featured card(s)`);
  }

  // works/index.html — everything
  {
    const file = resolve(ROOT, "works/index.html");
    let html = await readFile(file, "utf8");
    html = inject(html, "WORKS:ALL", works.length ? works.map(cardHTML).join("\n") : emptyMsg);
    html = inject(html, "LIGHTBOX:ALL", works.map(lightboxHTML).join("\n"));
    await writeFile(file, html);
    console.log(`• works/index.html: ${works.length} card(s)`);
  }

  console.log("✓ Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
