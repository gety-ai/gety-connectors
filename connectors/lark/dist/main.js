// src/index.ts
import {
  Connector,
  del,
  upsert
} from "@gety-ai/connector-sdk";

// src/doc_markdown.ts
var EPHEMERAL_URL_MARKERS = ["internal-api-drive-stream", "/authcode/"];
function cleanupDocMarkdown(text) {
  return transformOutsideCode(text, (segment) => {
    let out = segment;
    out = convertTables(out);
    out = convertCallouts(out);
    out = stripGrids(out);
    out = transformInline(out);
    out = convertBlockLevel(out);
    out = replaceEphemeralImages(out);
    out = convertLineBreaks(out);
    return out.replace(/\n{3,}/g, "\n\n");
  });
}
function transformOutsideCode(text, fn) {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts.map((part, index) => index % 2 === 0 ? fn(part) : part).join("");
}
function convertTables(text) {
  return text.replace(/<table>[\s\S]*?<\/table>/g, (block) => {
    const rows = [];
    for (const row of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/g)) {
        const colspan = Number(/colspan="(\d+)"/.exec(cell[1])?.[1] ?? "1");
        cells.push(flattenCell(cell[2]));
        for (let extra = 1; extra < colspan; extra += 1) {
          cells.push("");
        }
      }
      rows.push(cells);
    }
    if (rows.length === 0) {
      return "";
    }
    const width = Math.max(...rows.map((cells) => cells.length), 1);
    const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const separator = `| ${Array(width).fill("---").join(" | ")} |`;
    return [
      "",
      line(rows[0]),
      separator,
      ...rows.slice(1).map(line),
      ""
    ].join("\n");
  });
}
function flattenCell(content) {
  let out = content;
  out = transformInline(out);
  out = out.replace(/<br\s*\/?>/g, " ").replace(/<p(?:\s[^>]*)?>|<\/p>/g, " ").replace(/<li(?:\s[^>]*)?>/g, " \u2022 ").replace(/<\/li>/g, " ").replace(/<\/?(?:ul|ol|blockquote)(?:\s[^>]*)?>/g, " ");
  return out.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
function convertCallouts(text) {
  return text.replace(
    /<callout\b([^>]*)>([\s\S]*?)<\/callout>/g,
    (_, attrs, inner) => {
      const emoji = /emoji="([^"]*)"/.exec(attrs)?.[1];
      const lines = inner.trim().split("\n");
      const quoted = lines.map(
        (line, index) => index === 0 && emoji ? `> ${emoji} ${line}` : `> ${line}`
      ).join("\n");
      return `
${quoted}
`;
    }
  );
}
function stripGrids(text) {
  return text.replace(/<\/?grid>/g, "").replace(/<column\b[^>]*>/g, "").replace(/<\/column>/g, "\n\n");
}
function transformInline(text) {
  let out = text;
  out = out.replace(
    /<cite\b([^>]*)>([\s\S]*?)<\/cite>/g,
    (_, attrs, inner) => {
      const name = /user-name="([^"]*)"/.exec(attrs)?.[1];
      return name ? `@${name}` : inner.trim();
    }
  );
  out = out.replace(/<source\b([^>]*?)\/?>/g, (_, attrs) => {
    const mime = /mime="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (mime.startsWith("video/")) {
      return "[\u89C6\u9891]";
    }
    if (mime.startsWith("audio/")) {
      return "[\u97F3\u9891]";
    }
    if (mime.startsWith("image/")) {
      return "[\u56FE\u7247]";
    }
    return "[\u9644\u4EF6]";
  });
  out = out.replace(/<\/?figure[^>]*>/g, "");
  out = out.replace(/<img\b([^>]*?)\/?>/g, (_, attrs) => {
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    const alt = /alt="([^"]*)"/.exec(attrs)?.[1];
    const label = name ? `[\u56FE\u7247: ${name}]` : "[\u56FE\u7247]";
    return alt ? `${label} ${alt}` : label;
  });
  out = out.replace(
    /<whiteboard\b[^>]*>(?:[\s\S]*?<\/whiteboard>)?/g,
    "[\u753B\u677F]"
  );
  out = out.replace(/<bitable\b[^>]*>(?:[\s\S]*?<\/bitable>)?/g, "[\u591A\u7EF4\u8868\u683C]");
  out = out.replace(/<task\b[^>]*>(?:[\s\S]*?<\/task>)?/g, "");
  out = out.replace(
    /<time\b([^>]*)>(?:[\s\S]*?<\/time>)?/g,
    (_, attrs) => {
      const ms = Number(/expire-time="(\d+)"/.exec(attrs)?.[1]);
      if (!Number.isFinite(ms)) {
        return "[\u65E5\u671F]";
      }
      const date = new Date(ms);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (/is-whole-day="true"/.test(attrs)) {
        return day;
      }
      const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      return `${day} ${time}`;
    }
  );
  out = out.replace(
    /<poll\b([^>]*)>([\s\S]*?)<\/poll>/g,
    (_, attrs, inner) => {
      const name = /name="([^"]*)"/.exec(attrs)?.[1];
      const label = name ? `[\u6295\u7968: ${name}]` : "[\u6295\u7968]";
      const body = inner.trim();
      return body ? `${label}
${body}` : label;
    }
  );
  out = out.replace(/<\/?synced-source>/g, "");
  out = out.replace(
    /<readonly-block\b([^>]*)>(?:[\s\S]*?<\/readonly-block>)?/g,
    (_, attrs) => /type="task_list"/.test(attrs) ? "[\u4EFB\u52A1\u5217\u8868]" : "[\u53EA\u8BFB\u533A\u5757]"
  );
  out = out.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/g,
    (_, attrs, inner) => {
      const href = /href="([^"]*)"/.exec(attrs)?.[1];
      const label = inner.trim();
      if (href == null) {
        return label;
      }
      return label ? `[${label}](${href})` : href;
    }
  );
  out = out.replace(
    /<b>\s*([\s\S]*?)\s*<\/b>/g,
    (_, inner) => inner === "" ? "" : `**${inner}**`
  );
  return out;
}
function convertBlockLevel(text) {
  return text.replace(
    /<title>\s*([\s\S]*?)\s*<\/title>/g,
    (_, inner) => inner === "" ? "" : `# ${inner}`
  ).replace(/<p(?:\s[^>]*)?>/g, "").replace(/<\/p>/g, "\n\n").replace(/<\/?(?:ul|ol)(?:\s[^>]*)?>/g, "\n").replace(/<li(?:\s[^>]*)?>/g, "\n- ").replace(/<\/li>/g, "").replace(
    /<blockquote(?:\s[^>]*)?>([\s\S]*?)<\/blockquote>/g,
    (_, inner) => `
${inner.trim().split("\n").map((line) => `> ${line}`).join("\n")}
`
  );
}
function replaceEphemeralImages(text) {
  return text.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
    (whole, alt, url) => {
      if (!EPHEMERAL_URL_MARKERS.some((marker) => url.includes(marker))) {
        return whole;
      }
      const label = alt.trim();
      return label ? `[\u56FE\u7247: ${label}]` : "[\u56FE\u7247]";
    }
  );
}
function convertLineBreaks(text) {
  return text.split("\n").map(
    (line) => line.replace(/<br\s*\/?>/g, line.trimStart().startsWith("|") ? " " : "\n")
  ).join("\n");
}

// src/lark_cli.ts
var LarkCliError = class extends Error {
  missingScopes;
  code;
  constructor(message, missingScopes2 = [], code) {
    super(message);
    this.name = "LarkCliError";
    this.missingScopes = missingScopes2;
    this.code = code == null ? void 0 : String(code);
  }
};
var DOCS_PAGE_SIZE = "20";
var CHATS_PAGE_SIZE = "100";
var MESSAGES_PAGE_SIZE = "50";
var LarkCliClient = class {
  constructor(bin, signal, retryDelaysMs = [1e3, 2500, 5e3]) {
    this.bin = bin;
    this.signal = signal;
    this.retryDelaysMs = retryDelaysMs;
  }
  /**
   * One page of the Search v2 browse enumeration. An empty query needs the
   * wide --created-since window to browse instead of returning only recent
   * documents, and the server-side --doc-types filter returns zero results
   * in that mode, so type filtering must happen in the caller. The default
   * sort and edit_time sort have complementary recall and must be unioned.
   */
  searchDocs(options = {}) {
    return this.run([
      "drive",
      "+search",
      "--as",
      "user",
      "--query",
      "",
      "--created-since",
      "2000-01-01",
      "--page-size",
      DOCS_PAGE_SIZE,
      ...options.sortByEditTime ? ["--sort", "edit_time"] : [],
      ...options.pageToken == null ? [] : ["--page-token", options.pageToken]
    ]).then(extractSearchPage);
  }
  /**
   * Fetches a document's markdown export. Prefer passing the URL: lark-cli
   * unwraps wiki URLs to the underlying document, which a bare wiki node
   * token would not resolve. Returns null when the document has no content.
   */
  async fetchDocMarkdown(ref) {
    const data = await this.run([
      "docs",
      "+fetch",
      "--api-version",
      "v2",
      "--as",
      "user",
      "--doc",
      ref,
      "--doc-format",
      "markdown",
      "--scope",
      "full"
    ]);
    return extractDocContent(data);
  }
  async getWikiNode(token, objType) {
    const data = await this.api("/open-apis/wiki/v2/spaces/get_node", {
      token,
      ...objType == null ? {} : { obj_type: objType }
    });
    const node = isRecord(data) && isRecord(data.node) ? data.node : null;
    if (node == null || asString(node.node_token) == null) {
      throw new LarkCliError("Wiki response contains no node");
    }
    return {
      node_token: asString(node.node_token),
      obj_token: asString(node.obj_token),
      space_id: asString(node.space_id),
      parent_node_token: asString(node.parent_node_token),
      title: asString(node.title),
      origin_node_token: asString(node.origin_node_token),
      origin_space_id: asString(node.origin_space_id)
    };
  }
  async getWikiSpaceName(spaceId) {
    const data = await this.api(
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}`
    );
    return isRecord(data) && isRecord(data.space) ? asString(data.space.name) : void 0;
  }
  async listDriveFiles(folderToken, pageToken) {
    const data = await this.api("/open-apis/drive/v1/files", {
      page_size: 200,
      ...folderToken == null ? {} : { folder_token: folderToken },
      ...pageToken == null ? {} : { page_token: pageToken }
    });
    if (!isRecord(data) || !Array.isArray(data.files)) {
      throw new LarkCliError("Drive response contains no file list");
    }
    const files = [];
    for (const item of data.files) {
      if (!isRecord(item)) continue;
      const token = asString(item.token);
      const type = asString(item.type);
      if (token == null || type == null) continue;
      files.push({
        token,
        type,
        name: asString(item.name),
        parent_token: asString(item.parent_token),
        url: asString(item.url)
      });
    }
    return {
      files,
      hasMore: data.has_more === true,
      pageToken: asString(data.next_page_token)
    };
  }
  async api(path, params = {}) {
    const result = await this.run([
      "api",
      "GET",
      path,
      "--as",
      "user",
      "--format",
      "json",
      "--params",
      JSON.stringify(params)
    ]);
    if (isRecord(result) && typeof result.code === "number") {
      if (result.code !== 0) {
        throw new LarkCliError(
          asString(result.msg) ?? `OpenAPI error ${result.code}`,
          [],
          result.code
        );
      }
      return result.data;
    }
    return result;
  }
  async listChats(pageToken) {
    const data = await this.run([
      "im",
      "+chat-list",
      "--as",
      "user",
      "--types",
      "group,p2p",
      "--sort",
      "active_time",
      "--page-size",
      CHATS_PAGE_SIZE,
      ...pageToken == null ? [] : ["--page-token", pageToken]
    ]);
    if (!isRecord(data)) {
      return { chats: [], hasMore: false };
    }
    const chats = [];
    for (const raw of Array.isArray(data.chats) ? data.chats : []) {
      if (!isRecord(raw)) {
        continue;
      }
      const chatId = asString(raw.chat_id);
      if (chatId == null) {
        continue;
      }
      chats.push({
        chat_id: chatId,
        name: asString(raw.name),
        chat_mode: asString(raw.chat_mode)
      });
    }
    return {
      chats,
      hasMore: data.has_more === true,
      pageToken: asString(data.page_token)
    };
  }
  async listMessages(chatId, startISO, pageToken) {
    const data = await this.run([
      "im",
      "+chat-messages-list",
      "--as",
      "user",
      "--chat-id",
      chatId,
      "--start",
      startISO,
      "--order",
      "asc",
      "--no-reactions",
      "--page-size",
      MESSAGES_PAGE_SIZE,
      ...pageToken == null ? [] : ["--page-token", pageToken]
    ]);
    if (!isRecord(data)) {
      return { messages: [], hasMore: false };
    }
    const messages = [];
    for (const raw of Array.isArray(data.messages) ? data.messages : []) {
      if (isRecord(raw)) {
        messages.push(raw);
      }
    }
    return {
      messages,
      hasMore: data.has_more === true,
      pageToken: asString(data.page_token)
    };
  }
  async run(args) {
    for (let attempt = 0; ; attempt += 1) {
      this.signal.throwIfAborted();
      const command = new Deno.Command(this.bin, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: this.signal
      });
      let output;
      try {
        output = await command.output();
      } catch (error) {
        this.signal.throwIfAborted();
        throw new LarkCliError(
          `failed to run "${this.bin}": ${errorMessage(error)}. Install lark-cli and finish \`lark-cli auth login\` first, or set the lark-cli path in the connector config.`
        );
      }
      const stdoutText = new TextDecoder().decode(output.stdout);
      const stderrText = new TextDecoder().decode(output.stderr).trim();
      const envelope = parseEnvelope(stdoutText) ?? parseEnvelope(stderrText);
      if (envelope?.ok === true) {
        return envelope.data ?? null;
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay != null && isRateLimitFailure(envelope)) {
        await abortableDelay(delay, this.signal);
        continue;
      }
      const detail = envelope?.error?.message ?? (stderrText || `exit code ${output.code}`);
      throw new LarkCliError(
        `lark-cli ${args.slice(0, 2).join(" ")} failed: ${detail}`,
        missingScopes(envelope),
        envelope?.error?.code
      );
    }
  }
};
function isRateLimitFailure(envelope) {
  const error = envelope?.error;
  if (error == null) {
    return false;
  }
  const text = [error.type, error.subtype, error.code, error.message].map(String).join(" ");
  return /rate.?limit|too many requests?|\b429\b/i.test(text);
}
function missingScopes(envelope) {
  const raw = envelope?.error?.missing_scopes;
  return Array.isArray(raw) ? raw.filter((scope) => typeof scope === "string") : [];
}
function parseEnvelope(text) {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function extractSearchPage(data) {
  if (!isRecord(data)) {
    return { entities: [], hasMore: false };
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const entities = [];
  for (const raw of results) {
    if (!isRecord(raw)) {
      continue;
    }
    const meta = isRecord(raw.result_meta) ? raw.result_meta : {};
    const token = asString(meta.token);
    if (token == null) {
      continue;
    }
    const type = (asString(meta.doc_types) ?? asString(raw.entity_type) ?? "doc").toLowerCase();
    const title = stripHighlightTags(
      asString(raw.title_highlighted) ?? asString(raw.title) ?? ""
    ).trim();
    entities.push({
      token,
      type,
      title: title || "\u65E0\u6807\u9898\u6587\u6863",
      editedAt: normalizeSourceTime(meta.update_time ?? meta.update_time_iso),
      createdAt: normalizeSourceTime(
        meta.create_time ?? meta.create_time_iso
      ),
      url: asString(meta.url),
      owner: asString(meta.owner_name)
    });
  }
  return {
    entities,
    hasMore: data.has_more === true,
    pageToken: asString(data.page_token)
  };
}
function extractDocContent(data) {
  if (typeof data === "string") {
    return data.trim() === "" ? null : data;
  }
  if (!isRecord(data)) {
    return null;
  }
  for (const key of ["content", "markdown", "text", "document", "data"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (isRecord(value)) {
      const nested = extractDocContent(value);
      if (nested != null) {
        return nested;
      }
    }
  }
  return null;
}
function isoFromLarkTime(value) {
  if (!value) {
    return void 0;
  }
  let normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    normalized = normalized.replace(" ", "T");
    if (/T\d{2}:\d{2}$/.test(normalized)) {
      normalized = `${normalized}:00`;
    }
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
}
function normalizeSourceTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1e3;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      return normalizeSourceTime(Number(value));
    }
    return isoFromLarkTime(value);
  }
  return void 0;
}
function stripHighlightTags(value) {
  return value.replace(/<\/?[a-z][^>]*>/gi, "");
}
function buildDocUrl(type, token) {
  const path = type === "docx" ? "docx" : type === "wiki" ? "wiki" : type === "sheet" ? "sheets" : type === "bitable" ? "base" : "docs";
  return `https://feishu.cn/${path}/${token}`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function abortableDelay(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/doc_location.ts
var DocLocationResolver = class {
  constructor(client, signal) {
    this.client = client;
    this.signal = signal;
  }
  nodes = /* @__PURE__ */ new Map();
  spaces = /* @__PURE__ */ new Map();
  drive;
  wikiUnavailable = false;
  warnings = /* @__PURE__ */ new Set();
  async resolve(entity, previous = {}) {
    this.signal.throwIfAborted();
    let node;
    try {
      if (this.wikiUnavailable) {
        return (await this.getDriveLocations()).get(entity.token) ?? previous;
      }
      const wikiToken = wikiTokenFromUrl(entity.url);
      node = await this.getNode(
        wikiToken ?? entity.token,
        wikiToken == null ? entity.type : "wiki"
      );
    } catch (error) {
      this.signal.throwIfAborted();
      const notMounted = error instanceof LarkCliError && error.code === "131014";
      if (!notMounted) {
        if (error instanceof LarkCliError && error.missingScopes.length > 0) {
          this.wikiUnavailable = true;
        }
        this.warn("wiki", error);
      }
      const drive = await this.getDriveLocations();
      return drive.get(entity.token) ?? (notMounted && previous.feishu?.node_token != null ? {} : previous);
    }
    let spaceName;
    if (node.space_id != null) {
      try {
        let pending = this.spaces.get(node.space_id);
        if (pending == null) {
          pending = this.client.getWikiSpaceName(node.space_id);
          this.spaces.set(node.space_id, pending);
        }
        spaceName = nonempty(await pending);
      } catch (error) {
        this.signal.throwIfAborted();
        this.warn("wiki space", error);
        if (previous.feishu?.space_id === node.space_id) {
          spaceName = previous.location?.space_name;
        }
      }
    }
    const origin = wikiOrigin(entity.url);
    let parentToken = node.parent_node_token;
    const ancestors = [];
    const visited = /* @__PURE__ */ new Set([node.node_token]);
    let complete = true;
    while (parentToken != null) {
      this.signal.throwIfAborted();
      if (visited.has(parentToken)) {
        complete = false;
        break;
      }
      visited.add(parentToken);
      try {
        const parent = await this.getNode(parentToken, "wiki");
        const title = nonempty(parent.title);
        if (title == null) {
          complete = false;
          break;
        }
        ancestors.unshift({
          id: parent.node_token,
          title,
          ...origin == null ? {} : {
            url: `${origin}/wiki/${encodeURIComponent(parent.node_token)}`
          }
        });
        parentToken = parent.parent_node_token;
      } catch (error) {
        this.signal.throwIfAborted();
        this.warn("wiki ancestor", error);
        complete = false;
        break;
      }
    }
    if (!complete && ancestors.length === 0 && previous.feishu?.parent_node_token === node.parent_node_token && previous.feishu?.space_id === node.space_id) {
      ancestors.push(...previous.location?.ancestors ?? []);
    }
    const location = makeLocation(ancestors, spaceName, complete);
    if (location != null && spaceName != null && origin != null && node.space_id) {
      location.space_url = `${origin}/wiki/space/${encodeURIComponent(node.space_id)}`;
    }
    const feishu = {
      node_token: node.node_token,
      ...node.obj_token == null ? {} : { obj_token: node.obj_token },
      ...node.space_id == null ? {} : { space_id: node.space_id },
      ...node.parent_node_token == null ? {} : { parent_node_token: node.parent_node_token },
      ...node.origin_node_token == null ? {} : { origin_node_token: node.origin_node_token },
      ...node.origin_space_id == null ? {} : { origin_space_id: node.origin_space_id }
    };
    return { ...location == null ? {} : { location }, feishu };
  }
  getNode(token, objType) {
    let pending = this.nodes.get(token);
    if (pending == null) {
      pending = this.client.getWikiNode(token, objType);
      this.nodes.set(token, pending);
    }
    return pending;
  }
  getDriveLocations() {
    this.drive ??= this.scanDrive();
    return this.drive;
  }
  async scanDrive() {
    const locations = /* @__PURE__ */ new Map();
    const queue = [
      { ancestors: [] }
    ];
    const visited = /* @__PURE__ */ new Set();
    for (let index = 0; index < queue.length; index++) {
      const folder = queue[index];
      const key = folder.token ?? "";
      if (visited.has(key)) continue;
      visited.add(key);
      let pageToken;
      const pages = /* @__PURE__ */ new Set();
      try {
        while (true) {
          this.signal.throwIfAborted();
          const page = await this.client.listDriveFiles(
            folder.token,
            pageToken
          );
          for (const file of page.files) {
            if (file.type === "folder") {
              const title = nonempty(file.name);
              if (title != null) {
                queue.push({
                  token: file.token,
                  ancestors: [...folder.ancestors, {
                    id: file.token,
                    title,
                    ...file.url == null ? {} : { url: file.url }
                  }]
                });
              }
            } else {
              const location = makeLocation(folder.ancestors);
              locations.set(file.token, {
                ...file.url == null ? {} : { url: file.url },
                ...location == null ? {} : { location },
                ...file.parent_token == null ? {} : { feishu: { folder_token: file.parent_token } }
              });
            }
          }
          if (!page.hasMore) break;
          if (page.pageToken == null || pages.has(page.pageToken)) {
            throw new Error("Drive pagination did not advance");
          }
          pages.add(page.pageToken);
          pageToken = page.pageToken;
        }
      } catch (error) {
        this.signal.throwIfAborted();
        this.warn("drive folders", error);
        if (error instanceof LarkCliError && error.missingScopes.length > 0) {
          break;
        }
      }
    }
    return locations;
  }
  warn(source, error) {
    if (this.warnings.has(source)) return;
    this.warnings.add(source);
    console.error(
      `[feishu] optional ${source} metadata unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
function makeLocation(ancestors, spaceName, complete = true) {
  if (ancestors.length === 0 && spaceName == null) return void 0;
  return {
    ...spaceName == null ? {} : { space_name: spaceName },
    ...ancestors.length === 0 ? {} : {
      parent_name: ancestors[ancestors.length - 1].title,
      ...ancestors[ancestors.length - 1].url == null ? {} : { parent_url: ancestors[ancestors.length - 1].url },
      path: ancestors.map((item) => item.title).join(" / "),
      ancestors
    },
    path_complete: complete
  };
}
function nonempty(value) {
  return value?.trim() || void 0;
}
function wikiTokenFromUrl(value) {
  if (value == null) return void 0;
  try {
    const match = /^\/wiki\/([^/]+)/.exec(new URL(value).pathname);
    return match?.[1];
  } catch {
    return void 0;
  }
}
function wikiOrigin(value) {
  if (value == null) return void 0;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return void 0;
    }
    if (url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn") || url.hostname === "larksuite.com" || url.hostname.endsWith(".larksuite.com")) return url.origin;
  } catch {
  }
  return void 0;
}

// src/index.ts
var DEFAULT_CHAT_LOOKBACK_DAYS = 30;
var INDEXABLE_DOC_TYPES = /* @__PURE__ */ new Set(["docx"]);
var MAX_CONTENT_BYTES = 8e6;
var TRUNCATION_NOTICE = "\n\n\u2026(\u5185\u5BB9\u8D85\u957F,\u5DF2\u88AB\u8FDE\u63A5\u5668\u622A\u65AD)";
var DELETE_BATCH_SIZE = 200;
function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function dayStartISO(day) {
  return (/* @__PURE__ */ new Date(`${day}T00:00:00`)).toISOString();
}
function weekStartDay(day) {
  const date = /* @__PURE__ */ new Date(`${day}T00:00:00`);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  return localDateString(date);
}
function addDays(day, count) {
  const date = /* @__PURE__ */ new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + count);
  return localDateString(date);
}
function periodKey(day, grouping) {
  if (grouping === "chat") {
    return "all";
  }
  return grouping === "week" ? weekStartDay(day) : day;
}
function periodLabel(key, grouping) {
  return grouping === "week" ? `${key} ~ ${addDays(key, 6)}` : key;
}
function clampContent(text) {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(text).length;
  if (originalBytes <= MAX_CONTENT_BYTES) {
    return { content: text, bytes: originalBytes };
  }
  const noticeBytes = encoder.encode(TRUNCATION_NOTICE).length;
  const budget = MAX_CONTENT_BYTES - noticeBytes;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).length <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = text.slice(0, low);
  if (/[\uD800-\uDBFF]$/.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  const content = prefix + TRUNCATION_NOTICE;
  return { content, bytes: encoder.encode(content).length };
}
function buildCloudDoc(entity, raw, position = {}) {
  const url = entity.url ?? position.url;
  const lines = [];
  const display = (value) => (value ?? "").replace(/\s+/g, " ").trim().replace(
    /[\\`*_{}\[\]()<>#!|]/g,
    "\\$&"
  );
  const destination = (value) => {
    if (!value?.trim()) return void 0;
    try {
      const link = new URL(value);
      if ((link.protocol === "https:" || link.protocol === "http:") && !link.username && !link.password) {
        return link.href.replace(/</g, "%3C").replace(/>/g, "%3E");
      }
    } catch {
    }
    return void 0;
  };
  const labelLink = (name, url2) => {
    const text = display(name);
    const link = destination(url2);
    return text && link ? `[${text}](<${link}>)` : text;
  };
  const location = position.location;
  const pathAncestors = location?.ancestors;
  const path = pathAncestors?.length && pathAncestors.map((item) => item.title).join(" / ") === location?.path ? pathAncestors.map((item) => labelLink(item.title, item.url)).join(" / ") : display(location?.path);
  for (const [label, text] of [
    ["\u77E5\u8BC6\u5E93", labelLink(location?.space_name, location?.space_url)],
    ["\u7236\u8282\u70B9", labelLink(location?.parent_name, location?.parent_url)],
    ["\u76EE\u5F55\u8DEF\u5F84", path]
  ]) {
    if (text) {
      const prefix = label === "\u76EE\u5F55\u8DEF\u5F84" && location?.path_complete === false ? "\u2026 / " : "";
      lines.push(`> **${label}\uFF1A** ${prefix}${text}`);
    }
  }
  const sourceLink = destination(url);
  if (sourceLink) lines.push(`> **\u539F\u94FE\u63A5\uFF1A** [\u6253\u5F00\u539F\u6587](<${sourceLink}>)`);
  const markdown = lines.length > 0 ? `${lines.join("\n>\n")}

---

${raw}` : raw;
  const { content, bytes } = clampContent(markdown);
  return {
    id: `feishu:doc:${entity.token}`,
    title: entity.title,
    content,
    content_format: "markdown",
    doc_type: `feishu:${entity.type}`,
    doc_updated_at: entity.editedAt,
    original_file_size: bytes,
    metadata: {
      ...url == null ? {} : { url },
      token: entity.token,
      source_type: entity.type,
      ...entity.createdAt == null ? {} : { created_at: entity.createdAt },
      ...entity.owner == null ? {} : { owner: entity.owner }
    }
  };
}
function senderLabel(message) {
  const sender = message.sender;
  if (sender == null) {
    return "\u672A\u77E5";
  }
  if (sender.name != null && sender.name !== "") {
    return sender.name;
  }
  if (sender.sender_type != null && sender.sender_type !== "user") {
    return `bot(${sender.id ?? sender.sender_type})`;
  }
  return sender.id ?? "\u672A\u77E5";
}
function groupMessagesByDay(messages) {
  const byDay = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.deleted === true) {
      continue;
    }
    const day = message.create_time?.slice(0, 10);
    if (day == null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }
    const bucket = byDay.get(day);
    if (bucket == null) {
      byDay.set(day, [message]);
    } else {
      bucket.push(message);
    }
  }
  return byDay;
}
function groupDaysByPeriod(byDay, grouping) {
  const periods = /* @__PURE__ */ new Map();
  for (const [day, messages] of byDay) {
    const key = periodKey(day, grouping);
    const days = periods.get(key);
    if (days == null) {
      periods.set(key, /* @__PURE__ */ new Map([[day, messages]]));
    } else {
      days.set(day, messages);
    }
  }
  return periods;
}
function chatTitle(chat) {
  const name = chat.name?.trim();
  if (name != null && name !== "") {
    return name;
  }
  return chat.chat_mode === "p2p" ? "\u79C1\u804A" : "\u7FA4\u804A";
}
function renderMessages(lines, messages) {
  for (const message of messages) {
    const time = message.create_time?.slice(11, 16) ?? "";
    const body = message.content?.trim() || `(${message.msg_type ?? "message"})`;
    const label = `**[${time}] ${senderLabel(message)}:**`;
    lines.push(body.includes("\n") ? `${label}
${body}` : `${label} ${body}`);
    lines.push("");
  }
}
function renderChatPeriod(title, label, days, grouping) {
  const lines = [`# ${title} \u2014 ${label}`, ""];
  const sortedDays = [...days.keys()].sort();
  for (const day of sortedDays) {
    if (grouping !== "day") {
      lines.push(`## ${day}`, "");
    }
    renderMessages(lines, days.get(day) ?? []);
  }
  return lines.join("\n").trimEnd();
}
function buildChatPeriodDoc(chat, grouping, key, days) {
  const title = chatTitle(chat);
  const sortedDays = [...days.keys()].sort();
  const firstDay = sortedDays[0];
  const lastDay = sortedDays[sortedDays.length - 1];
  const label = grouping === "chat" ? firstDay === lastDay ? firstDay : `${firstDay} ~ ${lastDay}` : periodLabel(key, grouping);
  const lastMessages = days.get(lastDay) ?? [];
  const lastMessage = lastMessages[lastMessages.length - 1];
  const messageCount = sortedDays.reduce(
    (count, day) => count + (days.get(day)?.length ?? 0),
    0
  );
  let renderDays = days;
  let rendered = renderChatPeriod(title, label, renderDays, grouping);
  if (grouping === "chat") {
    const encoder = new TextEncoder();
    let dropFrom = 0;
    while (encoder.encode(rendered).length > MAX_CONTENT_BYTES && dropFrom < sortedDays.length - 1) {
      dropFrom += 1;
      renderDays = new Map(
        sortedDays.slice(dropFrom).map((day) => [day, days.get(day) ?? []])
      );
      rendered = `${renderChatPeriod(title, label, renderDays, grouping)}

\u2026(\u66F4\u65E9\u7684\u6D88\u606F\u56E0\u957F\u5EA6\u9650\u5236\u88AB\u7701\u7565)`;
    }
  }
  const { content, bytes } = clampContent(rendered);
  return {
    id: grouping === "chat" ? `feishu:chat:${chat.chat_id}` : `feishu:chat:${chat.chat_id}:${key}`,
    title: grouping === "chat" ? title : `${title} \xB7 ${label}`,
    content,
    content_format: "markdown",
    doc_type: "feishu:chat",
    doc_updated_at: isoFromLarkTime(lastMessage?.create_time),
    original_file_size: bytes,
    metadata: {
      url: `https://applink.feishu.cn/client/chat/open?openChatId=${chat.chat_id}`,
      chat_id: chat.chat_id,
      chat_name: title,
      date: label,
      grouping,
      message_count: messageCount
    }
  };
}
function isUnchangedDoc(entity, indexedTokens, previousMark) {
  return indexedTokens.has(entity.token) && entity.editedAt != null && previousMark != null && entity.editedAt <= previousMark;
}
async function cloudDocSignature(entity, position) {
  const data = JSON.stringify([
    "markdown-source-v2",
    entity.token,
    entity.type,
    entity.title,
    entity.editedAt,
    entity.createdAt,
    entity.url,
    entity.owner,
    position
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data)
  );
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0")
  ).join("");
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
var FeishuConnector = class extends Connector {
  createClient() {
    const bin = this.config.lark_cli_path?.trim() || "lark-cli";
    return new LarkCliClient(bin, this.signal);
  }
  async *poll() {
    const client = this.createClient();
    const grouping = this.config.chat_grouping === "day" ? "day" : this.config.chat_grouping === "chat" ? "chat" : "week";
    const state = {
      docs_high_water: this.lastState?.docs_high_water,
      docs: { ...this.lastState?.docs ?? {} },
      doc_signatures: { ...this.lastState?.doc_signatures ?? {} },
      doc_positions: { ...this.lastState?.doc_positions ?? {} },
      chat_cursors: { ...this.lastState?.chat_cursors ?? {} },
      chat_doc_ids: [...this.lastState?.chat_doc_ids ?? []],
      chat_grouping: this.lastState?.chat_grouping
    };
    if (!this.config.index_chat_history) {
      yield* this.purgeChatIndex(state);
    } else if (state.chat_grouping != null && state.chat_grouping !== grouping) {
      yield* this.purgeChatIndex(state);
    } else if ((state.chat_doc_ids ?? []).some((id) => /:\d{4}-W\d{2}$/.test(id))) {
      yield* this.purgeChatIndex(state);
    }
    yield* this.pollDocs(client, state);
    if (this.config.index_chat_history) {
      state.chat_grouping = grouping;
      yield* this.pollChats(client, state, grouping);
    }
  }
  *purgeChatIndex(state) {
    const ids = state.chat_doc_ids ?? [];
    state.chat_cursors = {};
    state.chat_grouping = void 0;
    if (ids.length === 0) {
      state.chat_doc_ids = [];
      return;
    }
    const remaining = new Set(ids);
    for (const batch of chunks(ids, DELETE_BATCH_SIZE)) {
      for (const id of batch) {
        remaining.delete(id);
      }
      state.chat_doc_ids = [...remaining];
      yield {
        updates: batch.map((id) => del(id)),
        state: structuredClone(state)
      };
    }
  }
  /**
   * Enumerates every visible document's metadata through the two
   * complementary Search v2 passes (see LarkCliClient.searchDocs). A
   * document is refetched when content or source metadata changes, or
   * when it is not in the index yet — so a failed fetch is retried on the
   * next poll instead of being lost behind the advancing mark.
   *
   * Enumeration recall is unstable between polls (indexed docs routinely
   * drop out of one enumeration and reappear in the next), so a document
   * missing from a completed enumeration is deleted only after a direct
   * fetch of its stored URL confirms it is no longer accessible. The mark
   * and the token->url index are committed in one final state.
   */
  async *pollDocs(client, state) {
    const previousMark = state.docs_high_water;
    let newMark = previousMark;
    const known = { ...state.docs ?? {} };
    const knownTokens = new Set(Object.keys(known));
    const enumerated = /* @__PURE__ */ new Set();
    const succeededUrls = /* @__PURE__ */ new Map();
    const processed = /* @__PURE__ */ new Set();
    const locations = new DocLocationResolver(client, this.signal);
    const signatures = { ...state.doc_signatures ?? {} };
    const positions = { ...state.doc_positions ?? {} };
    for (const sortByEditTime of [false, true]) {
      let pageToken;
      while (!this.signal.aborted) {
        let page;
        try {
          page = await client.searchDocs({ sortByEditTime, pageToken });
        } catch (error) {
          if (error instanceof LarkCliError && error.missingScopes.length > 0) {
            console.error(
              `[feishu] skipping cloud documents (${error.message}). Grant access with: lark-cli auth login --scope "${error.missingScopes.join(" ")}"`
            );
            return;
          }
          throw error;
        }
        const updates = [];
        for (const entity of page.entities) {
          if (this.signal.aborted) {
            return;
          }
          if (processed.has(entity.token)) {
            continue;
          }
          processed.add(entity.token);
          if (!INDEXABLE_DOC_TYPES.has(entity.type)) {
            continue;
          }
          enumerated.add(entity.token);
          const position = await locations.resolve(
            entity,
            positions[entity.token]
          );
          const signature = await cloudDocSignature(entity, position);
          if (isUnchangedDoc(entity, knownTokens, previousMark) && signatures[entity.token] === signature) {
            continue;
          }
          const doc = await this.fetchCloudDoc(client, entity, position);
          if (doc == null) {
            continue;
          }
          updates.push(upsert(doc));
          signatures[entity.token] = signature;
          positions[entity.token] = position;
          succeededUrls.set(
            entity.token,
            entity.url ?? position.url ?? buildDocUrl(
              entity.type,
              position.feishu?.obj_token ?? entity.token
            )
          );
          if (entity.editedAt != null && (newMark == null || entity.editedAt > newMark)) {
            newMark = entity.editedAt;
          }
        }
        if (updates.length > 0) {
          yield { updates };
        }
        if (!page.hasMore || page.pageToken == null || page.pageToken === pageToken) {
          break;
        }
        pageToken = page.pageToken;
      }
    }
    if (this.signal.aborted) {
      return;
    }
    const next = {};
    for (const token of enumerated) {
      const url = succeededUrls.get(token) ?? known[token];
      if (url != null) {
        next[token] = url;
      }
    }
    const deletes = [];
    if (enumerated.size > 0) {
      for (const token of knownTokens) {
        if (enumerated.has(token)) {
          continue;
        }
        if (this.signal.aborted) {
          return;
        }
        if (await this.isStillFetchable(client, known[token])) {
          next[token] = known[token];
        } else {
          deletes.push(del(`feishu:doc:${token}`));
        }
      }
    } else if (knownTokens.size > 0) {
      console.error(
        "[feishu] document enumeration returned nothing; skipping deletion pass"
      );
      Object.assign(next, known);
    }
    state.docs_high_water = newMark;
    state.docs = next;
    state.doc_signatures = Object.fromEntries(
      Object.entries(signatures).filter(([token]) => next[token] != null)
    );
    state.doc_positions = Object.fromEntries(
      Object.entries(positions).filter(([token]) => next[token] != null)
    );
    yield { updates: deletes, state: structuredClone(state) };
  }
  /**
   * True when a document missing from the enumeration can still be fetched
   * directly — a search recall gap rather than a deletion or lost access.
   */
  async isStillFetchable(client, url) {
    try {
      await client.fetchDocMarkdown(url);
      return true;
    } catch (error) {
      this.signal.throwIfAborted();
      console.error(
        `[feishu] ${url} disappeared from enumeration and cannot be fetched (${errorMessage2(error)}); deleting from index`
      );
      return false;
    }
  }
  async fetchCloudDoc(client, entity, position) {
    try {
      const content = await client.fetchDocMarkdown(
        entity.url ?? position.url ?? position.feishu?.obj_token ?? entity.token
      );
      if (content == null) {
        console.error(
          `[feishu] no content in ${entity.type} ${entity.token}; skipped`
        );
        return null;
      }
      return buildCloudDoc(entity, cleanupDocMarkdown(content), position);
    } catch (error) {
      this.signal.throwIfAborted();
      console.error(
        `[feishu] failed to fetch ${entity.type} ${entity.token}: ${errorMessage2(error)}`
      );
      return null;
    }
  }
  /**
   * Chat history is indexed as one document per chat per period (day, ISO
   * week, or the whole chat). For day/week, each chat's cursor is the day
   * of its newest indexed message and the poll refetches from the start of
   * the period containing that day, so the still-open period is re-upserted
   * complete. For whole-chat docs the cursor is the newest message's
   * "YYYY-MM-DD HH:mm" timestamp: a cheap probe from that day decides
   * whether anything is new before the full window is refetched to rebuild
   * the single document.
   */
  async *pollChats(client, state, grouping) {
    const lookbackDays = this.config.chat_history_days > 0 ? this.config.chat_history_days : DEFAULT_CHAT_LOOKBACK_DAYS;
    const defaultStartDay = localDateString(
      new Date(Date.now() - lookbackDays * 864e5)
    );
    const chatDocIds = new Set(state.chat_doc_ids ?? []);
    for await (const chat of this.listChats(client)) {
      if (this.signal.aborted) {
        return;
      }
      const cursor = state.chat_cursors?.[chat.chat_id];
      const fetchFromDay = grouping === "chat" ? defaultStartDay : grouping === "week" ? weekStartDay(cursor ?? defaultStartDay) : cursor ?? defaultStartDay;
      let messages;
      try {
        if (grouping === "chat" && cursor != null && !await this.hasNewMessages(client, chat.chat_id, cursor)) {
          continue;
        }
        messages = await this.listMessages(client, chat.chat_id, fetchFromDay);
      } catch (error) {
        this.signal.throwIfAborted();
        console.error(
          `[feishu] failed to list messages of chat ${chat.chat_id}: ${errorMessage2(error)}`
        );
        continue;
      }
      const periods = groupDaysByPeriod(groupMessagesByDay(messages), grouping);
      if (periods.size === 0) {
        continue;
      }
      const updates = [];
      let nextCursor = cursor ?? "";
      for (const [key, days] of periods) {
        const doc = buildChatPeriodDoc(chat, grouping, key, days);
        updates.push(upsert(doc));
        chatDocIds.add(doc.id);
        for (const [day, dayMessages] of days) {
          if (grouping === "chat") {
            const lastTime = dayMessages[dayMessages.length - 1]?.create_time;
            if (lastTime != null && lastTime > nextCursor) {
              nextCursor = lastTime;
            }
          } else if (day > nextCursor) {
            nextCursor = day;
          }
        }
      }
      state.chat_cursors = {
        ...state.chat_cursors ?? {},
        [chat.chat_id]: nextCursor
      };
      state.chat_doc_ids = [...chatDocIds].sort();
      yield { updates, state: structuredClone(state) };
    }
  }
  /**
   * Cheap probe for whole-chat docs: fetch from the cursor's day and check
   * for any message strictly newer than the cursor ("YYYY-MM-DD HH:mm"
   * strings compare chronologically). Quiet chats cost one small page
   * instead of a full-window refetch.
   */
  async hasNewMessages(client, chatId, cursor) {
    const probe = await this.listMessages(
      client,
      chatId,
      cursor.slice(0, 10)
    );
    return probe.some(
      (message) => message.deleted !== true && message.create_time != null && message.create_time > cursor
    );
  }
  async *listChats(client) {
    let pageToken;
    while (!this.signal.aborted) {
      const page = await client.listChats(pageToken);
      yield* page.chats;
      if (!page.hasMore || page.pageToken == null || page.pageToken === pageToken) {
        return;
      }
      pageToken = page.pageToken;
    }
  }
  async listMessages(client, chatId, sinceDay) {
    const messages = [];
    const startISO = dayStartISO(sinceDay);
    let pageToken;
    while (!this.signal.aborted) {
      const page = await client.listMessages(chatId, startISO, pageToken);
      messages.push(...page.messages);
      if (!page.hasMore || page.pageToken == null || page.pageToken === pageToken) {
        break;
      }
      pageToken = page.pageToken;
    }
    return messages;
  }
};
export {
  addDays,
  buildChatPeriodDoc,
  buildCloudDoc,
  chatTitle,
  clampContent,
  dayStartISO,
  FeishuConnector as default,
  groupDaysByPeriod,
  groupMessagesByDay,
  isUnchangedDoc,
  localDateString,
  periodKey,
  periodLabel,
  renderChatPeriod,
  senderLabel,
  weekStartDay
};
//# sourceMappingURL=main.js.map
