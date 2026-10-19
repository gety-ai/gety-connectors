// src/index.ts
import {
  Connector,
  del,
  upsert
} from "@gety-ai/connector-sdk";
import { basename, join, normalize, win32 } from "node:path";
import { pathToFileURL } from "node:url";
var DOC_TYPE = "claude_code:session";
var ID_PREFIX = "claude-code:";
var STATE_SCHEMA_VERSION = 1;
var MAX_CONTENT_BYTES = 3 * 1024 * 1024;
function defaultProjectsDir(env = Deno.env, os = Deno.build.os) {
  const home = os === "windows" ? env.get("USERPROFILE") ?? env.get("HOME") : env.get("HOME") ?? env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory for Claude Code projects. Set HOME or USERPROFILE."
    );
  }
  return os === "windows" ? win32.join(home, ".claude", "projects") : join(home, ".claude", "projects");
}
function resolveRoot(config, env = Deno.env) {
  const override = config.projects_dir ?? env.get("GETY_CONFIG_PROJECTS_DIR") ?? env.get("PROJECTS_DIR");
  if (typeof override === "string" && override.trim()) {
    return normalize(override);
  }
  return defaultProjectsDir();
}
function includeSubagents(config) {
  return config.include_subagents === true;
}
function extractText(content) {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}
function readableModel(model) {
  if (!model) return model;
  const stripped = model.replace(/-\d{8}$/, "");
  const words = {
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    fable: "Fable",
    instant: "Instant"
  };
  const parts = stripped.split("-").filter(Boolean);
  const out = [];
  let start = 0;
  if (parts[0] === "claude") {
    out.push("Claude");
    start = 1;
  }
  for (let i = start; i < parts.length; i += 1) {
    const part = parts[i];
    if (words[part]) {
      out.push(words[part]);
    } else if (/^\d+$/.test(part) && parts[i + 1] && /^\d+$/.test(parts[i + 1])) {
      out.push(`${part}.${parts[i + 1]}`);
      i += 1;
    } else {
      out.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  return out.length > 0 ? out.join(" ") : model;
}
function extractSession(records) {
  const messages = [];
  let aiTitle = null;
  let sessionId = null;
  let project = null;
  let model = null;
  let gitBranch = null;
  let firstMessageTs = null;
  let lastMessageTs = null;
  let messageCount = 0;
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (type === "ai-title") {
      const candidate = raw.aiTitle ?? raw["ai-title"];
      if (typeof candidate === "string" && candidate.trim() && !aiTitle) {
        aiTitle = candidate.trim();
      }
    }
    if (typeof raw.sessionId === "string" && !sessionId) {
      sessionId = raw.sessionId;
    }
    if (typeof raw.cwd === "string" && !project) {
      project = raw.cwd;
    }
    if (typeof raw.gitBranch === "string" && raw.gitBranch) {
      gitBranch = raw.gitBranch;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = raw.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof message.model === "string" && message.model) {
      model = message.model;
    }
    const ts = parseTimestamp(raw.timestamp);
    if (ts) {
      if (!firstMessageTs) firstMessageTs = ts;
      lastMessageTs = ts;
    }
    messageCount += 1;
    if (role === "user") {
      userMessageCount += 1;
    } else {
      assistantMessageCount += 1;
    }
    const text = normalizeMessageText(role, extractText(message.content));
    if (text) {
      messages.push({ role, text, timestamp: ts });
    }
  }
  return {
    messages,
    aiTitle,
    sessionId,
    project,
    model,
    gitBranch,
    firstMessageTs,
    lastMessageTs,
    messageCount,
    userMessageCount,
    assistantMessageCount
  };
}
function normalizeMessageText(role, text) {
  const trimmedText = text?.trim();
  if (!trimmedText) return null;
  if (role !== "user") return trimmedText;
  const commandMessage = formatCommandMessage(trimmedText);
  if (commandMessage) return commandMessage;
  return isInjectedUserContext(trimmedText) ? null : trimmedText;
}
function formatCommandMessage(text) {
  const commandName = extractXmlTag(text, "command-name");
  const commandArgs = extractXmlTag(text, "command-args");
  if (!commandName && !commandArgs) return null;
  if (!commandArgs && isLocalNoiseCommand(commandName)) return null;
  const parts = [];
  if (commandName) {
    parts.push(`Command: \`${commandName.replaceAll("`", "\\`")}\``);
  }
  if (commandArgs) {
    parts.push(commandArgs);
  }
  return parts.join("\n\n") || null;
}
function extractXmlTag(text, tagName) {
  const pattern = new RegExp(
    `<${tagName}>([\\s\\S]*?)<\\/${tagName}>`,
    "u"
  );
  const value = text.match(pattern)?.[1]?.trim();
  return value ? value : null;
}
function isLocalNoiseCommand(commandName) {
  return commandName === "/model" || commandName === "/effort" || commandName === "/usage";
}
function isInjectedUserContext(text) {
  const firstLine = text.trimStart();
  return [
    "# AGENTS.md instructions for",
    "Base directory for this skill:",
    "<environment_context>",
    "<skill_content",
    "<task-notification>",
    "<user_instructions>",
    "<INSTRUCTIONS>",
    "<local-command",
    "<command-"
  ].some((prefix) => firstLine.startsWith(prefix));
}
function isIndexableSession(session) {
  return session.messages.some((message) => message.role === "user") && session.messages.some((message) => message.role === "assistant");
}
function chooseTitle(session, fileName) {
  if (session.aiTitle) return session.aiTitle;
  for (const message of session.messages) {
    if (message.role !== "user") continue;
    const cleaned = firstMeaningfulLine(message.text);
    if (cleaned) return truncateTitle(cleaned);
  }
  return session.sessionId ?? fileName;
}
function firstMeaningfulLine(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("<local-command") || trimmed.startsWith("<command-") || trimmed.startsWith("Command: `")) {
      continue;
    }
    return trimmed;
  }
  return "";
}
function truncateTitle(text) {
  const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) ?? text;
  return firstLine.length > 100 ? firstLine.slice(0, 100) + "\u2026" : firstLine;
}
function renderMarkdown(session, title) {
  const infoLines = [];
  if (session.project) {
    infoLines.push(`- Project: \`${tildeHome(session.project)}\``);
  }
  if (session.model) {
    infoLines.push(`- Model: \`${readableModel(session.model)}\``);
  }
  if (session.gitBranch) {
    infoLines.push(`- Git branch: \`${session.gitBranch}\``);
  }
  let body = `# ${markdownHeadingText(title)}`;
  if (infoLines.length > 0) {
    body += `

## Session

${infoLines.join("\n")}`;
  }
  let truncated = false;
  const budget = MAX_CONTENT_BYTES;
  for (const round of renderConversationRounds(session.messages)) {
    const block = `

---

${round}`;
    if (body.length + block.length > budget) {
      truncated = true;
      break;
    }
    body += block;
  }
  return { content: body, truncated };
}
function renderConversationRounds(messages) {
  const rounds = [];
  let currentRound = [];
  for (const message of messages) {
    if (message.role === "user" && currentRound.length > 0) {
      rounds.push(currentRound);
      currentRound = [];
    }
    const heading = message.role === "user" ? "## User" : "## Claude Code";
    currentRound.push(`${heading}

${message.text}`);
  }
  if (currentRound.length > 0) {
    rounds.push(currentRound);
  }
  return rounds.map((round) => round.join("\n\n"));
}
function markdownHeadingText(text) {
  return text.replace(/\s+/g, " ").trim() || "Untitled Claude Code session";
}
function tildeHome(path) {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}
function parseTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
function parseJsonl(text) {
  const records = [];
  let parseErrors = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      parseErrors += 1;
    }
  }
  return { records, parseErrors };
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
async function buildDocFromRecords(records, options) {
  const session = extractSession(records);
  if (!isIndexableSession(session)) {
    return null;
  }
  const parseErrors = options.parseErrors ?? 0;
  const id = `${ID_PREFIX}${await sha256Hex(options.relPath)}`;
  const title = chooseTitle(session, options.fileName);
  const { content, truncated } = renderMarkdown(session, title);
  const updatedAt = session.lastMessageTs ?? new Date(options.fileMtime).toISOString();
  const metadata = {
    project: session.project ?? null,
    session_id: session.sessionId ?? null,
    path: options.relPath,
    source_path: options.relPath,
    model: session.model ?? null,
    git_branch: session.gitBranch ?? null,
    message_count: session.messageCount,
    user_message_count: session.userMessageCount,
    assistant_message_count: session.assistantMessageCount,
    file_size: options.fileSize
  };
  if (session.firstMessageTs) {
    metadata.created_at = session.firstMessageTs;
  }
  if (truncated) {
    metadata.truncated = true;
  }
  if (parseErrors > 0) {
    metadata.parse_errors = parseErrors;
  }
  if (options.sourcePath) {
    metadata.url = pathToFileURL(options.sourcePath).href;
  }
  return {
    id,
    title,
    content,
    content_format: "markdown",
    doc_type: DOC_TYPE,
    doc_updated_at: updatedAt,
    original_file_size: options.fileSize,
    metadata
  };
}
async function buildDocFromFile(root, relPath, stat) {
  const absPath = join(root, relPath);
  let text;
  try {
    text = await Deno.readTextFile(absPath);
  } catch {
    return null;
  }
  const hash = await sha256Hex(text);
  const { records, parseErrors } = parseJsonl(text);
  const doc = await buildDocFromRecords(records, {
    relPath,
    fileName: basename(relPath),
    fileSize: stat.size,
    fileMtime: stat.mtime,
    parseErrors,
    sourcePath: absPath
  });
  return doc == null ? { kind: "skip", hash } : { kind: "doc", doc, hash };
}
async function scanJsonl(root, signal, includeSubagentFiles) {
  const files = /* @__PURE__ */ new Map();
  const result = { files, complete: true, rootMissing: false };
  async function walk(dir, base) {
    let iter;
    try {
      iter = Deno.readDir(dir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (base === "") {
          result.rootMissing = true;
        } else {
          result.complete = false;
        }
        return;
      }
      result.complete = false;
      return;
    }
    try {
      for await (const entry of iter) {
        if (signal.aborted) return;
        const childAbs = join(dir, entry.name);
        const childRel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          if (!includeSubagentFiles && isSubagentPath(childRel)) continue;
          await walk(childAbs, childRel);
        } else if (entry.isFile && entry.name.endsWith(".jsonl") && (includeSubagentFiles || !isSubagentPath(childRel))) {
          let stat;
          try {
            stat = await Deno.stat(childAbs);
          } catch {
            result.complete = false;
            continue;
          }
          files.set(childRel, {
            absPath: childAbs,
            relPath: childRel,
            mtime: stat.mtime?.getTime() ?? 0,
            size: stat.size ?? 0
          });
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (base === "") {
          result.rootMissing = true;
        } else {
          result.complete = false;
        }
        return;
      }
      result.complete = false;
    }
  }
  await walk(root, "");
  return result;
}
function isSubagentPath(relPath) {
  return relPath.split("/").includes("subagents");
}
function normalizeState(lastState) {
  if (!isRecord(lastState)) {
    return { files: {}, forceReindex: false };
  }
  if (lastState.schema_version === STATE_SCHEMA_VERSION && isRecord(lastState.files)) {
    return {
      files: sanitizeFileMap(lastState.files),
      forceReindex: false
    };
  }
  return {
    files: sanitizeFileMap(lastState),
    forceReindex: true
  };
}
function sanitizeFileMap(value) {
  const files = {};
  for (const [relPath, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const mtime = typeof raw.mtime === "number" ? raw.mtime : null;
    const size = typeof raw.size === "number" ? raw.size : null;
    if (mtime == null || size == null) continue;
    files[relPath] = {
      mtime,
      size,
      hash: typeof raw.hash === "string" ? raw.hash : "",
      docId: typeof raw.docId === "string" ? raw.docId : ""
    };
  }
  return files;
}
function makeState(files, includeSubagentFiles) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    include_subagents: includeSubagentFiles,
    files
  };
}
async function* pollClaudeCode(config, lastState, signal) {
  const includeSubagentFiles = includeSubagents(config);
  const priorState = normalizeState(lastState);
  const prior = priorState.files;
  const working = { ...prior };
  const root = resolveRoot(config);
  const scan = await scanJsonl(root, signal, includeSubagentFiles);
  if (signal.aborted) return;
  const scanAuthoritative = scan.complete || scan.rootMissing;
  const current = scan.files;
  if (scanAuthoritative) {
    const deletedIds = [];
    for (const [relPath, fingerprint] of Object.entries(prior)) {
      if (!current.has(relPath)) {
        if (fingerprint.docId) {
          deletedIds.push(fingerprint.docId);
        }
        delete working[relPath];
      }
    }
    if (deletedIds.length > 0) {
      yield {
        updates: deletedIds.map((id) => del(id)),
        state: makeState({ ...working }, includeSubagentFiles)
      };
    }
  }
  for (const [relPath, { mtime, size }] of current) {
    if (signal.aborted) break;
    const prev = prior[relPath];
    const cheapUnchanged = !priorState.forceReindex && prev != null && prev.mtime === mtime && prev.size === size && typeof prev.hash === "string" && prev.hash.length > 0;
    const built = await buildDocFromFile(root, relPath, { mtime, size });
    if (built == null) {
      continue;
    }
    if (built.kind === "skip") {
      working[relPath] = {
        mtime,
        size,
        hash: built.hash,
        docId: ""
      };
      if (prev?.docId) {
        yield {
          updates: [del(prev.docId)],
          state: makeState({ ...working }, includeSubagentFiles)
        };
      }
      continue;
    }
    if (cheapUnchanged && prev.hash === built.hash) {
      continue;
    }
    working[relPath] = {
      mtime,
      size,
      hash: built.hash,
      docId: built.doc.id
    };
    yield {
      updates: [upsert(built.doc)],
      state: makeState({ ...working }, includeSubagentFiles)
    };
  }
}
var ClaudeCodeConnector = class extends Connector {
  async *poll() {
    yield* pollClaudeCode(this.config, this.lastState ?? null, this.signal);
  }
};
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export {
  buildDocFromRecords,
  ClaudeCodeConnector as default,
  defaultProjectsDir,
  extractText,
  pollClaudeCode,
  readableModel
};
//# sourceMappingURL=main.js.map
