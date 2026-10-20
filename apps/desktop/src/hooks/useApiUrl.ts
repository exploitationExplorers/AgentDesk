import { useEffect, useState } from "react";
import { apiUrl } from "../lib/http";

/** 生成带 token 的绝对地址，供 <img>/EventSource 等无法设置请求头的场景使用。 */
export function useApiUrl(
  path: string | null,
  query?: Record<string, string | undefined>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = path ? `${path}?${JSON.stringify(query ?? {})}` : null;
  useEffect(() => {
    let alive = true;
    if (!path) {
      setUrl(null);
      return;
    }
    void apiUrl(path, query).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
