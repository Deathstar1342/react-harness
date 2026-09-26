import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryContents } from "../client/DirectoryBrowser";
import { ProjectDialog, SettingsDialog } from "../client/WorkspaceDialogs";
import { createProject, directoryCrumbs, folderName, listDirectories, saveWorkspace, workspaceSettings } from "../client/workspace";
import type { DirectoryListing } from "../shared/types";

afterEach(() => vi.unstubAllGlobals());
const listing: DirectoryListing = {
  path: "/home/dev/projects", parentPath: "/home/dev", truncated: false,
  entries: [{ name: "<draft & final>", path: "/home/dev/projects/<draft & final>" }],
  roots: [{ name: "Home", path: "/home/dev" }, { name: "Mounted drives", path: "/mnt" }],
};
function mockResponse(data: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("workspace side effect contracts", () => {
  it("lets the backend allocate a unique create folder even if an import was selected previously", async () => {
    const fetcher = mockResponse({ id: "created", path: "/workspace/my-project-2" });
    await createProject(" My project ", "create", "/existing/do-not-overwrite");
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/projects");
    expect(JSON.parse(options.body)).toEqual({ name: "My project", mode: "create" });
  });
  it("imports exactly the selected backend folder, including spaces and special characters", async () => {
    const fetcher = mockResponse({ id: "imported" });
    const path = "C:\\Projects\\A & B #1";
    await createProject("Selected", "import", path);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ name: "Selected", mode: "import", path });
  });
  it("does not create a project without a name or import without a selected folder", () => {
    const fetcher = mockResponse({});
    expect(() => createProject(" ", "create")).toThrow("project name");
    expect(() => createProject("Project", "import")).toThrow("Choose a folder");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads the saved workspace and changes only the future-project preference", async () => {
    const expected = { workspaceRoot: "/mnt/d/projects", defaultWorkspaceRoot: "/home/dev/React Harness Projects" };
    const fetcher = mockResponse(expected);
    expect(await workspaceSettings()).toEqual(expected);
    expect(fetcher.mock.calls[0][0]).toBe("/api/workspace");
    const saving = mockResponse(expected);
    expect(await saveWorkspace(expected.workspaceRoot)).toEqual(expected);
    expect(saving.mock.calls[0][0]).toBe("/api/workspace");
    expect(saving.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(saving.mock.calls[0][1].body)).toEqual({ workspaceRoot: expected.workspaceRoot });
  });
  it("surfaces rejected imports and preference saves as failures", async () => {
    mockResponse({ error: "Directory is not accessible" }, 400);
    await expect(createProject("Private", "import", "/private")).rejects.toThrow("Directory is not accessible");
    mockResponse({ error: "Workspace is not writable" }, 400);
    await expect(saveWorkspace("/private")).rejects.toThrow("Workspace is not writable");
  });
  it("starts browsing Home with no path and encodes subsequent backend paths", async () => {
    let fetcher = mockResponse(listing);
    expect(await listDirectories()).toEqual(listing);
    expect(fetcher.mock.calls[0][0]).toBe("/api/directories");
    fetcher = mockResponse(listing);
    const path = "/mnt/c/A & B/# draft?";
    await listDirectories(path);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/directories?path=${encodeURIComponent(path)}`);
  });
  it("propagates navigation cancellation and exposes inaccessible directories", async () => {
    const fetcher = mockResponse(listing);
    const controller = new AbortController();
    await listDirectories("/home/dev", controller.signal);
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    controller.abort();
    expect(signal.aborted).toBe(true);
    mockResponse({ error: "Permission denied" }, 403);
    await expect(listDirectories("/private")).rejects.toMatchObject({ status: 403, message: "Permission denied" });
  });
});

describe("backend filesystem navigation", () => {
  it("preserves Linux, drive and network-share roots when constructing ancestors", () => {
    expect(directoryCrumbs("/home/dev/My work")).toEqual([
      { name: "/", path: "/" }, { name: "home", path: "/home" },
      { name: "dev", path: "/home/dev" }, { name: "My work", path: "/home/dev/My work" },
    ]);
    expect(directoryCrumbs("D:\\Projects\\App").map((entry) => entry.path)).toEqual(["D:\\", "D:\\Projects", "D:\\Projects\\App"]);
    expect(directoryCrumbs("\\\\server\\share\\App").map((entry) => entry.path)).toEqual(["\\\\server\\share\\", "\\\\server\\share\\App"]);
    expect(directoryCrumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });
  it("does not split a legal backslash inside a Linux directory name", () => {
    expect(directoryCrumbs("/home/back\\slash").at(-1)).toEqual({ name: "back\\slash", path: "/home/back\\slash" });
    expect(folderName("/home/back\\slash")).toBe("back\\slash");
    expect(folderName("C:\\Projects\\app\\")).toBe("app");
  });
  it("renders real folder rows, shortcuts and accessible breadcrumbs with escaped filenames", () => {
    const html = renderToStaticMarkup(createElement(DirectoryContents, { listing, onNavigate: () => {} }));
    expect(html).toContain('aria-label="Folder shortcuts"');
    expect(html).toContain('aria-label="Parent folder"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain("Mounted drives");
    expect(html).toContain("&lt;draft &amp; final&gt;");
    expect(html).not.toContain("<draft & final>");
    expect(html).not.toContain('<input');
  });
  it("disables navigation while loading and explains empty or truncated directories", () => {
    const html = renderToStaticMarkup(createElement(DirectoryContents, {
      listing: { ...listing, path: "/", parentPath: null, entries: [], truncated: true }, onNavigate: () => {}, disabled: true,
    }));
    expect(html).toContain('aria-label="Parent folder" disabled=""');
    expect(html).toContain("No subfolders. You can select this folder.");
    expect(html).toContain("more entries than can be shown");
  });
  it("requires only a name for new projects and presents a folder chooser in Settings", () => {
    const project = renderToStaticMarkup(createElement(ProjectDialog, { onCreated: () => {}, onClose: () => {} }));
    expect(project.match(/<input/g)).toHaveLength(1);
    expect(project).toContain("Project name");
    expect(project).toContain("Import existing");
    expect(project).not.toContain("Workspace path");
    const settings = renderToStaticMarkup(createElement(SettingsDialog, { onClose: () => {} }));
    expect(settings).toContain("Change folder…");
    expect(settings).toContain("Existing projects stay where they are.");
    expect(settings).not.toContain('<input');
  });
});
