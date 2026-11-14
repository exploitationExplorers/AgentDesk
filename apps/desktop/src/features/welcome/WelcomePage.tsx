import { useCallback, useEffect, useRef } from "react";
import { WelcomeContent } from "./WelcomeContent";
import { mountWelcomeMotion } from "./welcome-motion";
import "./welcome.css";

export function WelcomePage() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return mountWelcomeMotion(root);
  }, []);
  const scrollTo = useCallback((id: string) => {
    const root = rootRef.current;
    if (!root) return;
    const section = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!section) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top =
      section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top, behavior: reduceMotion ? "instant" : "smooth" });
  }, []);
  return (
    <div
      ref={rootRef}
      className="welcome-page"
      lang="zh-Hans"
      data-google=""
      data-welcome-scroll=""
    >
      <WelcomeContent scrollTo={scrollTo} />
    </div>
  );
}
