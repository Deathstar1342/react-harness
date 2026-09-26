import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, eventText, request } from "../client/api";

afterEach(() => vi.unstubAllGlobals());
describe("UI API transport", () => {
  it("preserves server conflict details so the editor can retain its buffer", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "File version changed" }), {
            status: 409,
          }),
        ),
    );
    await expect(
      request("/projects/p/file", {
        method: "PUT",
        body: JSON.stringify({
          content: "unsaved text",
          baseHash: "old",
          owner: "editor-owner",
        }),
      }),
    ).rejects.toMatchObject({ status: 409, message: "File version changed" });
  });
  it("fails visibly for non-JSON proxy errors and never treats them as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>proxy error</html>", { status: 502 }),
        ),
    );
    await expect(request("/chats/c")).rejects.toMatchObject({
      status: 502,
      message: "Request failed (502)",
    });
  });
  it("rejects a malformed successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(request("/chats/c")).rejects.toBeInstanceOf(ApiError);
  });
  it("sends edits with their exact version and owner without browser credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ path: "app.ts", content: "next", hash: "new" }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const edit = {
      path: "app.ts",
      content: "next",
      baseHash: "opened-version",
      owner: "editor-123",
    };
    await request("/projects/p/file", {
      method: "PUT",
      body: JSON.stringify(edit),
    });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/projects/p/file");
    expect(JSON.parse(options.body)).toEqual(edit);
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
  });
  it("extracts only textual output from events", () => {
    expect(eventText({ agentId: "coder", output: "real output" })).toBe(
      "real output",
    );
    expect(eventText({ role: "architect", text: "{partial" })).toBe("{partial");
    expect(eventText({ action: { name: "write_file" } })).toBe("");
  });
});
