import { useEffect, useRef, useState } from "react";
import type { ChatDetail } from "../shared/types";
import { ApiError, errorText, eventText, id, latestEventId, request } from "./api";

export function useConversation(chatId: string, onChange: () => void) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [error, setError] = useState("");
  const [stream, setStream] = useState("");
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const [fileRevision, setFileRevision] = useState(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    let disposed = false;
    let removed = false;
    let source: EventSource | undefined;
    let refreshing = false;
    let connecting = false;
    let pending = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let cursor = 0;
    setDetail(null);
    setError("");
    setStream("");
    setConnection("connecting");
    const markRemoved = () => {
      removed = true;
      source?.close();
      clearInterval(poll);
      clearTimeout(refreshTimer);
      setDetail(null);
      setStream('');
      setError('This chat was removed. Select another conversation.');
      changeRef.current();
    };
    const refresh = async () => {
      if (disposed || removed) return;
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      try {
        const next = await request<ChatDetail>(`/chats/${id(chatId)}`);
        if (!disposed && !removed) {
          setDetail(next);
          setError("");
          changeRef.current();
        }
      } catch (e) {
        if (!disposed && !removed) {
          if (e instanceof ApiError && e.status===404) markRemoved();
          else setError(errorText(e));
        }
      } finally {
        refreshing = false;
        if (pending && !disposed && !removed) {
          pending = false;
          void refresh();
        }
      }
    };
    refreshRef.current = refresh;
    const scheduleRefresh = () => {
      if (refreshTimer || disposed || removed) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 160);
    };
    const connect = async () => {
      if (connecting || disposed || removed) return;
      connecting = true;
      try {
        const initial = await request<ChatDetail>(`/chats/${id(chatId)}`);
        if (disposed || removed) return;
        setDetail(initial);
        cursor = latestEventId(initial);
        source = new EventSource(
          `/api/chats/${id(chatId)}/events?after=${cursor}`,
        );
        source.onopen = () => {
          if (!disposed && !removed) {
            setConnection("connected");
            setFileRevision((old) => old + 1);
            void refresh();
          }
        };
        source.onerror = () => {
          if (!disposed && !removed) { setConnection("reconnecting");void refresh(); }
        };
        source.addEventListener('chat_removed',()=>{if(!disposed && !removed) markRemoved();});
        for (const type of [
          "message",
          "status",
          "delta",
          "plan",
          "plan_progress",
          "goal",
          "goal_completed",
          "approval",
          "tool",
          "tool_output",
          "command",
          "tests",
          "file_changed",
          "steering",
          "review",
          "delegation",
          "usage",
          "context_summary",
          "error",
        ]) {
          source.addEventListener(type, (event: Event) => {
            if (disposed || removed || !(event instanceof MessageEvent)) return;
            const eventId = Number(event.lastEventId);
            if (eventId && eventId <= cursor) return;
            if (eventId) cursor = eventId;
            let data: unknown;
            try {
              data = JSON.parse(event.data as string);
            } catch {
              setError(
                "A malformed event was received. Reloading durable state.",
              );
              scheduleRefresh();
              return;
            }
            if (type === "delta") {
              setStream((old) => (old + (eventText(data) || " ")).slice(-32000));
              return;
            }
            if (type === "message" || type === "status" || type === "error")
              setStream("");
            if (type === "file_changed") setFileRevision((old) => old + 1);
            scheduleRefresh();
          });
        }
      } catch (e) {
        if (!disposed && !removed) {
          if (e instanceof ApiError && e.status===404) markRemoved();
          else {setError(errorText(e));setConnection("reconnecting");}
        }
      } finally {
        connecting = false;
      }
    };
    void connect();
    // A periodic durable refresh covers missed notifications and initial HTTP failures.
    poll = setInterval(() => {
      if (disposed || removed) return;
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        source = undefined;
      }
      if (!source) void connect();
      else void refresh();
    }, 15000);
    return () => {
      disposed = true;
      source?.close();
      clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [chatId]);
  return {
    detail,
    error,
    stream,
    connection,
    fileRevision,
    refresh: () => refreshRef.current(),
  };
}
