import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./features/mobile/MobileApp";
import "./features/mobile/mobile.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker
    .register("/cloud-sw.js", { scope: "/", updateViaCache: "none" })
    .then((registration) => {
      const notify = () =>
        window.dispatchEvent(new CustomEvent("cloud-update", { detail: registration }));
      if (registration.waiting) notify();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting && navigator.serviceWorker.controller) notify();
        });
      });
    })
    .catch(() => {
      /* 安装失败不影响在线工作台。 */
    });
}
