import { useEffect, useRef } from "react";
import poster from "./previews/mac-desk.jpg";
import "./mac-desk.css";

export function MacDesk() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;
    const controller = new AbortController();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void import("./render-mac-desk")
          .then(async ({ mountMacDesk }) => {
            if (cancelled) return;
            const release = await mountMacDesk(host, controller.signal);
            if (cancelled) release();
            else teardown = release;
          })
          .catch(() => {
            host.removeAttribute("data-rendered");
          });
      },
      { rootMargin: "240px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      controller.abort();
      observer.disconnect();
      teardown?.();
    };
  }, []);
  return (
    <div className="mac-model" ref={container}>
      <img className="mac-poster" src={poster} alt="" loading="lazy" />
    </div>
  );
}
