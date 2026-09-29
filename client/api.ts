import type { ChatDetail, RunEvent } from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(190_000),
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`,
      response.status,
    );
  if (data === null)
    throw new ApiError(
      "The server returned an empty or invalid response.",
      response.status,
    );
  return data as T;
}
export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const id = encodeURIComponent;
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";
export function eventText(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const value = data as Record<string, unknown>;
  return (
    [value.delta, value.text, value.output, value.content].find(
      (item): item is string => typeof item === "string",
    ) ?? ""
  );
}
export function latestEventId(detail: ChatDetail): number {
  return detail.events.reduce((latest, event) => Math.max(latest, event.id), 0);
}
export function terminalEvents(events: RunEvent[]): RunEvent[] {
  return events.filter(
    (event) =>
      event.type === "tool_output" ||
      event.type === "tool" ||
      event.type === "error",
  );
}
export function languageFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        py: "python",
        css: "css",
        html: "html",
        md: "markdown",
        yml: "yaml",
        yaml: "yaml",
        sh: "shell",
        sql: "sql",
        rs: "rust",
        go: "go",
      } as Record<string, string>
    )[extension ?? ""] ?? "plaintext"
  );
}
export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
