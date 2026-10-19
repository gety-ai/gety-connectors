// src/index.ts
import {
  Connector,
  del,
  upsert
} from "@gety-ai/connector-sdk";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import process from "node:process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
var WEBKIT_UNIX_OFFSET_MICROS = 11644473600000000n;
var DOC_TYPE_BOOKMARK = "chrome:bookmark";
var DOC_TYPE_HISTORY = "chrome:history";
var HISTORY_BATCH_SIZE = 500;
function webkitMicrosToRfc3339(micros) {
  if (micros <= 0n) return null;
  const unixMicros = micros - WEBKIT_UNIX_OFFSET_MICROS;
  const ms = Number(unixMicros / 1000n);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
function parseWebkitTimestamp(value) {
  if (value == null || value === "") return null;
  try {
    const micros = typeof value === "bigint" ? value : BigInt(String(value).trim());
    return micros > 0n ? micros : null;
  } catch {
    return null;
  }
}
function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}
function defaultChromeProfileDir(os, home, localAppData) {
  switch (os) {
    case "darwin":
      return join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "Default"
      );
    case "win32": {
      const base = localAppData && localAppData.trim() ? localAppData : join(home, "AppData", "Local");
      return join(base, "Google", "Chrome", "User Data", "Default");
    }
    default:
      return join(home, ".config", "google-chrome", "Default");
  }
}
function historyRangeToMaxAgeDays(range) {
  switch (range) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "365d":
      return 365;
    case "all":
      return null;
    default:
      return 90;
  }
}
function historyCutoffWebkitMicros(maxAgeDays, nowMs) {
  if (maxAgeDays == null) return null;
  const cutoffUnixMs = nowMs - maxAgeDays * 864e5;
  const micros = BigInt(Math.floor(cutoffUnixMs)) * 1000n + WEBKIT_UNIX_OFFSET_MICROS;
  return micros > 0n ? micros : 0n;
}
function sha1Hex(value) {
  return createHash("sha1").update(value).digest("hex");
}
function bookmarkDocId(guid) {
  return `chrome:bookmark:${guid}`;
}
function historyDocId(url) {
  return `chrome:history:${sha1Hex(url)}`;
}
var ROOT_LABELS = {
  bookmark_bar: "Bookmarks bar",
  other: "Other bookmarks",
  synced: "Mobile bookmarks"
};
function flattenBookmarks(bookmarksJson) {
  const out = [];
  const roots = bookmarksJson?.roots;
  if (roots == null || typeof roots !== "object") return out;
  for (const [rootKey, rootNode] of Object.entries(roots)) {
    if (rootNode == null || typeof rootNode !== "object") continue;
    const node = rootNode;
    const label = ROOT_LABELS[rootKey] ?? (typeof node.name === "string" ? node.name : rootKey);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walkBookmarkNode(child, [label], out);
  }
  return out;
}
function walkBookmarkNode(node, trail, out) {
  if (node == null || typeof node !== "object") return;
  const n = node;
  const type = n.type;
  if (type === "url") {
    const url = typeof n.url === "string" ? n.url : "";
    const guid = typeof n.guid === "string" && n.guid ? n.guid : url;
    if (!guid) return;
    out.push({
      guid,
      name: typeof n.name === "string" ? n.name : "",
      url,
      folder: trail.join(" / "),
      dateAdded: parseWebkitTimestamp(n.date_added),
      dateModified: parseWebkitTimestamp(n.date_modified)
    });
    return;
  }
  if (type === "folder" || Array.isArray(n.children)) {
    const name = typeof n.name === "string" ? n.name : "";
    const nextTrail = name ? [...trail, name] : trail;
    const children = Array.isArray(n.children) ? n.children : [];
    for (const child of children) walkBookmarkNode(child, nextTrail, out);
  }
}
function buildBookmarkDoc(entry) {
  const title = entry.name || entry.url || "Untitled bookmark";
  const createdAt = entry.dateAdded ? webkitMicrosToRfc3339(entry.dateAdded) : null;
  const updatedAt = webkitMicrosToRfc3339(
    entry.dateModified ?? entry.dateAdded ?? 0n
  );
  const lines = [title, ""];
  if (entry.url) lines.push(entry.url, "");
  if (entry.folder) lines.push(`Folder: ${entry.folder}`);
  if (createdAt) lines.push(`Added: ${createdAt}`);
  const content = lines.join("\n");
  const metadata = {};
  if (isWebUrl(entry.url)) metadata.url = entry.url;
  if (entry.folder) metadata.folder = entry.folder;
  if (createdAt) metadata.created_at = createdAt;
  const doc = {
    id: bookmarkDocId(entry.guid),
    title,
    content,
    content_format: "plaintext",
    doc_type: DOC_TYPE_BOOKMARK,
    metadata,
    original_file_size: content.length
  };
  if (updatedAt) doc.doc_updated_at = updatedAt;
  return doc;
}
function buildHistoryDoc(row) {
  const title = row.title.trim() ? row.title.trim() : row.url;
  const lastVisited = webkitMicrosToRfc3339(row.lastVisit);
  const lines = [title, "", row.url, "", `Visits: ${row.visitCount}`];
  if (lastVisited) lines.push(`Last visited: ${lastVisited}`);
  const content = lines.join("\n");
  const metadata = { visit_count: row.visitCount };
  if (isWebUrl(row.url)) metadata.url = row.url;
  const doc = {
    id: historyDocId(row.url),
    title,
    content,
    content_format: "plaintext",
    doc_type: DOC_TYPE_HISTORY,
    metadata,
    original_file_size: content.length
  };
  if (lastVisited) doc.doc_updated_at = lastVisited;
  return doc;
}
function computeDeletes(previousIds, currentIds) {
  if (!previousIds) return [];
  const deletes = [];
  for (const id of previousIds) {
    if (!currentIds.has(id)) deletes.push(id);
  }
  return deletes;
}
var ChromeConnector = class extends Connector {
  async *poll() {
    const profileDir = defaultChromeProfileDir(
      platform(),
      homedir(),
      process.env.LOCALAPPDATA
    );
    const indexBookmarks = this.config.index_bookmarks !== false;
    const indexHistory = this.config.index_history !== false;
    const range = String(this.config.history_range ?? "90d");
    const skipNonWeb = this.config.history_skip_non_web !== false;
    const prev = this.lastState ?? {};
    const state = {
      history_cursor: prev.history_cursor,
      history_ids: prev.history_ids,
      bookmark_ids: prev.bookmark_ids
    };
    const currentBookmarkIds = /* @__PURE__ */ new Set();
    let bookmarksScanned = false;
    if (indexBookmarks) {
      const bookmarksPath = join(profileDir, "Bookmarks");
      if (existsSync(bookmarksPath)) {
        bookmarksScanned = true;
        const parsed = JSON.parse(readFileSync(bookmarksPath, "utf8"));
        const updates = [];
        for (const entry of flattenBookmarks(parsed)) {
          const doc = buildBookmarkDoc(entry);
          if (currentBookmarkIds.has(doc.id)) continue;
          currentBookmarkIds.add(doc.id);
          updates.push(upsert(doc));
        }
        if (updates.length > 0) {
          yield { updates, state };
        }
      }
    }
    const currentHistoryIds = /* @__PURE__ */ new Set();
    let historyScanned = false;
    if (indexHistory) {
      const historyPath = join(profileDir, "History");
      if (existsSync(historyPath)) {
        historyScanned = true;
        for await (const batch of this.scanHistory(historyPath, range, skipNonWeb, prev)) {
          if (batch.cursor != null) state.history_cursor = batch.cursor;
          for (const id of batch.ids) currentHistoryIds.add(id);
          if (batch.updates.length > 0) {
            yield { updates: batch.updates, state };
          }
        }
      }
    }
    const deletes = [];
    if (!indexBookmarks) {
      for (const id of prev.bookmark_ids ?? []) deletes.push(del(id));
      state.bookmark_ids = [];
    } else if (bookmarksScanned) {
      for (const id of computeDeletes(prev.bookmark_ids, currentBookmarkIds)) {
        deletes.push(del(id));
      }
      state.bookmark_ids = [...currentBookmarkIds];
    } else {
      state.bookmark_ids = prev.bookmark_ids;
    }
    if (!indexHistory) {
      for (const id of prev.history_ids ?? []) deletes.push(del(id));
      state.history_ids = [];
    } else if (historyScanned) {
      for (const id of computeDeletes(prev.history_ids, currentHistoryIds)) {
        deletes.push(del(id));
      }
      state.history_ids = [...currentHistoryIds];
    } else {
      state.history_ids = prev.history_ids;
    }
    yield { updates: deletes, state };
  }
  async *scanHistory(historyPath, range, skipNonWeb, prev) {
    const cutoff = historyCutoffWebkitMicros(
      historyRangeToMaxAgeDays(range),
      Date.now()
    );
    const prevCursor = parseWebkitTimestamp(prev.history_cursor);
    const tmpRoot = mkdtempSync(join(tmpdir(), "gety-chrome-"));
    const tmpDb = join(tmpRoot, "History");
    try {
      copyFileSync(historyPath, tmpDb);
      for (const ext of ["-wal", "-shm"]) {
        if (existsSync(historyPath + ext)) {
          copyFileSync(historyPath + ext, tmpDb + ext);
        }
      }
      const conditions = [
        "last_visit_time > 0",
        "(visit_count > 0 OR typed_count > 0)"
      ];
      const params = [];
      if (cutoff != null) {
        conditions.push("last_visit_time >= ?");
        params.push(cutoff);
      }
      const sql = `SELECT url, title, visit_count, last_visit_time FROM urls WHERE ${conditions.join(" AND ")} ORDER BY last_visit_time ASC`;
      const db = new DatabaseSync(tmpDb, { readOnly: false });
      try {
        const stmt = db.prepare(sql);
        stmt.setReadBigInts(true);
        let updates = [];
        const ids = [];
        let maxCursor = prevCursor ?? 0n;
        for (const raw of stmt.iterate(...params)) {
          if (this.signal.aborted) break;
          const r = raw;
          const url = typeof r.url === "string" ? r.url : "";
          if (!url) continue;
          if (skipNonWeb && !isWebUrl(url)) continue;
          const lastVisit = r.last_visit_time;
          const doc = buildHistoryDoc({
            url,
            title: typeof r.title === "string" ? r.title : "",
            visitCount: Number(r.visit_count ?? 0),
            lastVisit
          });
          ids.push(doc.id);
          if (lastVisit > maxCursor) maxCursor = lastVisit;
          if (prevCursor == null || lastVisit >= prevCursor) {
            updates.push(upsert(doc));
            if (updates.length >= HISTORY_BATCH_SIZE) {
              yield {
                updates,
                ids: ids.splice(0),
                cursor: maxCursor.toString()
              };
              updates = [];
            }
          }
        }
        yield {
          updates,
          ids: ids.splice(0),
          cursor: maxCursor.toString()
        };
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
};
export {
  bookmarkDocId,
  buildBookmarkDoc,
  buildHistoryDoc,
  computeDeletes,
  ChromeConnector as default,
  defaultChromeProfileDir,
  flattenBookmarks,
  historyCutoffWebkitMicros,
  historyDocId,
  historyRangeToMaxAgeDays,
  isWebUrl,
  parseWebkitTimestamp,
  sha1Hex,
  webkitMicrosToRfc3339
};
//# sourceMappingURL=main.js.map
