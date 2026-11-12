// LeiBox Pixel Day–Night Toggle — https://leibox.pantoria.cn/docs/animations/pixel-toggle
// LeiBox implementation; design reference: Zsolt Kacso, https://x.com/kaolti/status/2119151022014894260
// AgentDesk: add a transparent compact surface and a localized accessible label.
// src/lib/motion-core/pixel-toggle.mjs
import { createSurface } from "./motion-runtime";

// src/lib/motion-core/pixel-toggle-glass.mjs
var vertexShader = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;
var fragmentShader = `#version 300 es
precision highp float;
out vec4 color;
uniform vec2 resolution, sceneSize, trackHalf, knobCenter, knobHalf;
uniform float switchScale, theme, angle, impulse, gallery, compact;
uniform sampler2D glyph;

float roundedDistance(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

vec2 roundedNormal(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  vec2 n = max(q, 0.0);
  if (n.x + n.y < 0.001) n = q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  return normalize(n) * sign(p);
}

float ledDistance(vec2 p, float radius) {
  vec2 q = p - knobCenter;
  float offset = atan(q.y, q.x) - angle;
  float around = abs(atan(sin(offset), cos(offset)));
  float beyondTip = max(0.0, around - 0.92) * 122.0;
  float across = roundedDistance(q, knobHalf, radius) - 7.8;
  return length(vec2(beyondTip, across)) - 1.8;
}

vec3 illuminate(vec3 base, vec3 hue, float light) {
  vec3 add = base + hue * light;
  vec3 tint = mix(base, hue + 0.035, 1.0 - exp(-light * 1.18));
  return mix(add, tint, theme);
}

float mask(vec2 relative) {
  return texture(glyph, relative / 256.0 + 0.5).a;
}

float frostedMask(vec2 p, float haze) {
  float soft = (mask(p + vec2(4.0, 0.0)) + mask(p - vec2(4.0, 0.0))
              + mask(p + vec2(0.0, 4.0)) + mask(p - vec2(0.0, 4.0))) * 0.25;
  return mix(mask(p), soft, haze);
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y) / resolution;
  vec2 p = (uv - 0.5) * sceneSize / switchScale + trackHalf;
  vec2 onTrack = p - trackHalf;
  vec2 onKnob = p - knobCenter;
  float radius = min(69.0, min(knobHalf.x, knobHalf.y) - 1.0);
  vec3 hue = mix(vec3(0.435, 0.525, 1.0), vec3(1.0, 0.659, 0.180), theme);
  float strength = 1.0 + 0.38 * impulse;
  float led = ledDistance(p, radius);
  float distanceToLight = max(led, 0.0);
  float spill = (0.43 * exp(-distanceToLight / 21.0) + 0.33 * exp(-distanceToLight / 85.0)) * strength;
  float track = roundedDistance(onTrack, trackHalf, 86.0);
  float shadow = 1.0 - smoothstep(-10.0, 42.0, roundedDistance(onTrack - vec2(0.0, 17.0), trackHalf, 86.0));
  shadow *= mix(0.48, 0.17, theme);
  vec2 fromSky = (uv - vec2(0.92, -0.08)) / vec2(1.40, 1.55);
  float gradient = smoothstep(0.0, 0.84, length(fromSky));
  vec3 sky = mix(vec3(0.129, 0.129, 0.137), vec3(0.925, 0.925, 0.918), theme);
  vec3 base = mix(vec3(0.051, 0.051, 0.055), vec3(0.804, 0.804, 0.800), theme);
  vec3 background = mix(mix(sky, base, gradient), vec3(0.957), gallery);
  float sceneLight = max(0.0, spill - 0.016) * mix(0.94, 0.66, max(theme, gallery));
  background *= 1.0 - shadow;
  vec3 outside = gallery > 0.5
    ? mix(background, hue, 1.0 - exp(-sceneLight))
    : illuminate(background, hue, sceneLight);

  vec3 surface = outside;
  if (track < 0.65) {
    float floorY = onTrack.y / trackHalf.y;
    float trackWall = smoothstep(-19.0, 0.0, roundedDistance(onTrack - vec2(0.0, 8.0), trackHalf, 86.0));
    vec3 floorColor = vec3(mix(0.035, 0.903, theme) + floorY * mix(0.009, 0.005, theme) - trackWall * mix(0.025, 0.11, theme));
    floorColor = illuminate(floorColor, hue, spill * 0.56);
    float knobShadow = 1.0 - smoothstep(-8.0, 25.0, roundedDistance(onKnob - vec2(0.0, 11.0), knobHalf, radius));
    floorColor *= 1.0 - knobShadow * mix(0.52, 0.14, theme);
    float rim = 1.0 - smoothstep(0.0, 1.5, abs(track + 0.8));
    floorColor += rim * mix(0.047 + floorY * 0.022, floorY * 0.06, theme);
    surface = mix(outside, floorColor, 1.0 - smoothstep(-0.65, 0.65, track));
  }

  float knob = roundedDistance(onKnob, knobHalf, radius);
  if (knob < 1.0) {
    float depth = max(-knob, 0.0);
    vec2 normal = roundedNormal(onKnob, knobHalf, radius);
    float bevel = pow(1.0 - clamp(depth / 31.0, 0.0, 1.0), 2.6);
    vec2 throughGlass = onKnob * 0.945 - normal * bevel * 47.0;
    vec2 fringe = normal * bevel * 3.8 + onKnob * 0.004;
    float haze = 0.06 + 0.74 * bevel;
    vec3 pixels = vec3(frostedMask(throughGlass - fringe, haze),
                       frostedMask(throughGlass, haze),
                       frostedMask(throughGlass + fringe, haze));

    float height = onKnob.y / knobHalf.y * 0.5 + 0.5;
    vec3 glass = mix(vec3(0.17 - height * 0.065), vec3(0.956 - height * 0.014), theme);
    vec3 ink = mix(vec3(1.0, 0.956, 0.906), vec3(0.145, 0.134, 0.123), theme);
    glass = mix(glass, ink, pixels);
    glass += vec3(1.0, 0.80, 0.58) * frostedMask(throughGlass, 1.0) * 0.13 * (1.0 - theme);
    float internal = (exp(-distanceToLight / 28.0) * 0.79 + exp(-distanceToLight / 73.0) * 0.22) * strength;
    float bevelLight = exp(-depth / 2.8) * exp(-distanceToLight / 47.0);
    glass = illuminate(glass, hue, internal * mix(1.25, 1.08, theme) + bevelLight * mix(0.94, 0.62, theme));
    float topReflection = max(0.0, dot(normal, normalize(vec2(-0.35, -1.0))));
    glass += topReflection * topReflection * exp(-depth / 1.55) * mix(0.48, 0.66, theme);
    glass += topReflection * bevel * mix(0.06, 0.12, theme);
    glass -= max(0.0, -normal.y) * bevel * mix(0.035, 0.016, theme);
    surface = mix(surface, glass, 1.0 - smoothstep(-0.7, 0.7, knob));
  }

  float nearLed = exp(-distanceToLight / 5.5) * 0.36;
  surface = illuminate(surface, hue, nearLed * strength);
  surface = mix(surface, mix(hue, vec3(1.0), mix(0.68, 0.4, theme)), 1.0 - smoothstep(-0.6, 0.6, led));
  float grain = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  surface += grain * 0.021 * mix(1.0, 0.0, gallery * smoothstep(130.0, 240.0, max(track, distanceToLight)));
  float opacity = compact > 0.5 ? max(1.0 - smoothstep(-0.65, 1.0, track), min(spill * 0.5, 0.6)) : 1.0;
  color = vec4(clamp(surface, 0.0, 1.0) * opacity, opacity);
}`;
function compile(gl, kind, source) {
  const shader = gl.createShader(kind);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}
function createGlassRenderer(canvas, { width, height, scale, dpr, gallery, compact }) {
  const document = canvas.ownerDocument;
  const mask = document.createElement("canvas");
  mask.width = mask.height = 256;
  const ctx = mask.getContext("2d");
  const gl =
    ctx &&
    canvas.getContext("webgl2", { alpha: compact, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentShader);
  const program = gl.createProgram();
  if (program && vertex && fragment) {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
  }
  if (vertex) gl.deleteShader(vertex);
  if (fragment) gl.deleteShader(fragment);
  if (!program || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (program) gl.deleteProgram(program);
    return null;
  }
  const glyph = gl.createTexture();
  if (!glyph) {
    gl.deleteProgram(program);
    return null;
  }
  const names = [
    "resolution",
    "sceneSize",
    "trackHalf",
    "knobCenter",
    "knobHalf",
    "switchScale",
    "theme",
    "angle",
    "impulse",
    "gallery",
    "compact",
    "glyph",
  ];
  const uniform = Object.fromEntries(
    names.map((name) => [name, gl.getUniformLocation(program, name)]),
  );
  gl.useProgram(program);
  gl.uniform2f(uniform.trackHalf, width / 2, height / 2);
  gl.uniform1f(uniform.switchScale, scale);
  gl.uniform1f(uniform.gallery, Number(gallery));
  gl.uniform1f(uniform.compact, Number(compact));
  gl.uniform1i(uniform.glyph, 0);
  gl.bindTexture(gl.TEXTURE_2D, glyph);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return {
    resize(sceneWidth, sceneHeight) {
      // 工具栏按实际显示尺寸采样，保留双倍精度，避免渲染整张演示画布。
      const displayScale = compact
        ? Math.min(1, (canvas.getBoundingClientRect().width / sceneWidth) * 2)
        : 1;
      const ratio = Math.min(dpr * displayScale, Math.sqrt(12e5 / (sceneWidth * sceneHeight)));
      canvas.width = Math.max(1, Math.round(sceneWidth * ratio));
      canvas.height = Math.max(1, Math.round(sceneHeight * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniform.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniform.sceneSize, sceneWidth, sceneHeight);
    },
    draw(box, theme, phase, impulse, particles, scatter) {
      ctx.clearRect(0, 0, 256, 256);
      particles.draw(ctx, { x: 128, y: 128 }, theme, scatter, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.uniform2f(uniform.knobCenter, box.x + box.width / 2, box.y + box.height / 2);
      gl.uniform2f(uniform.knobHalf, box.width / 2, box.height / 2);
      gl.uniform1f(uniform.theme, theme);
      gl.uniform1f(uniform.angle, Math.PI / 2 - (phase % 1) * Math.PI * 2);
      gl.uniform1f(uniform.impulse, impulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteTexture(glyph);
      gl.deleteProgram(program);
      if (!gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// src/lib/motion-core/pixel-toggle-paint.mjs
var TRACK_WIDTH = 520;
var TRACK_HEIGHT = 272;
var KNOB_SIZE = 240;
var INSET = 16;
var TRAVEL = 248;
var MARGIN = 140;
var SWITCH_SCALE = 0.83;
var RADIUS = 69;
var TURN = Math.PI * 2;
var clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
var mix = (from, to, fraction) => from + (to - from) * fraction;
var wrap = (value, period) => ((value % period) + period) % period;
var parseColor = (color) => color.match(/../g).map((channel) => parseInt(channel, 16));
var blend = (a, b, time) => a.map((channel, index) => Math.round(mix(channel, b[index], time)));
var rgba = (color, alpha2 = 1) => `rgba(${color.join(",")},${alpha2})`;
var palette = {
  background: ["0d0d0e", "cdcdcc"],
  halo: ["212123", "ececea"],
  focus: ["d6d6ff", "5d3609"],
  "track-top": ["09090a", "dededd"],
  "track-bottom": ["0d0d0e", "ebebea"],
  "track-inset": ["000000", "bdbdba"],
  "track-light": ["1a1a1d", "ffffff"],
  "track-edge": ["242426", "f3f3f2"],
  "track-shadow": ["000000", "9d9b96"],
  "knob-top": ["53535b", "ffffff"],
  "knob-bottom": ["282831", "eeede9"],
  "knob-rim": ["ffffff", "ffffff"],
  "knob-shadow": ["000000", "7c7b77"],
};
var alpha = {
  "knob-top": [0.5, 0.94],
  "knob-bottom": [0.42, 0.88],
  "knob-rim": [0.27, 0.62],
  "knob-shadow": [0.44, 0.35],
};
var sceneColors = Object.entries(palette).map(([name, colors]) => ({
  name,
  night: parseColor(colors[0]),
  day: parseColor(colors[1]),
}));
var moonLight = [111, 134, 255];
var sunLight = [255, 168, 46];
function makeMoon() {
  const pixels = [];
  for (let row = -8; row <= 8; row++) {
    for (let col = -8; col <= 8; col++) {
      if (Math.hypot(col, row) > 6.6) continue;
      const cut = Math.hypot(col - 3.3, row + 2.4);
      if (cut > 5.4) pixels.push([col, row, 1]);
      else if ((col + row) % 2 === 0) pixels.push([col, row, 0.15]);
    }
  }
  return pixels.concat([
    [7, -7, 1],
    [6, -7, 0.45],
    [8, -7, 0.45],
    [7, -8, 0.45],
    [7, -6, 0.45],
  ]);
}
function makeSun() {
  const pixels = [];
  for (let row = -3; row <= 3; row++) {
    for (let col = -3; col <= 3; col++) {
      if (Math.hypot(col, row) <= 3.7) pixels.push([col, row, 1]);
    }
  }
  for (let ray = 0; ray < 8; ray++) {
    const angle = (ray * Math.PI) / 4;
    const distances = ray % 2 ? [5.9, 7.2] : [5.6, 6.6, 7.6];
    distances.forEach((distance) => {
      pixels.push([
        Math.round(Math.cos(angle) * distance),
        Math.round(Math.sin(angle) * distance),
        1,
      ]);
    });
  }
  return pixels;
}
var glyphs = [
  { pixels: makeMoon(), size: 6.85 },
  { pixels: makeSun(), size: 6.85 },
];
var particleCount = Math.max(...glyphs.map((glyph) => glyph.pixels.length)) + 20;
function createPixelParticles() {
  let glyph = 0;
  const dots = Array.from({ length: particleCount }, () => {
    const angle = Math.random() * TURN;
    const distance = Math.sqrt(Math.random()) * 74;
    return {
      scatterX: Math.cos(angle) * distance,
      scatterY: Math.sin(angle) * distance * 0.85,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      tx: 0,
      ty: 0,
      opacity: 0,
      targetOpacity: 0,
      phase: Math.random() * TURN,
    };
  });
  function assign(index, immediate) {
    glyph = index;
    const { pixels, size } = glyphs[index];
    const targets = [...pixels];
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [targets[i], targets[j]] = [targets[j], targets[i]];
    }
    dots.forEach((dot, i) => {
      const target = targets[i];
      dot.tx = target ? target[0] * size : dot.scatterX;
      dot.ty = target ? target[1] * size : dot.scatterY;
      dot.targetOpacity = target?.[2] ?? 0;
      if (immediate) {
        dot.x = dot.tx;
        dot.y = dot.ty;
        dot.opacity = dot.targetOpacity;
        dot.vx = dot.vy = 0;
      }
    });
  }
  function burst(strength) {
    for (const dot of dots) {
      const angle = Math.random() * TURN;
      const speed = (60 + Math.random() * 200) * strength;
      dot.vx += Math.cos(angle) * speed;
      dot.vy += Math.sin(angle) * speed;
    }
  }
  function advance(theme, agitation, pointer, center, dt) {
    const nextGlyph = theme > 0.5 ? 1 : 0;
    if (nextGlyph !== glyph) assign(nextGlyph, false);
    const scatter = Math.max(agitation, clamp(1 - Math.abs(2 * theme - 1) * 1.6));
    let moving = false;
    for (const dot of dots) {
      dot.phase += dt * 2;
      const tx = mix(dot.tx, dot.scatterX, scatter) + Math.sin(dot.phase) * scatter * 6;
      const ty = mix(dot.ty, dot.scatterY, scatter) + Math.cos(dot.phase * 0.82) * scatter * 6;
      dot.vx += ((tx - dot.x) * 340 - dot.vx * 27) * dt;
      dot.vy += ((ty - dot.y) * 340 - dot.vy * 27) * dt;
      if (pointer) {
        const dx = dot.x - (pointer.x - center.x),
          dy = dot.y - (pointer.y - center.y);
        const distance = Math.hypot(dx, dy);
        if (distance > 0 && distance < 49) {
          const force = ((1 - (distance / 49) ** 2) * 2800 * dt) / distance;
          dot.vx += dx * force;
          dot.vy += dy * force;
        }
      }
      dot.x += dot.vx * dt;
      dot.y += dot.vy * dt;
      const opacity = Math.max(dot.targetOpacity * (1 - scatter * 0.25), scatter * 0.55);
      dot.opacity = mix(dot.opacity, opacity, Math.min(1, dt * (opacity > dot.opacity ? 9 : 12)));
      if (!moving)
        moving =
          Math.abs(tx - dot.x) + Math.abs(ty - dot.y) > 0.15 ||
          Math.abs(dot.vx) + Math.abs(dot.vy) > 0.8 ||
          Math.abs(opacity - dot.opacity) > 5e-3;
    }
    return { scatter, moving };
  }
  function draw(ctx, center, theme, scatter, mask = false) {
    const { size } = glyphs[glyph];
    const color = mask ? [255, 255, 255] : blend([255, 245, 233], [37, 34, 31], theme);
    if (!mask) ctx.shadowColor = "#fff0d9";
    for (const dot of dots) {
      if (dot.opacity < 0.02) continue;
      const speed = clamp(Math.hypot(dot.vx, dot.vy) / 420);
      const height = size * 0.82 * (1 - speed * 0.35) * (1 - scatter * 0.35);
      if (!mask) ctx.shadowBlur = dot.targetOpacity > 0.9 ? Math.max(0, (1 - 2 * theme) * 4) : 0;
      ctx.fillStyle = rgba(color, dot.opacity * (1 - speed * 0.2));
      ctx.fillRect(center.x + dot.x - height / 2, center.y + dot.y - height / 2, height, height);
    }
  }
  return { assign, advance, draw, burst };
}
function roundedOutline({ x, y, width, height }, radius) {
  const right = x + width,
    bottom = y + height,
    cx = x + width / 2,
    cy = y + height / 2;
  const r = Math.min(radius, width / 2, height / 2);
  const corner = (Math.PI * r) / 2;
  const horizontal = width - 2 * r,
    vertical = height - 2 * r;
  const perimeter = 2 * (horizontal + vertical) + 4 * corner;
  const quarter = horizontal / 2 + corner + vertical / 2;
  const opposite = horizontal + 2 * corner + vertical;
  const segments = [];
  let end = 0;
  const line = (sx, sy, tx, ty) => {
    const length = Math.hypot(tx - sx, ty - sy);
    if (length) {
      end += length;
      segments.push({ end, length, point: (t) => [mix(sx, tx, t), mix(sy, ty, t)] });
    }
  };
  const curve = (ox, oy, start) => {
    end += corner;
    segments.push({
      end,
      length: corner,
      point: (t) => {
        const angle = start + (t * Math.PI) / 2;
        return [ox + Math.cos(angle) * r, oy + Math.sin(angle) * r];
      },
    });
  };
  line(cx, y, right - r, y);
  curve(right - r, y + r, -Math.PI / 2);
  line(right, y + r, right, bottom - r);
  curve(right - r, bottom - r, 0);
  line(right - r, bottom, x + r, bottom);
  curve(x + r, bottom - r, Math.PI / 2);
  line(x, bottom - r, x, y + r);
  curve(x + r, y + r, Math.PI);
  line(x + r, y, cx, y);
  const point = (distance) => {
    const at = wrap(distance, perimeter);
    const segment = segments.find((item) => at <= item.end) ?? segments.at(-1);
    return segment.point(1 - (segment.end - at) / segment.length);
  };
  const phaseDistance = (phase) => {
    const turn = wrap(phase, 1) * 4;
    const side = Math.floor(turn);
    const sides = [opposite, quarter, 0, quarter + opposite, opposite];
    return mix(side === 2 ? perimeter : sides[side], sides[side + 1], turn - side);
  };
  return { point, phaseDistance, perimeter, center: { x: cx, y: cy } };
}
function sampleRibbon(outline, distance, length) {
  return Array.from({ length: 49 }, (_, i) => {
    const fraction = i / 48;
    const at = distance + (fraction - 0.5) * length;
    const [x, y] = outline.point(at);
    const [ax, ay] = outline.point(at - 1);
    const [bx, by] = outline.point(at + 1);
    const span = Math.hypot(bx - ax, by - ay) || 1;
    return {
      x,
      y,
      nx: (by - ay) / span,
      ny: (ax - bx) / span,
      taper: Math.sin(Math.PI * fraction),
    };
  });
}
function paintRibbon(ctx, samples, { width, exponent, offset = 0, color, opacity = 1, blur = 0 }) {
  const shape = new Path2D();
  const outline = (point, side) => {
    const spread = offset + ((side * width) / 2) * point.taper ** exponent;
    return [point.x + point.nx * spread, point.y + point.ny * spread];
  };
  shape.moveTo(...outline(samples[0], 1));
  for (const sample of samples) shape.lineTo(...outline(sample, 1));
  for (let i = samples.length - 1; i >= 0; i--) shape.lineTo(...outline(samples[i], -1));
  shape.closePath();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = rgba(color);
  if (blur && "filter" in ctx) ctx.filter = `blur(${blur}px)`;
  else if (blur) {
    ctx.shadowBlur = blur * 2;
    ctx.shadowColor = ctx.fillStyle;
  }
  ctx.fill(shape);
  ctx.restore();
}
function createPixelPainter(scene, knob, canvas, dpr, scope) {
  const ctx = canvas.getContext("2d");
  canvas.width = Math.round((TRACK_WIDTH + 2 * MARGIN) * dpr);
  canvas.height = Math.round((TRACK_HEIGHT + 2 * MARGIN) * dpr);
  let previousTheme;
  const glassCanvas = scene.ownerDocument.createElement("canvas");
  scene.style.setProperty("--pixel-switch-scale", SWITCH_SCALE);
  const glass = createGlassRenderer(glassCanvas, {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    scale: SWITCH_SCALE,
    dpr,
    gallery: scene.hasAttribute("data-preview"),
    compact: scene.hasAttribute("data-compact"),
  });
  let usingGlass = Boolean(glass);
  let lastFrame;
  if (glass) {
    glassCanvas.className = "pixel-glass";
    glassCanvas.setAttribute("aria-hidden", "true");
    scene.prepend(glassCanvas);
    canvas.hidden = true;
    scene.dataset.glassRenderer = "";
    glass.resize(scene.clientWidth || 720, scene.clientHeight || 540);
    const resize = new scope.ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!usingGlass || !width || !height) return;
      glass.resize(width, height);
      if (lastFrame) paint(...lastFrame);
    });
    resize.observe(scene);
    if (scene.hasAttribute("data-compact")) {
      const surfaceResize = new scope.ResizeObserver(() => {
        if (!usingGlass) return;
        glass.resize(scene.clientWidth, scene.clientHeight);
        if (lastFrame) paint(...lastFrame);
      });
      surfaceResize.observe(scope.element);
    }
    scope.on(glassCanvas, "webglcontextlost", () => {
      usingGlass = false;
      resize.disconnect();
      delete scene.dataset.glassRenderer;
      glassCanvas.hidden = true;
      canvas.hidden = false;
      if (lastFrame) paint(...lastFrame);
      lastFrame = void 0;
    });
    scope.addCleanup(() => glass.destroy());
  }
  function paint(box, theme, phase, transit, dots, scatter) {
    if (theme !== previousTheme) {
      for (const { name, night: night2, day } of sceneColors) {
        const opacity = alpha[name];
        scene.style.setProperty(
          `--${name}`,
          rgba(blend(night2, day, theme), opacity ? mix(...opacity, theme) : 1),
        );
      }
      previousTheme = theme;
    }
    Object.assign(knob.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    if (usingGlass) {
      lastFrame = [box, theme, phase, transit, dots, scatter];
      glass.draw(box, theme, phase, transit, dots, scatter);
      return;
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, dpr * MARGIN, dpr * MARGIN);
    ctx.clearRect(-MARGIN, -MARGIN, TRACK_WIDTH + 2 * MARGIN, TRACK_HEIGHT + 2 * MARGIN);
    const padding = 8;
    const outside = roundedOutline(
      {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + 2 * padding,
        height: box.height + 2 * padding,
      },
      RADIUS + padding,
    );
    const inside = roundedOutline(box, RADIUS);
    const arcFraction = mix(0.31, 0.33, theme) * (1 - 0.12 * Math.sin(TURN * wrap(phase, 0.5)));
    const outer = sampleRibbon(
      outside,
      outside.phaseDistance(phase),
      outside.perimeter * arcFraction,
    );
    const inner = sampleRibbon(
      inside,
      inside.phaseDistance(phase),
      inside.perimeter * arcFraction * 1.25,
    );
    const wash = blend(moonLight, sunLight, theme);
    const bright = blend(wash, [255, 255, 255], 0.72);
    const body = blend(wash, bright, 0.48);
    const night = theme < 0.55;
    ctx.globalCompositeOperation = night ? "lighter" : "source-over";
    paintRibbon(ctx, outer, {
      width: 64,
      exponent: 0.5,
      offset: 16,
      color: wash,
      blur: 25,
      opacity: mix(0.86, 0.54, theme),
    });
    paintRibbon(ctx, outer, {
      width: 18,
      exponent: 0.6,
      offset: 4,
      color: wash,
      blur: 8,
      opacity: 0.74,
    });
    paintRibbon(ctx, outer, { width: 9, exponent: 0.75, color: body, blur: 2, opacity: 0.94 });
    paintRibbon(ctx, outer, { width: 3.5, exponent: 0.6, color: bright, blur: 0.35 });
    ctx.globalCompositeOperation = "source-over";
    const clip = new Path2D();
    clip.roundRect(box.x, box.y, box.width, box.height, RADIUS);
    ctx.save();
    ctx.clip(clip);
    const edge = inner[24];
    const depth = KNOB_SIZE * mix(0.57, 0.7, theme) * (1 + transit * 0.3);
    ctx.save();
    ctx.translate(edge.x, edge.y);
    ctx.rotate(Math.atan2(edge.nx, -edge.ny));
    ctx.scale(KNOB_SIZE * 0.84, depth * 0.62);
    const oriented = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    oriented.addColorStop(0, rgba(bright, mix(0.91, 0.84, theme)));
    oriented.addColorStop(0.23, rgba(wash, mix(0.9, 0.52, theme)));
    oriented.addColorStop(0.56, rgba(wash, mix(0.46, 0.23, theme)));
    oriented.addColorStop(1, rgba(wash, 0));
    ctx.fillStyle = oriented;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
    paintRibbon(ctx, inner, {
      width: 22,
      exponent: 0.5,
      color: night ? bright : body,
      blur: 8,
      opacity: 0.76 - transit * 0.35,
    });
    paintRibbon(ctx, inner, { width: 8, exponent: 0.6, color: bright, blur: 2, opacity: 0.92 });
    dots.draw(ctx, inside.center, theme, scatter);
    ctx.restore();
  }
  return paint;
}
function knobGeometry(position, stretch, press) {
  const overshoot = Math.max(-position, position - 1, 0);
  const impact = Math.min(0.16, overshoot * 1.12);
  const squeeze = 1 - press * 0.055;
  const width = KNOB_SIZE * clamp((1 + stretch - impact) * squeeze, 0.82, 1.19);
  const height = KNOB_SIZE * clamp((1 - stretch * 0.45 + impact * 0.42) * squeeze, 0.85, 1.08);
  const center = INSET + KNOB_SIZE / 2 + clamp(position) * TRAVEL;
  const x =
    position > 1
      ? TRACK_WIDTH - INSET - width
      : position < 0
        ? INSET
        : clamp(center - width / 2, INSET, TRACK_WIDTH - INSET - width);
  return { x, y: (TRACK_HEIGHT - height) / 2, width, height };
}

// src/lib/motion-core/pixel-toggle.mjs
var DAY_ANGLE = 0.5;
var SLIDE_STIFFNESS = 224;
var SLIDE_DAMPING = 15.5;
var SHAPE_STIFFNESS = 420;
var SHAPE_DAMPING = 24;
var restAngle = (checked) => (checked ? DAY_ANGLE : 0);
var smooth = (progress) => progress * progress * (3 - 2 * progress);
var easeOut = (progress) => 1 - (1 - progress) ** 3;
function createPixelToggle(host, initial, css2, preview = false) {
  const scope = createSurface(
    host,
    {
      width: initial.compact ? 600 : 720,
      height: initial.compact ? 320 : 540,
      css:
        css2 +
        (initial.compact
          ? ".pixel-scene { background: transparent; } .pixel-switch { pointer-events: auto; }"
          : ""),
      markup: `<div class="pixel-scene"><button class="pixel-switch" type="button" role="switch" aria-label="Day mode"><span class="pixel-knob" aria-hidden="true"></span><canvas class="pixel-effects" aria-hidden="true"></canvas></button></div>`,
    },
    initial,
  );
  const { root, on, requestAnimationFrame, cancelAnimationFrame, reduced } = scope;
  const scene = root.querySelector(".pixel-scene");
  const control = root.querySelector(".pixel-switch");
  const owner = host.ownerDocument;
  const browser = owner.defaultView;
  if (initial.compact) scene.dataset.compact = "";
  control.setAttribute("aria-label", initial.label || "Day mode");
  if (preview) scene.dataset.preview = "";
  const pixelRatio = Math.min(preview ? 1 : 1.5, browser.devicePixelRatio || 1);
  const paint = createPixelPainter(
    scene,
    root.querySelector(".pixel-knob"),
    root.querySelector("canvas"),
    pixelRatio,
    scope,
  );
  const particles = createPixelParticles();
  let options = { sound: true, ...initial };
  let checked = Boolean(options.checked);
  let position = Number(checked),
    theme = position,
    phase = restAngle(checked);
  let speed = 0,
    stretch = 0,
    stretchSpeed = 0,
    press = 0,
    agitation = 0;
  let colorMove, lightMove, drag, pointer;
  let frame = 0,
    lastTime = 0,
    audio,
    suppressClick = false,
    destroyed = false;
  function render(box = knobGeometry(position, stretch, press), scatter = 0, transit = 0) {
    paint(box, clamp(theme), phase, transit, particles, scatter);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }
  function snap() {
    stop();
    position = theme = Number(checked);
    phase = restAngle(checked);
    speed = stretch = stretchSpeed = press = agitation = 0;
    colorMove = lightMove = void 0;
    particles.assign(position, true);
    render();
  }
  function requestFrame() {
    if (!frame && !owner.hidden && !reduced()) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = 0;
    const dt = lastTime ? clamp((now - lastTime) / 1e3, 1e-3, 0.033) : 1 / 60;
    lastTime = now;
    const substep = dt / 4;
    let transit = 0;
    if (drag?.active) {
      const positionTheme = 1 / (1 + Math.exp(-(position - 0.5) / 0.07));
      theme = mix(theme, positionTheme, 1 - Math.exp(-dt * 14));
      phase = mix(phase, drag.base + clamp(position) * DAY_ANGLE, 1 - Math.exp(-dt * 18));
      speed *= Math.exp(-dt * 16);
      transit = 0.5;
    } else {
      if (colorMove) {
        const p = clamp((now - colorMove.start) / colorMove.duration);
        theme = mix(colorMove.from, Number(checked), smooth(p));
        if (p === 1) colorMove = void 0;
      }
      if (lightMove) {
        const p = clamp((now - lightMove.start) / lightMove.duration);
        phase = mix(lightMove.from, lightMove.to, easeOut(p));
        transit = Math.min(1, p * 8) * (1 - p) ** 2.2;
        if (p === 1) lightMove = void 0;
      }
      for (let i = 0; i < 4; i++) {
        speed += ((Number(checked) - position) * SLIDE_STIFFNESS - speed * SLIDE_DAMPING) * substep;
        position += speed * substep;
      }
      if (Math.abs(position - Number(checked)) < 1e-4 && Math.abs(speed) < 1e-3) {
        position = Number(checked);
        speed = 0;
      }
    }
    const stretchGoal = Math.min(0.18, Math.abs(speed) * 0.024);
    for (let i = 0; i < 4; i++) {
      stretchSpeed +=
        ((stretchGoal - stretch) * SHAPE_STIFFNESS - stretchSpeed * SHAPE_DAMPING) * substep;
      stretch += stretchSpeed * substep;
    }
    if (!stretchGoal && Math.abs(stretch) < 1e-4 && Math.abs(stretchSpeed) < 1e-3)
      stretch = stretchSpeed = 0;
    const pressTarget = Number(Boolean(drag));
    press = mix(press, pressTarget, 1 - Math.exp(-dt * (drag ? 30 : 21)));
    if (Math.abs(press - pressTarget) < 1e-3) press = pressTarget;
    agitation = Math.max(drag && !drag.active ? 0.3 : 0, agitation - dt * 7);
    const box = knobGeometry(position, stretch, press);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const livePointer = pointer && now - pointer.at < 160 ? pointer : void 0;
    const { scatter, moving } = particles.advance(clamp(theme), agitation, livePointer, center, dt);
    render(box, scatter, transit);
    if (
      moving ||
      agitation ||
      position !== Number(checked) ||
      stretch ||
      press !== pressTarget ||
      colorMove ||
      lightMove ||
      drag?.active
    )
      requestFrame();
    else lastTime = 0;
  }
  function playClick() {
    if (!options.sound || !browser.AudioContext) return;
    try {
      audio ??= new browser.AudioContext();
      if (audio.state === "suspended") void audio.resume().catch(() => {});
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      const start = audio.currentTime;
      tone.type = "triangle";
      tone.frequency.setValueAtTime(checked ? 1500 : 900, start);
      tone.frequency.exponentialRampToValueAtTime(checked ? 2300 : 480, start + 0.06);
      volume.gain.setValueAtTime(1e-4, start);
      volume.gain.exponentialRampToValueAtTime(0.1, start + 5e-3);
      volume.gain.exponentialRampToValueAtTime(1e-4, start + 0.09);
      tone.connect(volume).connect(audio.destination);
      tone.onended = () => {
        tone.disconnect();
        volume.disconnect();
      };
      tone.start(start);
      tone.stop(start + 0.1);
    } catch {
      // 音频不可用时继续完成视觉切换。
    }
  }
  function change(next, trigger, trusted = false) {
    const changed = next !== checked;
    checked = next;
    control.setAttribute("aria-checked", String(checked));
    if (reduced() || owner.hidden) snap();
    else {
      const now = browser.performance.now();
      const clicking = trigger === "click";
      const rest = restAngle(checked);
      const finalPhase = clicking
        ? Math.ceil(phase + 0.1 - rest) + rest
        : Math.round(phase - rest) + rest;
      colorMove = { from: theme, start: now, duration: clicking ? (checked ? 100 : 70) : 140 };
      lightMove = {
        from: phase,
        to: finalPhase,
        start: now + (clicking ? 10 : 0),
        duration: clicking ? 900 : 700,
      };
      if (clicking) {
        press = Math.max(press, 0.65);
        agitation = 0.8;
        particles.burst(1.1);
      }
      requestFrame();
    }
    if (changed && trigger !== "update" && trigger !== "cancel") {
      if (trusted) playClick();
      options.onCheckedChange?.(checked);
    }
  }
  function point(event) {
    const rect = control.getBoundingClientRect();
    const scale = rect.width / TRACK_WIDTH;
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  }
  on(control, "pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    const local = point(event);
    drag = {
      id: event.pointerId,
      startX: local.x,
      startPosition: position,
      x: local.x,
      at: browser.performance.now(),
      velocity: 0,
      active: false,
      base: 0,
    };
    suppressClick = false;
    control.setPointerCapture(event.pointerId);
    if (!reduced()) {
      agitation = 0.3;
      particles.burst(0.35);
      requestFrame();
    }
  });
  on(control, "pointermove", (event) => {
    if (drag && event.pointerId !== drag.id) return;
    const local = point(event);
    pointer =
      event.pointerType === "touch" && !drag ? void 0 : { ...local, at: browser.performance.now() };
    if (drag) {
      const delta = local.x - drag.startX;
      if (!drag.active && Math.abs(delta) > 3) {
        drag.active = true;
        drag.base = Math.round(phase - position * DAY_ANGLE);
        control.dataset.dragging = "";
        colorMove = lightMove = void 0;
      }
      if (drag.active) {
        const raw = drag.startPosition + delta / TRAVEL;
        const next =
          raw < 0 ? -((-raw) ** 0.6) * 0.05 : raw > 1 ? 1 + (raw - 1) ** 0.6 * 0.05 : raw;
        const now = browser.performance.now();
        const elapsed = Math.max(1, now - drag.at);
        drag.velocity = mix(drag.velocity, (local.x - drag.x) / elapsed, 0.5);
        speed = mix(speed, ((next - position) * 1e3) / elapsed, 0.5);
        drag.x = local.x;
        drag.at = now;
        position = next;
        agitation = Math.max(agitation, clamp(Math.abs(drag.velocity) * 1.6) * 0.9);
        if (reduced()) {
          theme = Number(next >= 0.5);
          phase = drag.base + clamp(next) * DAY_ANGLE;
          particles.assign(theme, true);
          render();
        }
      }
    }
    requestFrame();
  });
  on(control, "pointerleave", () => {
    pointer = void 0;
    requestFrame();
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const completed = event.type === "pointerup";
    const { active, velocity, at } = drag;
    drag = void 0;
    if (event.pointerType === "touch" || !completed) pointer = void 0;
    delete control.dataset.dragging;
    if (!active) return;
    suppressClick = true;
    const fling = browser.performance.now() - at <= 120 && Math.abs(velocity) > 0.6;
    const next = completed ? (fling ? velocity > 0 : position >= 0.5) : checked;
    change(next, completed ? "drag" : "cancel", event.isTrusted);
  }
  on(control, "pointerup", finishDrag);
  on(control, "pointercancel", finishDrag);
  on(control, "lostpointercapture", finishDrag);
  on(control, "click", (event) => {
    if (event.detail && suppressClick) return;
    change(!checked, "click", event.isTrusted);
  });
  on(owner, "visibilitychange", () => {
    if (!owner.hidden) return;
    drag = pointer = void 0;
    delete control.dataset.dragging;
    snap();
  });
  on(browser.matchMedia("(prefers-reduced-motion: reduce)"), "change", () => {
    if (reduced()) snap();
  });
  scope.addCleanup(() => {
    if (audio) void audio.close().catch(() => {});
  });
  control.setAttribute("aria-checked", String(checked));
  snap();
  return {
    ...scope.controller,
    update(next) {
      if (destroyed) return;
      options = { ...options, ...next };
      control.setAttribute("aria-label", options.label || "Day mode");
      scope.controller.update(next);
      if (typeof next.checked === "boolean" && next.checked !== checked) {
        if (drag && control.hasPointerCapture(drag.id)) {
          suppressClick = true;
          control.releasePointerCapture(drag.id);
        }
        drag = pointer = void 0;
        delete control.dataset.dragging;
        change(next.checked, "update");
      } else if (reduced() && !drag) snap();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      scope.controller.destroy();
    },
  };
}

// src/lib/motion-core/pixel-toggle-entry.js
var css =
  ".pixel-scene {\r\n  position: relative;\r\n  display: grid;\r\n  min-height: var(--motion-height, 540px);\r\n  place-items: center;\r\n  isolation: isolate;\r\n  overflow: hidden;\r\n  background: radial-gradient(ellipse 140% 155% at 92% -8%, var(--halo), var(--background) 84%);\r\n}\r\n\r\n.pixel-scene[data-preview] { background: #f4f4f4; }\r\n\r\n.pixel-switch {\r\n  position: relative;\r\n  width: 520px;\r\n  height: 272px;\r\n  padding: 0;\r\n  border: 0;\r\n  border-radius: 86px;\r\n  background: linear-gradient(180deg, var(--track-top), var(--track-bottom));\r\n  box-shadow: inset 0 12px 24px var(--track-inset), inset 0 -2px 4px var(--track-light),\r\n    0 1.5px 0 var(--track-edge), 0 26px 46px -20px var(--track-shadow);\r\n  transform: scale(var(--pixel-switch-scale, .83));\r\n  outline-offset: 8px;\r\n  cursor: grab;\r\n  touch-action: pan-y;\r\n  user-select: none;\r\n  -webkit-tap-highlight-color: transparent;\r\n}\r\n\r\n.pixel-switch[data-dragging] { cursor: grabbing; }\r\n.pixel-switch:focus-visible { outline: 2px solid var(--focus); }\r\n.pixel-switch > * { pointer-events: none; }\r\n\r\n.pixel-knob {\r\n  position: absolute;\r\n  display: block;\r\n  border-radius: 69px;\r\n  background: linear-gradient(180deg, var(--knob-top), var(--knob-bottom));\r\n  box-shadow: inset 0 0 0 1px var(--knob-rim), inset 0 0 5px #ffffff2e,\r\n    0 16px 22px -9px var(--knob-shadow), 0 4px 9px var(--knob-shadow);\r\n}\r\n\r\n.pixel-effects {\r\n  position: absolute;\r\n  display: block;\r\n  width: 800px;\r\n  height: 552px;\r\n  left: -140px;\r\n  top: -140px;\r\n}\r\n\r\n.pixel-glass {\r\n  position: absolute;\r\n  inset: 0;\r\n  display: block;\r\n  width: 100%;\r\n  height: 100%;\r\n  pointer-events: none;\r\n}\r\n\r\n.pixel-scene[data-glass-renderer] .pixel-switch {\r\n  background: transparent;\r\n  box-shadow: none;\r\n}\r\n\r\n.pixel-scene[data-glass-renderer] .pixel-knob { visibility: hidden; }\r\n";
function mountPixelToggle(host, options = {}) {
  return createPixelToggle(host, options, css);
}
export { mountPixelToggle };
