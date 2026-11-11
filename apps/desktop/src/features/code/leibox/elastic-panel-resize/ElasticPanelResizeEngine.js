// Native DOM port of the preserved reference HTML. No iframe or runtime eval.
import { createSurface } from "./motion-runtime";
export function mountElasticPanelResize(target, options = {}) {
  const scope = createSurface(
    target,
    {
      markup:
        '<main class="er-scene" aria-label="Elastic panel resize"><section class="er-panel" id="er-panel" aria-label="Resizable panel"></section><div class="er-handle" role="separator" tabindex="0" aria-label="Resize panel" aria-orientation="vertical" aria-controls="er-panel" aria-valuemin="50" aria-valuemax="72.4" aria-valuenow="61.4"><svg viewBox="0 0 80 160" aria-hidden="true"><path class="er-outline" d="M40 50 Q40 80 40 110"/><path class="er-ink" d="M40 50 Q40 80 40 110"/></svg></div><span class="er-status" aria-live="polite"></span></main>',
      css: "*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{overflow:hidden}\r\n.er-scene{position:relative;width:100%;height:100vh;min-height:280px;overflow:hidden;background:#efefef;user-select:none;-webkit-user-select:none;isolation:isolate;font-family:Arial,Helvetica,sans-serif}\r\n.er-scene::before{content:\"\";position:absolute;inset:0;pointer-events:none;opacity:.65;filter:contrast(4);mix-blend-mode:soft-light;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Cpath filter='url(%23n)' d='M0 0h160v160H0z'/%3E%3C/svg%3E\")}\r\n.er-panel{position:absolute;z-index:1;top:17px;right:17px;bottom:17px;left:38.65%;border:1px solid #d4d4d4;border-radius:40px;background:#fbfbfb;box-shadow:0 2px 4px #0000000a,inset 0 0 0 1px #ffffffb3}\r\n.er-handle{position:absolute;z-index:2;left:38.65%;top:17px;bottom:17px;width:32px;transform:translateX(-50%);padding:0;outline:none;cursor:ew-resize;touch-action:none;-webkit-tap-highlight-color:transparent;--er-reveal:0}\r\n.er-handle svg{position:absolute;left:-24px;top:50%;transform:translateY(-50%);width:80px;height:160px;overflow:visible;pointer-events:none;opacity:var(--er-reveal)}\r\n.er-ink,.er-outline{fill:none;stroke-linecap:round;stroke-linejoin:round}\r\n.er-ink{stroke:#c6c6c6;stroke-width:0}.er-outline{stroke:#fff;stroke-width:0}\r\n.er-handle:focus-visible::after{content:\"\";position:absolute;left:-8px;top:50%;width:48px;height:132px;transform:translateY(-50%);border:2px solid #666;border-radius:18px}\r\n.er-scene[data-state=dragging]{cursor:ew-resize}\r\n.er-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}\r\n",
      width: 1000,
      height: 1000,
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
    ResizeObserver,
    matchMedia,
  } = scope;
  /* Independent reconstruction from measured frames; the original source was not supplied. */
  (() => {
    const scene = document.querySelector(".er-scene");
    const panel = scene.querySelector(".er-panel");
    const handle = scene.querySelector(".er-handle");
    const ink = scene.querySelector(".er-ink");
    const outline = scene.querySelector(".er-outline");
    const status = scene.querySelector(".er-status");
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const initial = 0.3865,
      min = 0.276,
      max = 0.5;
    // Preview iframes and hidden mounts can execute before their first layout.
    let width = scope.rect(scene).width || 1000;
    let position = initial * width,
      target = position,
      velocity = 0;
    let bend = 0,
      bendVelocity = 0,
      offset = 0,
      offsetVelocity = 0;
    let thickness = 0,
      length = 60,
      reveal = 0,
      visible = false,
      motion = 0;
    let hovered = false,
      focused = false,
      drag = null,
      raf = 0,
      last = 0,
      hideTimer = 0;
    const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
    const reduced = () => media.matches;
    const legal = (value) => clamp(value, min * width, max * width);
    // Only the portion beyond a limit is resisted. The edge follows the pointer inside it.
    const rubber = (value) => {
      const bounded = legal(value),
        excess = value - bounded;
      return bounded + Math.sign(excess) * 15 * (1 - Math.exp(-Math.abs(excess) / 35));
    };
    function updateValue() {
      const value = Math.round((1 - target / width) * 1000 + 1e-8) / 10;
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-valuetext", `${value} percent wide`);
    }
    function draw() {
      panel.style.left = `${position}px`;
      handle.style.left = `${position}px`;
      const x = 40 + offset;
      const path = `M${x} ${80 - length / 2} Q${x + bend * 2} 80 ${x} ${80 + length / 2}`;
      ink.setAttribute("d", path);
      outline.setAttribute("d", path);
      ink.style.strokeWidth = String(thickness);
      outline.style.strokeWidth = String(thickness + 2 * reveal);
      const gray = Math.round(198 - 39 * motion);
      ink.style.stroke = `rgb(${gray},${gray},${gray})`;
      handle.style.setProperty("--er-reveal", String(reveal));
      scene.dataset.position = (position / width).toFixed(5);
      scene.dataset.bend = bend.toFixed(3);
      scene.dataset.offset = offset.toFixed(3);
      scene.dataset.visible = String(visible);
      scene.dataset.stretch = drag ? Math.abs(drag.raw - target).toFixed(2) : "0";
      updateValue();
    }
    function tick(now) {
      raf = 0;
      const dt = Math.min((now - last) / 1000 || 1 / 60, 1 / 30);
      last = now;
      const excess = drag ? drag.raw - target : 0;
      const pull = clamp(Math.abs(excess) / 80, 0, 1);
      const speed = drag ? (now - drag.time < 70 ? drag.speed : 0) : 0;
      const direction = clamp(speed / 60, -1, 1);
      const bendTarget = direction * 4.5 * (1 - pull);
      const offsetTarget = direction * 9 * (1 - pull) + Math.sign(excess) * 6 * pull;
      motion = Math.max(Math.abs(direction) * (1 - pull), pull);
      const revealTarget = visible ? 1 : 0;
      const thicknessTarget = (15 - 10 * motion - 2 * pull) * revealTarget;
      const lengthTarget = 60 + 30 * motion + 21 * pull;
      if (reduced()) {
        position = drag ? legal(drag.raw) : target;
        velocity = 0;
        bend = 0;
        bendVelocity = 0;
        offset = 0;
        offsetVelocity = 0;
        reveal = revealTarget;
        thickness = visible ? 15 : 0;
        length = 60;
        motion = 0;
        scene.dataset.state = drag ? "dragging" : "idle";
        draw();
        return;
      }
      for (let i = 0; i < 4; i++) {
        const step = dt / 4;
        if (!drag) {
          velocity += ((target - position) * 400 - velocity * 26) * step;
          position += velocity * step;
        }
        bendVelocity += ((bendTarget - bend) * 680 - bendVelocity * 34) * step;
        bend += bendVelocity * step;
        offsetVelocity += ((offsetTarget - offset) * 680 - offsetVelocity * 34) * step;
        offset += offsetVelocity * step;
      }
      const amount = 1 - Math.exp(-32 * dt);
      reveal += (revealTarget - reveal) * amount;
      thickness += (thicknessTarget - thickness) * amount;
      length += (lengthTarget - length) * amount;
      draw();
      const moving = Math.abs(target - position) > 0.01 || Math.abs(velocity) > 0.05;
      const shaping =
        Math.abs(bendTarget - bend) > 0.01 ||
        Math.abs(bendVelocity) > 0.03 ||
        Math.abs(offsetTarget - offset) > 0.01 ||
        Math.abs(offsetVelocity) > 0.03;
      const morphing =
        Math.abs(thicknessTarget - thickness) > 0.01 ||
        Math.abs(lengthTarget - length) > 0.01 ||
        Math.abs(revealTarget - reveal) > 0.001;
      if ((!drag && moving) || shaping || morphing || (drag && Math.abs(speed) > 0.1))
        raf = requestAnimationFrame(tick);
      else {
        if (!drag) {
          position = target;
          velocity = 0;
          scene.dataset.state = "idle";
        }
        bend = drag ? bendTarget : 0;
        offset = drag ? offsetTarget : 0;
        bendVelocity = 0;
        offsetVelocity = 0;
        reveal = revealTarget;
        thickness = drag ? thicknessTarget : 15 * reveal;
        length = drag ? lengthTarget : 60;
        if (!drag) motion = 0;
        draw();
      }
    }
    function wake() {
      if (reduced()) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        tick(performance.now());
        return;
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    }
    function show() {
      clearTimeout(hideTimer);
      visible = true;
      wake();
    }
    function hideLater() {
      clearTimeout(hideTimer);
      if (hovered || focused || drag) return;
      hideTimer = setTimeout(() => {
        visible = false;
        wake();
      }, 450);
    }
    function setTarget(value) {
      target = legal(value);
      updateValue();
      scene.dataset.state = "settling";
      show();
      hideLater();
    }
    function release(cancel = false) {
      if (!drag) return;
      const previous = drag;
      drag = null;
      velocity = 0;
      if (cancel) target = previous.start;
      updateValue();
      // Captured pointerleave does not reveal whether release occurred off the edge.
      hovered = previous.type !== "touch" && Math.abs(previous.pointer - position) < 16;
      if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
      scene.dataset.state = "settling";
      status.textContent = `Panel width ${handle.getAttribute("aria-valuenow")} percent`;
      show();
      hideLater();
    }
    handle.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") {
        hovered = true;
        show();
      }
    });
    handle.addEventListener("pointerleave", () => {
      hovered = false;
      hideLater();
    });
    handle.addEventListener("focus", () => {
      focused = true;
      show();
    });
    handle.addEventListener("blur", () => {
      focused = false;
      hideLater();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      const rect = scope.rect(scene);
      const pointer = scope.point(event).x - rect.left;
      drag = {
        id: event.pointerId,
        type: event.pointerType,
        start: target,
        offset: pointer - position,
        raw: position,
        pointer,
        speed: 0,
        time: performance.now(),
      };
      target = legal(position);
      velocity = 0;
      handle.setPointerCapture(event.pointerId);
      scene.dataset.state = "dragging";
      show();
    });
    window.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const rect = scope.rect(scene),
        now = performance.now();
      const pointer = scope.point(event).x - rect.left,
        raw = pointer - drag.offset;
      drag.speed = clamp((raw - drag.raw) / Math.max((now - drag.time) / 1000, 0.008), -2200, 2200);
      drag.raw = raw;
      drag.pointer = pointer;
      drag.time = now;
      target = legal(raw);
      position = reduced() ? target : rubber(raw);
      scene.dataset.state = "dragging";
      updateValue();
      draw();
      wake();
    });
    window.addEventListener("pointerup", (event) => {
      if (event.pointerId === drag?.id) release();
    });
    window.addEventListener("pointercancel", (event) => {
      if (event.pointerId === drag?.id) release(true);
    });
    handle.addEventListener("lostpointercapture", () => release());
    handle.addEventListener("dblclick", () => setTarget(initial * width));
    handle.addEventListener("keydown", (event) => {
      const step = (event.shiftKey ? 0.06 : 0.02) * width;
      const values = {
        ArrowLeft: target - step,
        ArrowRight: target + step,
        Home: min * width,
        End: max * width,
        Escape: drag ? drag.start : initial * width,
      };
      if (!(event.key in values)) return;
      event.preventDefault();
      if (event.key === "Escape" && drag) release(true);
      else setTarget(values[event.key]);
      status.textContent = `Panel width ${handle.getAttribute("aria-valuenow")} percent`;
    });
    const observer = new ResizeObserver(() => {
      const next = scope.rect(scene).width;
      if (!next || next === width) return;
      const ratio = next / width;
      position *= ratio;
      target *= ratio;
      velocity *= ratio;
      if (drag) {
        drag.raw *= ratio;
        drag.offset *= ratio;
        drag.pointer *= ratio;
        drag.start *= ratio;
      }
      width = next;
      draw();
    });
    observer.observe(scene);
    media.addEventListener("change", wake);
    scene.dataset.state = "idle";
    draw();
    document.body.dataset.motionReady = "true";
  })();

  scope.ready();
  return scope.controller;
}
