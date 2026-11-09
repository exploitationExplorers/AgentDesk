import { useCallback, useEffect, useState } from "react";
import type { CloudApi } from "../../lib/cloud-api";
import { errorMessage } from "../../lib/cloud-api";

export function useCloudQuery<T>(api: CloudApi, path: string | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error: string;
    loading: boolean;
    observedAt?: string;
  }>({ path: null, error: "", loading: true });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    if (!path) {
      setState({ path, error: "", loading: false });
      return;
    }
    setState((previous) =>
      previous.path === path
        ? { ...previous, loading: true, error: "" }
        : { path, loading: true, error: "" },
    );
    void api
      .request<T>(path, undefined, "GET", abort.signal)
      .then((data) => {
        if (!abort.signal.aborted)
          setState({ path, data, error: "", loading: false, observedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState((previous) => ({ ...previous, error: errorMessage(error), loading: false }));
      });
    return () => abort.abort();
  }, [api, path, revision]);
  return {
    ...(state.path === path
      ? state
      : { data: undefined, error: "", loading: Boolean(path), observedAt: undefined }),
    refresh,
  };
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function displayTime(value?: string | null) {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "时间未知";
}
