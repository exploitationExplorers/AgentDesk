import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

function Globe() {
  return (
    <svg
      aria-hidden="true"
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </svg>
  );
}

export function WelcomeNavigation({ scrollTo }: { scrollTo: (id: string) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const languageRef = useRef<HTMLDivElement>(null);
  const closeMobile = () => {
    setMobileOpen(false);
    openerRef.current?.focus({ preventScroll: true });
  };
  const navigateSection = (id: string) => {
    closeMobile();
    scrollTo(id);
  };
  useEffect(() => {
    if (!mobileOpen) return;
    const root = menuRef.current?.closest<HTMLElement>(".welcome-page");
    const originalOverflow = root?.style.overflowY ?? "";
    if (root) root.style.overflowY = "hidden";
    menuRef.current?.querySelector<HTMLButtonElement>("[data-mm-close]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        openerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Tab" || !menuRef.current) return;
      const items = [
        ...menuRef.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled])"),
      ].filter((item) => item.getClientRects().length);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (
        !menuRef.current.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const desktop = window.matchMedia("(min-width:561px)");
    const onDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onDesktop);
    return () => {
      if (root) root.style.overflowY = originalOverflow;
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onDesktop);
    };
  }, [mobileOpen]);
  useEffect(() => {
    if (!languageOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!languageRef.current?.contains(event.target as Node)) setLanguageOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLanguageOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [languageOpen]);
  return (
    <>
      <header className="nav" id="nav">
        <button
          type="button"
          className="logo"
          aria-label="AgentDesk 首页"
          onClick={() => scrollTo("stageWrap")}
        >
          <svg>
            <use href="#logo" />
          </svg>
          <span className="wm">AgentDesk</span>
        </button>
        <nav className="nav-links" aria-label="首页导航">
          <button className="welcome-scroll-link" type="button" onClick={() => scrollTo("how")}>
            使用指南
          </button>
        </nav>
        <div className="nav-right">
          <button className="nav-guides" type="button" onClick={() => scrollTo("how")}>
            使用指南
          </button>
          <div className="nav-lang-box" ref={languageRef}>
            <button
              type="button"
              className="nav-lang"
              aria-label="语言：简体中文"
              aria-expanded={languageOpen}
              onClick={() => setLanguageOpen((open) => !open)}
            >
              <Globe />
            </button>
            <ul className="nav-lang-menu" hidden={!languageOpen}>
              <li>
                <button
                  type="button"
                  className="nav-lang-opt on"
                  lang="zh-Hans"
                  aria-current="true"
                  onClick={() => setLanguageOpen(false)}
                >
                  简体中文
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </button>
              </li>
            </ul>
          </div>
          <Link className="btn btn-dark" to="/collaboration">
            打开「聊天」
          </Link>
        </div>
        <button
          ref={openerRef}
          type="button"
          className="nav-burger"
          aria-label="菜单"
          aria-expanded={mobileOpen}
          aria-controls="welcome-mobile-menu"
          data-mm-open=""
          onClick={() => setMobileOpen(true)}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </header>
      <div
        className="mm"
        id="welcome-mobile-menu"
        hidden={!mobileOpen}
        role="dialog"
        aria-modal="true"
        aria-label="菜单"
        ref={menuRef}
      >
        <div className="mm-top">
          <button className="mm-logo" type="button" onClick={() => navigateSection("stageWrap")}>
            <img src="/reference/icon.svg" alt="" />
            AgentDesk
          </button>
          <button
            type="button"
            className="nav-burger"
            aria-label="关闭菜单"
            data-mm-close=""
            onClick={closeMobile}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <nav className="mm-body">
          <button type="button" className="mm-link" onClick={() => navigateSection("how")}>
            <span>使用指南</span>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
          <p className="mm-label">
            <Globe />
            语言
          </p>
          <div className="mm-langs">
            <button
              type="button"
              className="mm-lang on"
              lang="zh-Hans"
              aria-current="true"
              onClick={closeMobile}
            >
              <span>简体中文</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </button>
          </div>
        </nav>
        <div className="mm-foot">
          <Link className="btn" to="/collaboration" onClick={closeMobile}>
            打开「聊天」
          </Link>
        </div>
      </div>
    </>
  );
}

export function WelcomeActions() {
  return (
    <div className="signup-cta">
      <Link className="btn btn-dark m-email" to="/collaboration">
        进入工作台
      </Link>
      <div className="signup">
        <span className="signup-caption">让你的 agent 开始协作</span>
        <Link className="btn btn-dark welcome-workbench-button" to="/collaboration">
          进入工作台
        </Link>
      </div>
      <p className="g-or">或</p>
      <Link className="g-btn" to="/collaboration">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        接入你的 agent
      </Link>
    </div>
  );
}
