export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type WireContentFormat = "plaintext" | "markdown";

export type WireDoc = {
  id: string;
  title: string;
  content?: string | null;
  content_format?: WireContentFormat | null;
  metadata?: JsonValue | null;
  doc_updated_at?: string | null;
  parent_id?: string | null;
  hide_from_search?: boolean | null;
  doc_type?: string | null;
  original_file_size?: number | null;
};

export type Doc = WireDoc;

export type WireDocUpdate =
  | { kind: "upsert"; doc: WireDoc }
  | { kind: "delete"; id: string };

export type DocUpdate = WireDocUpdate;

export type PollResult = {
  updates: DocUpdate[];
  state?: unknown;
};

export abstract class Connector {
  protected config: Record<string, unknown> = {};
  protected lastState: unknown | null = null;
  protected signal: AbortSignal = new AbortController().signal;

  onload?(): void | Promise<void>;

  abstract poll(): AsyncGenerator<PollResult, void, unknown>;
}

export function upsert(doc: WireDoc): WireDocUpdate {
  return { kind: "upsert", doc };
}

export function del(id: string): WireDocUpdate {
  return { kind: "delete", id };
}
