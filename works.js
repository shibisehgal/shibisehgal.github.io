/* =========================================================================
   works.js — live "Latest Works" layer (hybrid pipeline).

   The static HTML (baked by scripts/build-works.mjs) is the source of truth
   for SEO and reliability. This script runs in the browser and PREPENDS any
   works that exist in the Google Sheet but haven't been baked into the static
   HTML yet — so a newly added piece shows up within seconds, before the
   scheduled GitHub Action bakes it.

   If anything fails (offline, sheet unpublished, CORS), it does nothing and
   the baked static gallery is shown as-is. It never removes baked content.
   ========================================================================= */
(function () {
  "use strict";

  var DRIVE_THUMB = "https://drive.google.com/thumbnail?id=";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Extract a Drive file id from any common share-link shape (or a bare id). */
  function driveId(link) {
    if (!link) return "";
    link = String(link).trim();
    var m = link.match(/\/d\/([-\w]{20,})/) ||
            link.match(/[?&]id=([-\w]{20,})/) ||
            link.match(/^([-\w]{20,})$/);
    return m ? m[1] : "";
  }

  function truthy(v) {
    v = String(v == null ? "" : v).trim().toLowerCase();
    return v === "true" || v === "yes" || v === "y" || v === "1" || v === "x" || v === "✓";
  }

  /* Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines). */
  function parseCSV(text) {
    var rows = [], row = [], field = "", i = 0, q = false, c;
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (; i < text.length; i++) {
      c = text[i];
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
    var headers = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      headers.forEach(function (h, j) { o[h] = (r[j] || "").trim(); });
      return o;
    }).filter(function (o) { return o.image || o.caption; });
  }

  function dateValue(d) {
    if (!d) return 0;
    var m = String(d).match(/(\d{4})(?:[-/](\d{1,2}))?/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
  }

  function workCardHTML(w) {
    var meta = [];
    if (w.date) meta.push('<time datetime="' + esc(w.date) + '">' + esc(w.date) + "</time>");
    if (w.medium) meta.push(esc(w.medium));
    return '' +
      '<figure class="work" data-id="' + esc(w.id) + '" data-live="1">' +
        '<a class="thumb" href="#lb-' + esc(w.id) + '" aria-label="Open: ' + esc(w.caption) + '">' +
          '<img src="' + esc(w.thumb) + '" alt="' + esc(w.alt) + '" loading="lazy">' +
        "</a>" +
        "<figcaption>" +
          '<div class="title">' + esc(w.caption) +
            '<span class="badge-new">NEW</span></div>' +
          (meta.length ? '<div class="meta">' + meta.join(" · ") + "</div>" : "") +
        "</figcaption>" +
      "</figure>";
  }

  function lightboxHTML(w) {
    return '' +
      '<div class="lightbox" id="lb-' + esc(w.id) + '" role="dialog" aria-label="' + esc(w.caption) + '">' +
        '<a class="close" href="#top" aria-label="Close">&times;</a>' +
        '<img src="' + esc(w.full) + '" alt="' + esc(w.alt) + '">' +
        '<figcaption>' + esc([w.caption, w.medium].filter(Boolean).join(" — ")) + "</figcaption>" +
      "</div>";
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }

  function getText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.text();
    });
  }

  function run() {
    var feeds = Array.prototype.slice.call(document.querySelectorAll(".gallery[data-feed]"));
    if (!feeds.length) return;

    // Baked ids (so we only add the not-yet-baked delta). Tolerate a missing file.
    getJSON("/static/works/works.json").catch(function () { return { works: [] }; })
      .then(function (baked) {
        var bakedIds = {};
        (baked.works || []).forEach(function (w) { if (w.driveId) bakedIds[w.driveId] = 1; });

        return getJSON("/works.config.json").then(function (cfg) {
          if (!cfg.csvUrl) return; // no sheet wired up yet → static stands
          return getText(cfg.csvUrl).then(function (csv) {
            var items = rowsToObjects(parseCSV(csv)).map(function (o) {
              var id = driveId(o.image);
              if (!id) return null;
              return {
                id: id,
                driveId: id,
                caption: o.caption || "Untitled",
                alt: (o.caption || "Artwork") + " by Shibani Sehgal",
                date: o.date || "",
                medium: o.medium || "",
                featured: truthy(o.featured),
                thumb: DRIVE_THUMB + id + "&sz=w800",
                full: DRIVE_THUMB + id + "&sz=w1600"
              };
            }).filter(Boolean)
              .filter(function (w) { return !bakedIds[w.driveId]; }) // delta only
              .sort(function (a, b) { return dateValue(b.date) - dateValue(a.date); });

            if (!items.length) return;

            var lbHtml = "";
            feeds.forEach(function (feed) {
              var feedItems = feed.getAttribute("data-feed") === "featured"
                ? items.filter(function (w) { return w.featured; })
                : items;
              if (!feedItems.length) return;
              var empty = feed.querySelector(".gallery-empty");
              if (empty) empty.remove();
              feed.insertAdjacentHTML("afterbegin", feedItems.map(workCardHTML).join(""));
            });
            // One lightbox per unique item (ids are unique across feeds).
            items.forEach(function (w) { lbHtml += lightboxHTML(w); });
            document.body.insertAdjacentHTML("beforeend", lbHtml);
          });
        });
      })
      .catch(function () { /* static content already present; fail silently */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else run();
})();
