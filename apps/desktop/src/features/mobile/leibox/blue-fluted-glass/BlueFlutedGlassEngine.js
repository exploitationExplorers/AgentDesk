/* eslint-disable @typescript-eslint/no-unused-vars */
// Native DOM port of the preserved reference HTML. No iframe or runtime eval.
import { createSurface } from "./motion-runtime";
export function mountBlueFlutedGlass(target, options = {}) {
  const scope = createSurface(
    target,
    {
      markup:
        '\r\n<!-- Design reference: sasha birukoff, https://x.com/sashabirukoff/status/2113002960892649916/video/1\r\n     Independent procedural reconstruction; original source and its license were not supplied.\r\n     The centered LeiBox artwork is the site\'s existing outlined wordmark. -->\r\n<main class="bfg-stage" tabindex="0" role="button" aria-label="Pause background animation" aria-pressed="false" data-paused="false">\r\n<canvas class="bfg-canvas" aria-hidden="true"></canvas>\r\n<svg class="bfg-logo" xmlns="http://www.w3.org/2000/svg" width="603.900954" height="208" viewBox="0 0 603.900954 208" role="img" aria-label="LeiBox"><title>LeiBox</title><g fill="currentColor"><g transform="scale(0.499071) translate(-63.742 -47.613)"><path d="M212 59.403 A88 88 0 0 1 300 59.403 L404.258 119.597 A88 88 0 0 1 448.258 195.807 L448.258 316.193 A88 88 0 0 1 404.258 392.403 L300 452.597 A88 88 0 0 1 212 452.597 L107.742 392.403 A88 88 0 0 1 63.742 316.193 L63.742 195.807 A88 88 0 0 1 107.742 119.597 Z M247 273.618802154 L247 392.618802154 A27 27 0 0 0 287.5 416.001488056 L390.55702305 356.501488056 A27 27 0 0 0 363.55702305 309.736116252 L301 345.85343035 L301 273.618802154 A27 27 0 0 0 247 273.618802154 Z" fill-rule="evenodd"/></g><g transform="translate(235.900954 60)"><path d="M0 8 A8 8 0 0 1 16 8 V77 A7 7 0 0 0 23 84 H48 A8 8 0 0 1 48 100 H23 A23 23 0 0 1 0 77 Z" fill-rule="evenodd"/><path d="M123.944409 85.395136 A38 38 0 1 1 129.032923 47.27946 A8 8 0 0 1 114.282219 53.477582 A22 22 0 1 0 111.336237 75.544552 A8 8 0 0 1 123.944409 85.395136 Z" fill-rule="evenodd"/><path d="M75.097844 82.27721 L152.097844 44.27721 A7 7 0 0 0 145.902156 31.72279 L68.902156 69.72279 A7 7 0 0 0 75.097844 82.27721 Z" fill-rule="evenodd"/><path d="M142 38 A7 7 0 0 1 156 38 V100 H142 Z" fill-rule="evenodd"/><path d="M140 10 A10 10 0 1 1 160 10 A10 10 0 1 1 140 10 Z" fill-rule="evenodd"/><path d="M0 0 H33 C52 0 62 10 62 25 C62 36 55 43 47 46 C60 49 64 57 64 71 C64 90 53 100 33 100 H0 Z M16 15 H32 C42 15 47 20 47 28 C47 36 42 40 32 40 H16 Z M16 54 H32 C44 54 51 58 51 70 C51 81 43 85 32 85 H16 Z" fill-rule="evenodd" transform="translate(168 0)"/><path d="M236 62 A36 38 0 1 1 308 62 A36 38 0 1 1 236 62 Z M252 62 A20 22 0 1 1 292 62 A20 22 0 1 1 252 62 Z" fill-rule="evenodd"/><path d="M304 24 L322 24 L336 48 L350 24 L368 24 L345 62 L368 100 L350 100 L336 76 L322 100 L304 100 L327 62 Z" fill-rule="evenodd"/></g></g></svg>\r\n<span class="bfg-sr" aria-live="polite"></span>\r\n</main>\r\n\r\n',
      css: "\r\n*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#f4f4f4}\r\n.bfg-stage{position:relative;display:grid;place-items:center;width:100%;height:100vh;min-height:1px;overflow:hidden;isolation:isolate;background:#f4f4f4;outline:none;cursor:default}\r\n.bfg-stage:focus-visible{outline:3px solid #fff;outline-offset:-7px;box-shadow:inset 0 0 0 9px #0b3c69}\r\n.bfg-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;filter:blur(1.25px);transform:scale(1.008)}\r\n.bfg-logo{position:relative;display:block;width:22%;height:auto;color:#fff;pointer-events:none;filter:drop-shadow(0 1px 3px #00132e20)}\r\n.bfg-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}\r\n",
      width: 1200,
      height: 833,
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

  const stage = document.querySelector(".bfg-stage");
  const canvas = document.querySelector(".bfg-canvas");
  const status = document.querySelector(".bfg-sr");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
  });
  let program, buffer, timeLocation, sizeLocation;
  let frame = 0,
    last = 0,
    elapsed = 0,
    paused = false,
    visible = true,
    destroyed = false;
  const VERTEX = "attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}";
  const FRAGMENT = `
precision highp float;
uniform vec2 resolution;
uniform float time;
float blob(vec2 p,vec2 center,vec2 radius,float angle){
  p-=center;float c=cos(angle),s=sin(angle);
  p=mat2(c,-s,s,c)*p/radius;
  return exp(-dot(p,p));
}
vec3 fluid(vec2 p,float t){
  float s=sin(t),c=cos(t);
  p.x+=.025*sin(p.y*7.0+t*2.0);
  float trunk=blob(p,vec2(.52+.15*s-.07*sin(t*2.0),.76),vec2(.235,.46),-.12-.52*s);
  float crown=blob(p,vec2(.77-.55*s,.20-.10*sin(t*2.0)),vec2(.235,.23),-.50+.45*s);
  float baseY=1.045-.17*p.x+.075*sin(p.x*5.0+t*2.0);
  float base=exp(-pow((p.y-baseY)/.092,2.0));
  float hole=blob(p,vec2(.85-.55*s,.59-.13*s),vec2(.19+.025*c,.32),.1+.5*s);
  float density=(trunk+.56*crown+.90*base)*(1.0-.78*hole);
  vec3 color=mix(vec3(.957),vec3(.66,.80,.89),smoothstep(.015,.20,density));
  color=mix(color,vec3(.10,.48,.73),smoothstep(.16,.49,density));
  color=mix(color,vec3(.015,.135,.28),smoothstep(.40,.73,density));
  color=mix(color,vec3(.008,.025,.087),smoothstep(.62,.93,density));
  return color;
}
void main(){
  vec2 uv=vec2(gl_FragCoord.x/resolution.x,1.0-gl_FragCoord.y/resolution.y);
  // The lenses refract the fluid itself; they are not an opacity stripe overlay.
  float rib=fract(uv.x*71.0)-.5;
  vec2 refracted=uv+vec2(rib*.018,(rib*rib-.0833)*.034);
  float t=time*6.28318530718/28.0;
  vec3 color=fluid(refracted,t)*.40;
  color+=fluid(refracted+vec2(0.,.025),t)*.24;
  color+=fluid(refracted-vec2(0.,.025),t)*.24;
  color+=fluid(refracted+vec2(0.,.055),t)*.06;
  color+=fluid(refracted-vec2(0.,.055),t)*.06;
  float edge=pow(abs(rib)*2.0,10.0);
  float blue=(1.0-color.r)*smoothstep(.02,.18,color.b-color.r);
  color+=vec3(.018,.025,.03)*(rib*.65+edge*.24)*blue;
  gl_FragColor=vec4(clamp(color,0.0,1.0),1.0);
}`;
  function shader(type, source) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
      gl.deleteShader(value);
      return null;
    }
    return value;
  }
  function initialize() {
    if (!gl) return false;
    const vertex = shader(gl.VERTEX_SHADER, VERTEX),
      fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return false;
    }
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
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
    timeLocation = gl.getUniformLocation(program, "time");
    sizeLocation = gl.getUniformLocation(program, "resolution");
    return true;
  }
  if (!initialize()) {
    if (gl) {
      if (program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    gl = null;
    const fallback = canvas.cloneNode();
    canvas.replaceWith(fallback);
    // Keep a working static composition when WebGL is unavailable.
    const ctx = fallback.getContext("2d");
    fallback.width = 960;
    fallback.height = 666;
    ctx.fillStyle = "#f4f4f4";
    ctx.fillRect(0, 0, 960, 666);
    const gradient = ctx.createRadialGradient(525, 520, 20, 525, 520, 440);
    gradient.addColorStop(0, "#020820");
    gradient.addColorStop(0.45, "#073d69");
    gradient.addColorStop(0.7, "#378fbe");
    gradient.addColorStop(1, "#f4f4f4");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 960, 666);
    stage.dataset.renderer = "fallback";
  } else stage.dataset.renderer = "webgl";
  function render() {
    if (!gl || destroyed) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(sizeLocation, canvas.width, canvas.height);
    gl.uniform1f(timeLocation, elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    stage.dataset.time = elapsed.toFixed(3);
    document.body.dataset.motionReady = "true";
  }
  function reduced() {
    return typeof scope !== "undefined" ? scope.reduced() : media.matches;
  }
  function running() {
    return gl && !destroyed && !paused && !reduced() && visible && !document.hidden;
  }
  function tick(now) {
    frame = 0;
    if (!running()) {
      last = 0;
      stage.dataset.paused = String(paused || reduced());
      return;
    }
    if (last) elapsed += Math.min((now - last) / 1000, 0.05);
    last = now;
    render();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    if (!gl) {
      stage.dataset.paused = "true";
      stage.tabIndex = -1;
      stage.setAttribute("role", "img");
      stage.setAttribute("aria-label", "LeiBox on a static blue background");
      stage.removeAttribute("aria-pressed");
      return;
    }
    stage.dataset.paused = String(paused || reduced());
    stage.setAttribute("aria-pressed", String(paused));
    stage.setAttribute(
      "aria-label",
      paused ? "Resume background animation" : "Pause background animation",
    );
    render();
    if (running()) frame = requestAnimationFrame(tick);
  }
  function resize() {
    const bounds = scope.rect(stage),
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    canvas.height = Math.max(1, Math.round(bounds.height * dpr));
    sync();
  }
  function toggle() {
    paused = !paused;
    status.textContent = paused ? "Animation paused" : "Animation playing";
    sync();
  }
  stage.addEventListener("click", toggle);
  function keydown(event) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  }
  stage.addEventListener("keydown", keydown);
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    sync();
  });
  intersection.observe(stage);
  // Native package options can change independently of the system media query.
  const preferenceObserver = typeof scope !== "undefined" ? new MutationObserver(sync) : null;
  if (preferenceObserver)
    preferenceObserver.observe(scope.element, {
      attributes: true,
      attributeFilter: ["data-reduced-motion"],
    });
  function dispose() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersection.disconnect();
    preferenceObserver?.disconnect();
    stage.removeEventListener("click", toggle);
    stage.removeEventListener("keydown", keydown);
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    if (gl) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  window.addEventListener("pagehide", dispose, { once: true });
  if (typeof scope !== "undefined") scope.addCleanup(dispose);
  resize();
  document.body.dataset.motionReady = "true";

  scope.ready();
  return scope.controller;
}
