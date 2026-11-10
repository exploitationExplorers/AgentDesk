/* eslint-disable @typescript-eslint/no-unused-vars */
// Native DOM port of the preserved reference HTML. No iframe or runtime eval.
import { createSurface } from "./motion-runtime";
export function mountAiImageGeneration(target, options = {}) {
  const scope = createSurface(
    target,
    {
      markup:
        '\r\n    <div class="container">\r\n        <div class="title">AI is designing the poster</div>\r\n        <div class="card" id="interactive-card">\r\n            <div class="grid" id="dot-grid"></div>\r\n        </div>\r\n    </div>\r\n\r\n    \r\n',
      css: "\r\n        :root {\r\n            --bg-primary: #ffffff;\r\n            --text-secondary: #a1a1aa;\r\n            --surface-01: #f4f4f5;\r\n            \r\n            --dot-base: #e4e4e7; \r\n            --dot-active-rgb: 152, 152, 152; \r\n            --dot-base-rgb: 228, 228, 231;\r\n        }\r\n\r\n        body {\r\n            margin: 0;\r\n            padding: 0;\r\n            min-height: 100vh;\r\n            display: flex;\r\n            align-items: center;\r\n            justify-content: center;\r\n            background-color: var(--bg-primary);\r\n            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;\r\n            -webkit-font-smoothing: antialiased;\r\n            -moz-osx-font-smoothing: grayscale;\r\n        }\r\n\r\n        .container {\r\n            display: flex;\r\n            flex-direction: column;\r\n            gap: 20px;\r\n        }\r\n\r\n        .title {\r\n            color: var(--text-secondary);\r\n            font-size: 15px;\r\n            font-weight: 400;\r\n            padding-left: 4px;\r\n            letter-spacing: 0.3px;\r\n            display: flex;\r\n            align-items: center;\r\n            gap: 8px;\r\n        }\r\n\r\n        .title::after {\r\n            content: '';\r\n            display: inline-block;\r\n            width: 4px;\r\n            height: 4px;\r\n            background-color: var(--text-secondary);\r\n            border-radius: 50%;\r\n            animation: pulse 1.5s infinite opacity;\r\n        }\r\n\r\n        @keyframes pulse {\r\n            0%, 100% { opacity: 0.3; }\r\n            50% { opacity: 1; }\r\n        }\r\n\r\n        .card {\r\n            width: 420px;\r\n            height: 420px;\r\n            background-color: var(--surface-01);\r\n            border-radius: 24px;\r\n            position: relative;\r\n            display: flex;\r\n            align-items: center;\r\n            justify-content: center;\r\n            overflow: hidden;\r\n            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.01), 0 2px 4px -1px rgba(0, 0, 0, 0.01);\r\n        }\r\n\r\n        .grid {\r\n            display: grid;\r\n            grid-template-columns: repeat(20, 18px);\r\n            grid-template-rows: repeat(20, 18px);\r\n            place-items: center; \r\n        }\r\n\r\n        .dot {\r\n            width: 12px;\r\n            height: 12px;\r\n            background-color: var(--dot-base);\r\n            border-radius: 50%;\r\n            will-change: transform, background-color;\r\n            backface-visibility: hidden;\r\n            transform: translateZ(0) scale(0.333);\r\n        }\r\n    ",
      width: 520,
      height: 560,
      responsive: false,
    },
    options,
  );
  const {
    document,
    window,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ResizeObserver,
    IntersectionObserver,
    matchMedia,
  } = scope;

  document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("dot-grid");

    const cols = 20;
    const rows = 20;
    const dots = [];

    const effectRadius = 110;

    const minScale = 0.333;
    // 【核心调整】：把最大缩放值从 1 降到了 0.65，让点变得更小、更克制
    const maxScale = 0.65;

    const baseRGB = [228, 228, 231];
    const activeRGB = [152, 152, 152];

    for (let i = 0; i < rows * cols; i++) {
      const dot = document.createElement("div");
      dot.className = "dot";
      grid.appendChild(dot);

      dots.push({
        el: dot,
        x: ((i % cols) - cols / 2) * 18,
        y: (Math.floor(i / cols) - rows / 2) * 18,
      });
    }

    const orbs = [
      { rx: 90, ry: 70, sx: 0.7, sy: 1.1, px: 0, py: 0, pulseSpeed: 0 },
      { rx: 70, ry: 95, sx: -1.2, sy: 0.8, px: 2, py: 1.5, pulseSpeed: 0.35 },
    ];

    const animateDots = (timestamp) => {
      const time = timestamp * 0.0012;

      const activeFocus = orbs.map((orb) => {
        const weight = orb.pulseSpeed > 0 ? (Math.sin(time * orb.pulseSpeed) + 1) / 2 : 1;

        return {
          x: Math.sin(time * orb.sx + orb.px) * orb.rx,
          y: Math.cos(time * orb.sy + orb.py) * orb.ry,
          weight: weight,
        };
      });

      dots.forEach((dot) => {
        let combinedIntensity = 0;

        activeFocus.forEach((focus) => {
          const dx = focus.x - dot.x;
          const dy = focus.y - dot.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < effectRadius) {
            let intensity = 1 - distance / effectRadius;
            intensity = Math.pow(intensity, 1.4) * focus.weight;

            combinedIntensity += intensity;
          }
        });

        combinedIntensity = Math.min(1.0, combinedIntensity);

        if (combinedIntensity > 0.01) {
          const scale = minScale + (maxScale - minScale) * combinedIntensity;

          const r = Math.round(baseRGB[0] + (activeRGB[0] - baseRGB[0]) * combinedIntensity);
          const g = Math.round(baseRGB[1] + (activeRGB[1] - baseRGB[1]) * combinedIntensity);
          const b = Math.round(baseRGB[2] + (activeRGB[2] - baseRGB[2]) * combinedIntensity);

          dot.el.style.transform = `translateZ(0) scale(${scale})`;
          dot.el.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
        } else {
          dot.el.style.transform = `translateZ(0) scale(${minScale})`;
          dot.el.style.backgroundColor = "var(--dot-base)";
        }
      });

      requestAnimationFrame(animateDots);
    };

    requestAnimationFrame(animateDots);
  });

  scope.ready();
  return scope.controller;
}
