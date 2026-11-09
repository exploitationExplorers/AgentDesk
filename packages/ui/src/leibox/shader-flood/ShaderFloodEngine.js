// src/lib/motion-core/shader-flood.mjs
import { createSurface } from "./motion-runtime";

// src/lib/motion-core/shader-flood-renderer.mjs
var VERTEX = `attribute vec2 position;varying vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
var FRAGMENT = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 uv;
uniform vec2 size,origin;
uniform float progress,time,seed;
uniform vec3 low,mid,high;
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float n=0.,a=.533;mat2 m=mat2(.8,.6,-.6,.8);for(int i=0;i<4;i++){n+=a*noise(p);p=m*p*2.03+vec2(4.7,1.3);a*=.5;}return n;}
void main(){
 vec2 pixel=vec2(uv.x,1.-uv.y)*size;
 vec2 b=size*.5-1.,d=abs(pixel-size*.5)-b+28.;
 float rounded=length(max(d,0.))+min(max(d.x,d.y),0.)-28.;
 float radius=progress*1.5*length(size)*.70710678;
 float circle=length(pixel-origin*size)-radius;
 float alpha=(1.-smoothstep(-.65,.65,rounded))*(1.-smoothstep(-.65,.65,circle));
 if(alpha<.001)discard;
 vec2 p=(uv-.5)*vec2(size.x/size.y,1.)*2.4+vec2(seed*.173,seed*.097);
 float t=time*.15;
 vec2 q=vec2(fbm(p+vec2(t*.22,-t*.17)),fbm(p+vec2(5.2,1.3)+vec2(-t*.18,t*.23)))-.5;
 vec2 r=vec2(fbm(p+3.3*q+vec2(1.7,9.2)+t*.13),fbm(p+3.3*q+vec2(8.3,2.8)-t*.12))-.5;
 float field=fbm(p+3.0*r+1.0*q);
 float f=smoothstep(.17,.77,field);
 vec3 color=mix(low,mid,smoothstep(.05,.57,f));
 color=mix(color,high,pow(smoothstep(.72,.99,f),1.7)*.58);
 float slope=length(vec2(dFdx(field),dFdy(field)))*size.y*.17;
 float crease=(1.-smoothstep(.006,.034,abs(field-.43)))*.88;
 crease+=(1.-smoothstep(.003,.018,abs(field-.59)))*.24;
 color=mix(color,low*.28,min(crease,.94));
 color+=high*pow(max(0.,1.-slope*2.),8.)*.025;
 color*=mix(.24,1.12,smoothstep(-.08,1.,uv.y));
 gl_FragColor=vec4(color,alpha);
}`;
function createFloodRenderer(stage, { force2D = false, onLost } = {}) {
  const owner = stage.ownerDocument,
    canvas = owner.createElement("canvas");
  canvas.className = "sf-canvas";
  canvas.setAttribute("aria-hidden", "true");
  stage.prepend(canvas);
  let gl,
    program,
    buffer,
    locations,
    mode = "canvas2d",
    dead = false,
    ratio = 1;
  try {
    if (force2D) throw new Error("Software rendering requested");
    gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    if (!gl || !gl.getExtension("OES_standard_derivatives"))
      throw new Error("WebGL derivatives unavailable");
    const shaders = [];
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, FRAGMENT],
      ]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader));
      }
      program = gl.createProgram();
      shaders.forEach((shader) => gl.attachShader(program, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
    } finally {
      shaders.forEach((shader) => gl.deleteShader(shader));
    }
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    locations = Object.fromEntries(
      ["size", "origin", "progress", "time", "seed", "low", "mid", "high"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
    mode = "webgl";
  } catch {
    if (gl) {
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    const replacement = canvas.cloneNode();
    canvas.replaceWith(replacement);
    return createSoftwareRenderer(replacement);
  }
  const lost = (event) => {
    event.preventDefault();
    if (!dead) onLost?.();
  };
  canvas.addEventListener("webglcontextlost", lost);
  function resize(width, height, dpr) {
    ratio = dpr;
    const w = Math.max(1, Math.round(width * dpr)),
      h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  function draw(cards, time) {
    if (dead || gl.isContextLost()) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.enable(gl.SCISSOR_TEST);
    for (const card of cards) {
      if (card.progress <= 0) continue;
      const x = Math.round(card.x * ratio),
        y = canvas.height - Math.round((card.y + card.height) * ratio),
        w = Math.round(card.width * ratio),
        h = Math.round(card.height * ratio);
      gl.viewport(x, y, w, h);
      gl.scissor(x, y, w, h);
      gl.uniform2f(locations.size, card.width, card.height);
      gl.uniform2fv(locations.origin, card.origin);
      gl.uniform1f(locations.progress, card.progress);
      gl.uniform1f(locations.time, time);
      gl.uniform1f(locations.seed, card.seed);
      gl.uniform3fv(locations.low, card.colors[0]);
      gl.uniform3fv(locations.mid, card.colors[1]);
      gl.uniform3fv(locations.high, card.colors[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
  return {
    canvas,
    mode,
    resize,
    draw,
    destroy() {
      if (dead) return;
      dead = true;
      canvas.removeEventListener("webglcontextlost", lost);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
function createSoftwareRenderer(canvas) {
  const ctx = canvas.getContext("2d"),
    css = (rgb) => "rgb(" + rgb.map((c) => Math.round(c * 255)).join(",") + ")";
  let ratio = 1,
    dead = false;
  return {
    canvas,
    mode: "canvas2d",
    resize(w, h, dpr) {
      ratio = dpr;
      const width = Math.max(1, Math.round(w * dpr)),
        height = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    },
    draw(cards, time) {
      if (dead) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      for (const c of cards) {
        if (c.progress <= 0) continue;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.beginPath();
        ctx.roundRect(1, 1, c.width - 2, c.height - 2, 28);
        ctx.clip();
        ctx.beginPath();
        ctx.arc(
          c.origin[0] * c.width,
          c.origin[1] * c.height,
          (c.progress * 1.5 * Math.hypot(c.width, c.height)) / Math.SQRT2,
          0,
          Math.PI * 2,
        );
        ctx.clip();
        const fill = ctx.createLinearGradient(0, c.height, c.width * 0.25, 0);
        c.colors.forEach((color, i) => fill.addColorStop(i / 2, css(color)));
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, c.width, c.height);
        for (let i = 0; i < 24; i++) {
          const phase = i * 0.91 + c.seed * 0.39,
            timeShift = time * 0.18;
          ctx.beginPath();
          for (let j = 0; j <= 24; j++) {
            const x = (j / 24) * c.width,
              y =
                (i / 23) * c.height +
                Math.sin(j * 0.44 + phase + timeShift) * 24 +
                Math.sin(j * 0.95 - phase * 0.71 - timeShift) * 12;
            if (j) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.strokeStyle = i % 3 ? "#00000028" : "#ffffff33";
          ctx.lineWidth = i % 3 ? 3 : 8;
          ctx.stroke();
        }
        const shade = ctx.createLinearGradient(0, c.height * 0.35, 0, c.height);
        shade.addColorStop(0, "#0000");
        shade.addColorStop(1, "#0009");
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.restore();
      }
    },
    destroy() {
      dead = true;
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}

// src/lib/motion-core/shader-flood.mjs
function createShaderFlood(target, initial, CSS, MARKUP, DEFAULTS, PALETTES, ICONS) {
  const scope = createSurface(
    target,
    { css: CSS, markup: MARKUP, width: 1120, height: 720, responsive: true },
    initial,
  );
  const { root, on } = scope,
    scene = root.querySelector(".sf-scene"),
    stage = root.querySelector(".sf-stage"),
    grid = root.querySelector(".sf-grid");
  const owner = target.ownerDocument,
    browser = owner.defaultView,
    media = browser.matchMedia("(prefers-reduced-motion: reduce)");
  let options = { seed: 0, speed: 1, theme: "light", ...initial },
    items = [],
    cards = [],
    renderer,
    dead = false,
    visible = true,
    frame = 0,
    last = 0,
    lastPaint = 0,
    clock = 0,
    renderFrames = 0,
    pinned = -1,
    focused = -1,
    lastInput = "mouse",
    touchPoint = null,
    embeddedWidth = Infinity;
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  const reduced = () => options.reducedMotion ?? media.matches;
  const color = (s) => typeof s === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(s);
  const rgb = (s) => {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  function normalize() {
    options.seed = Number.isFinite(options.seed) ? options.seed : 0;
    options.speed = Number.isFinite(options.speed) ? clamp(options.speed, 0, 3) : 1;
  }
  function local(card, event) {
    const r = card.node.getBoundingClientRect();
    return [clamp((event.clientX - r.x) / r.width), clamp((event.clientY - r.y) / r.height)];
  }
  function stop() {
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    lastPaint = 0;
  }
  function rendererLost() {
    if (dead) return;
    renderer.destroy();
    renderer = createFloodRenderer(stage, { force2D: true });
    measure();
    paint();
    wake();
  }
  function measure() {
    const box = scope.rect(stage);
    for (const card of cards) {
      const rect = scope.rect(card.node);
      Object.assign(card, {
        x: rect.x - box.x,
        y: rect.y - box.y,
        width: rect.width,
        height: rect.height,
      });
    }
    const display = stage.getBoundingClientRect().width,
      ratio = Math.max(
        0.3,
        // 纹理使用 CSS 像素即可；文字仍由 DOM 按设备分辨率渲染。
        Math.min(1, (browser.devicePixelRatio || 1) * Math.min(1, embeddedWidth / display)),
      );
    renderer?.resize(stage.clientWidth, stage.clientHeight, ratio);
  }
  function paint() {
    if (dead) return;
    renderer.draw(cards, reduced() ? 0 : clock);
    scene.dataset.renderer = renderer.mode;
    scene.dataset.frame = String(++renderFrames);
    scene.dataset.ready = "true";
    for (const card of cards) {
      const progress = card.progress.toFixed(4);
      const origin = card.origin.map((n) => n.toFixed(4)).join(",");
      const state =
        card.progress === card.target
          ? card.target
            ? "active"
            : "idle"
          : card.target
            ? "entering"
            : "leaving";
      if (card.node.dataset.progress !== progress) card.node.dataset.progress = progress;
      if (card.node.dataset.origin !== origin) card.node.dataset.origin = origin;
      if (card.node.dataset.state !== state) card.node.dataset.state = state;
    }
  }
  function tick(now) {
    frame = 0;
    if (dead || !visible || owner.hidden) return;
    // 高刷新率屏幕限制昂贵的噪声绘制，进度仍按实际时间计算。
    if (lastPaint && now - lastPaint < 1000 / 60 - 1) {
      wake();
      return;
    }
    lastPaint = now;
    const dt = last ? Math.min((now - last) / 1e3, 0.08) : 0;
    last = now;
    clock += dt * options.speed;
    for (const card of cards) {
      if (card.progress !== card.target) {
        const p = clamp((now - card.started) / card.duration),
          ease = 1 - Math.pow(1 - p, 3);
        card.progress = p === 1 ? card.target : card.from + (card.target - card.from) * ease;
      }
    }
    paint();
    wake();
  }
  function wake() {
    if (
      !frame &&
      !dead &&
      visible &&
      !owner.hidden &&
      cards.some(
        (c) => c.progress !== c.target || (!reduced() && options.speed > 0 && c.progress > 0),
      )
    )
      frame = browser.requestAnimationFrame(tick);
  }
  function setCard(index, active, point = [0.5, 0.5]) {
    const card = cards[index];
    if (!card) return;
    card.origin = point;
    card.from = card.progress;
    card.target = active ? 1 : 0;
    card.started = browser.performance.now();
    card.duration = active ? 520 : 420;
    card.node.dataset.active = String(active);
    card.node.setAttribute("aria-pressed", String(active));
    if (reduced()) card.progress = card.target;
    paint();
    wake();
  }
  function closeAll() {
    pinned = -1;
    focused = -1;
    cards.forEach((c, i) => {
      if (c.target) setCard(i, false);
    });
  }
  function rebuild() {
    const incoming = Array.isArray(options.items) ? options.items : DEFAULTS;
    items = incoming.map((item, index) => ({
      title: String(item?.title ?? ""),
      description: String(item?.description ?? ""),
      icon: typeof item?.icon === "string" && ICONS[item.icon] ? item.icon : "layers",
      colors:
        Array.isArray(item?.colors) && item.colors.length === 3 && item.colors.every(color)
          ? item.colors
          : PALETTES[index % PALETTES.length],
    }));
    grid.replaceChildren();
    pinned = -1;
    focused = -1;
    cards = items.map((item, index) => {
      const node = owner.createElement("button");
      node.type = "button";
      node.className = "sf-card";
      node.dataset.index = String(index);
      node.dataset.active = "false";
      node.setAttribute("aria-pressed", "false");
      node.style.setProperty("--sf-accent", item.colors[1]);
      const icon = owner.createElement("span");
      icon.className = "sf-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = ICONS[item.icon];
      const content = owner.createElement("span");
      content.className = "sf-content";
      const title = owner.createElement("span");
      title.className = "sf-title";
      title.textContent = item.title;
      const description = owner.createElement("span");
      description.className = "sf-description";
      description.textContent = item.description;
      content.append(title, description);
      node.append(icon, content);
      grid.append(node);
      return {
        node,
        index,
        seed: options.seed + index * 7.31,
        colors: item.colors.map(rgb),
        origin: [0.5, 0.5],
        progress: 0,
        target: 0,
        from: 0,
        started: 0,
        duration: 520,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
    });
    measure();
    paint();
  }
  const cardFor = (event) => {
    const node = event.target.closest?.(".sf-card");
    return node && grid.contains(node) ? cards[Number(node.dataset.index)] : null;
  };
  on(grid, "pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const card = cardFor(event);
    if (!card || card.node.contains(event.relatedTarget)) return;
    lastInput = event.pointerType;
    setCard(card.index, true, local(card, event));
  });
  on(grid, "pointerout", (event) => {
    if (event.pointerType === "touch") return;
    const card = cardFor(event);
    if (
      !card ||
      card.node.contains(event.relatedTarget) ||
      card.index === pinned ||
      card.index === focused
    )
      return;
    setCard(card.index, false, local(card, event));
  });
  on(grid, "pointerdown", (event) => {
    lastInput = event.pointerType;
    const card = cardFor(event);
    touchPoint = card ? local(card, event) : null;
  });
  on(grid, "click", (event) => {
    const card = cardFor(event);
    if (!card) {
      closeAll();
      return;
    }
    if (event.pointerType === "touch" || lastInput === "touch") {
      const opening = pinned !== card.index;
      closeAll();
      if (opening) {
        pinned = card.index;
        setCard(card.index, true, touchPoint ?? [0.5, 0.5]);
      }
    } else if (event.detail === 0) {
      setCard(card.index, !card.target);
    }
  });
  on(grid, "focusin", (event) => {
    const card = cardFor(event);
    if (card && card.node.matches(":focus-visible")) {
      focused = card.index;
      setCard(card.index, true);
    }
  });
  on(grid, "focusout", (event) => {
    const card = cardFor(event);
    if (card && focused === card.index) {
      focused = -1;
      if (pinned !== card.index) setCard(card.index, false);
    }
  });
  on(grid, "keydown", (event) => {
    lastInput = "keyboard";
    touchPoint = null;
    const card = cardFor(event);
    if (event.key === "Escape") {
      event.preventDefault();
      closeAll();
      return;
    }
    if (!card) return;
    const directions = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
    let next;
    if (event.key in directions)
      next = (card.index + directions[event.key] + cards.length) % cards.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = cards.length - 1;
    if (next !== void 0) {
      event.preventDefault();
      lastInput = "keyboard";
      cards[next].node.focus();
    }
  });
  on(owner, "pointerdown", (event) => {
    if (!scope.element.contains(event.target)) closeAll();
  });
  on(scene, "click", (event) => {
    if (!event.target.closest?.(".sf-card")) closeAll();
  });
  on(owner, "visibilitychange", () => {
    if (owner.hidden) stop();
    else wake();
  });
  on(media, "change", () => {
    stop();
    if (reduced())
      cards.forEach((c) => {
        c.progress = c.target;
      });
    paint();
    wake();
  });
  on(browser, "message", (event) => {
    const d = event.data;
    if (
      event.source !== browser.parent ||
      d?.type !== "leibox-render-size" ||
      d.slug !== "shader-flood" ||
      !Number.isFinite(d.width) ||
      d.width <= 0
    )
      return;
    embeddedWidth = d.width;
    measure();
    paint();
  });
  normalize();
  renderer = createFloodRenderer(stage, { onLost: rendererLost });
  rebuild();
  const resize = new browser.ResizeObserver(() => {
    measure();
    paint();
  });
  resize.observe(stage);
  const intersection = new browser.IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) wake();
    else stop();
  });
  intersection.observe(scope.element);
  scene.dataset.theme = options.theme === "dark" ? "dark" : "light";
  if (color(options.background)) scene.style.setProperty("--sf-background", options.background);
  if (initial.preview && cards.length) {
    cards[0].progress = cards[0].target = cards[0].from = 1;
    cards[0].node.dataset.active = "true";
    cards[0].node.setAttribute("aria-pressed", "true");
    paint();
    wake();
  }
  scope.body.dataset.motionReady = "true";
  return {
    element: scope.element,
    root,
    update(next = {}) {
      if (dead) return;
      const itemsChanged = "items" in next && next.items !== options.items;
      options = { ...options, ...next };
      normalize();
      scope.controller.update(next);
      if (itemsChanged) rebuild();
      else cards.forEach((card, index) => (card.seed = options.seed + index * 7.31));
      scene.dataset.theme = options.theme === "dark" ? "dark" : "light";
      if ("background" in next) {
        if (color(next.background)) scene.style.setProperty("--sf-background", next.background);
        else scene.style.removeProperty("--sf-background");
      }
      if (reduced())
        cards.forEach((c) => {
          c.progress = c.target;
        });
      stop();
      measure();
      paint();
      wake();
    },
    destroy() {
      if (dead) return;
      dead = true;
      stop();
      resize.disconnect();
      intersection.disconnect();
      renderer.destroy();
      scope.controller.destroy();
      cards = [];
      items = [];
    },
  };
}

// src/lib/motion-core/shader-flood-entry.js
/*! Lucide icons: Copyright (c) 2022 Lucide Contributors. ISC license.
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
function mountShaderFlood(target, options = {}) {
  return createShaderFlood(
    target,
    options,
    '.sf-scene{position:relative;display:grid;align-items:center;width:100%;min-height:var(--motion-height,720px);padding:48px;background:var(--sf-background,#fff);color:#18181b;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;isolation:isolate}\r\n.sf-stage{position:relative;width:100%;max-width:1024px;margin:auto}.sf-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.sf-canvas{position:absolute;z-index:1;inset:0;display:block;width:100%;height:100%;pointer-events:none}\r\n.sf-card{position:relative;display:flex;flex-direction:column;align-items:flex-start;min-width:0;min-height:256px;overflow:hidden;border:1px solid #e4e4e7;border-radius:28px;padding:28px;background:#fafafa;color:inherit;font:inherit;text-align:left;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;touch-action:pan-y}\r\n.sf-card:focus-visible{outline:2px solid #71717a;outline-offset:4px}.sf-icon,.sf-content{position:relative;z-index:2;pointer-events:none}.sf-icon{display:grid;place-items:center;flex:none;width:48px;height:48px;border-radius:16px;background:#fff;box-shadow:0 1px 3px #0000000a,inset 0 0 0 1px #e4e4e7;color:var(--sf-accent)}.sf-icon svg{display:block;width:24px;height:24px;stroke-width:2}\r\n.sf-content{display:block;margin-top:auto;padding-top:40px}.sf-title{display:block;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.6px;transition:color .2s}.sf-description{display:block;margin-top:8px;font-size:15px;line-height:24px;font-weight:400;color:#71717a;transition:color .2s}.sf-card[data-active=true] .sf-title{color:#fff}.sf-card[data-active=true] .sf-description{color:#fffc}\r\n.sf-scene[data-theme=dark]{--sf-background:#09090b;color:#f4f4f5}.sf-scene[data-theme=dark] .sf-card{background:#18181b;border-color:#27272a}.sf-scene[data-theme=dark] .sf-description{color:#a1a1aa}.sf-scene[data-theme=dark] .sf-card[data-active=true] .sf-description{color:#fffc}\r\n@container sf-width (max-width:900px){.sf-scene{padding:24px}}\r\n@container sf-width (max-width:740px){.sf-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\r\n@container sf-width (max-width:570px){.sf-grid{grid-template-columns:1fr}.sf-scene{padding:24px}.sf-card{min-height:256px}}\r\n.sf-container{container-type:inline-size;container-name:sf-width}\r\n@media(prefers-reduced-motion:reduce){.sf-title,.sf-description{transition:none}}\r\n',
    '<div class="sf-container"><main class="sf-scene notranslate" translate="no" aria-label="Directional liquid feature cards"><div class="sf-stage"><div class="sf-grid" role="group" aria-label="Product features"></div></div></main></div>',
    [
      {
        title: "Instant deploys",
        description: "Push to main and it's live worldwide before the kettle boils.",
        icon: "rocket",
      },
      {
        title: "Edge functions",
        description: "Run code a few milliseconds from every visitor, not an ocean away.",
        icon: "zap",
      },
      {
        title: "Design tokens",
        description: "One source of colour, type and spacing that every surface reads from.",
        icon: "palette",
      },
      {
        title: "Global CDN",
        description: "Assets cached in hundreds of cities and purged in under a second.",
        icon: "globe",
      },
      {
        title: "Media pipeline",
        description: "Images and video resized, compressed and served in the right format.",
        icon: "aperture",
      },
      {
        title: "Preview links",
        description: "Every branch gets its own URL, so reviews happen on the real thing.",
        icon: "clapperboard",
        colors: ["#3a0a0a", "#ff4d3d", "#ffd2c2"],
      },
    ],
    [
      ["#0b2a5c", "#3b8cff", "#cfe4ff"],
      ["#2b0b40", "#a34dff", "#ead9ff"],
      ["#5a1670", "#ef5bd8", "#ffd1f3"],
      ["#003c34", "#19c7a0", "#c6fff0"],
      ["#4a2600", "#ffa22b", "#ffe9c9"],
    ],
    {
      rocket:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/></svg>',
      zap: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
      palette:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
      globe:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
      aperture:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></svg>',
      clapperboard:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></svg>',
      layers:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>',
    },
  );
}
export { mountShaderFlood };
