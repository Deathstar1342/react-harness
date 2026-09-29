import type { DirectoryListing, Project, WorkspaceSettings } from "../shared/types";
import { post, request } from "./api";

export const workspaceSettings = () => request<WorkspaceSettings>("/workspace");
export const saveWorkspace = (workspaceRoot: string) =>
  request<WorkspaceSettings>("/workspace", { method: "PATCH", body: JSON.stringify({ workspaceRoot }) });
export const listDirectories = (path?: string, signal?: AbortSignal) =>
  request<DirectoryListing>(`/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(190_000)]) : undefined });
export function createProject(name: string, mode: "create" | "import", path?: string) {
  if (!name.trim()) throw new Error("Enter a project name.");
  if (mode === "import" && !path) throw new Error("Choose a folder to import.");
  return post<Project>("/projects", mode === "create"
    ? { name: name.trim(), mode }
    : { name: name.trim(), mode, path });
}

// Paths belong to the backend OS, which may differ from the browser OS.
export function directoryCrumbs(path: string): { name: string; path: string }[] {
  const separator = path.startsWith("/") ? "/" : path.includes("\\") ? "\\" : "/";
  const root = path.match(/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\?|\/)/)?.[0];
  if (!root) return [{ name: path, path }];
  const crumbs = [{ name: root, path: root }];
  let current = root;
  for (const name of path.slice(root.length).split(separator).filter(Boolean)) {
    current = `${current}${current.endsWith(separator) ? "" : separator}${name}`;
    crumbs.push({ name, path: current });
  }
  return crumbs;
}
export const folderName = (path: string) => path.split(path.startsWith("/") ? "/" : /[\\/]/).filter(Boolean).at(-1) ?? path;
