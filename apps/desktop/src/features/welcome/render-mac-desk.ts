import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { laneFor, mobileDeskX, runAcrossDesk } from "./desk-choreography";
import { phoneIndex, phoneTravel, scenes, tourPoints } from "./showcase-scenes";
import modelUrl from "./previews/workdesk.glb?url";
import homeUrl from "./previews/desk-display.jpg";

const maxPixelRatio = 2;
const maxCanvasPixels = 4_600_000;
const phoneScene = scenes[phoneIndex]!;

function demoImages(scene: (typeof scenes)[number]) {
  const points = tourPoints[scene.kind];
  return points?.[0]?.image
    ? points.map((point) => point.image!)
    : [scene.kind === "laptop" ? homeUrl : scene.kind === "phone" ? scenes[1].image : scene.image];
}

function image(url: string) {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

function paperTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 768;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f4efe4";
  ctx.fillRect(0, 0, 1024, 768);
  ctx.strokeStyle = "#dcd5c4";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 16; x < 1010; x += 24) {
    ctx.moveTo(x, 15);
    ctx.lineTo(x, 755);
  }
  for (let y = 16; y < 755; y += 24) {
    ctx.moveTo(16, y);
    ctx.lineTo(1010, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "#b7ad99";
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, 992, 735);
  ctx.strokeRect(75, 257, 750, 385);
  ctx.strokeRect(655, 658, 329, 64);
  ctx.fillStyle = "#817767";
  ctx.font = "17px monospace";
  ctx.fillText("AgentDesk  /  WORKSPACE", 673, 698);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A printed handoff sheet gives the travelling camera a landmark between devices.
function handoffSheet() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f2e9d4";
  ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = "#9e9889";
  ctx.strokeRect(18, 18, 988, 476);
  ctx.fillStyle = "#6d7267";
  ctx.font = "24px monospace";
  ctx.fillText("AgentDesk   /   SESSION HANDOFF", 50, 77);
  ctx.font = "18px monospace";
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(126, 249);
  ctx.lineTo(890, 249);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [i, label] of ["SESSION", "RUN", "REVIEW"].entries()) {
    const x = 100 + 345 * i;
    ctx.fillStyle = "#e4e1d2";
    ctx.fillRect(x, 190, 143, 118);
    ctx.strokeRect(x, 190, 143, 118);
    ctx.fillStyle = "#657869";
    ctx.fillText(`0${i + 1}`, x + 14, 220);
    ctx.fillText(label, x + 14, 281);
  }
  ctx.fillText("FIG. 02    DESKTOP  /  MOBILE", 50, 451);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

function drawHomeScreen(ctx: CanvasRenderingContext2D, home: HTMLImageElement, t: number) {
  ctx.drawImage(home, 0, 0, 1024, 665);
  const phase = (t % 7) / 7;
  ctx.fillStyle = "#efeee6";
  ctx.fillRect(448, 539, 460, 5);
  ctx.fillStyle = "#508d7b";
  ctx.fillRect(448, 539, 460 * Math.min(1, phase * 1.4), 5);
  if (phase > 0.42 && phase < 0.92) {
    ctx.fillStyle = "#1e2928";
    ctx.beginPath();
    ctx.roundRect(361, 0, 310, 134, 10);
    ctx.fill();
    ctx.fillStyle = "#e8f0e9";
    ctx.font = "bold 18px sans-serif";
    ctx.fillText("AgentDesk · 任务进度", 381, 36);
    ctx.font = "15px sans-serif";
    ctx.fillText("读取会话记录", 381, 73);
    ctx.fillText("运行测试", 381, 105);
    ctx.fillStyle = "#80bd9d";
    ctx.fillRect(525, 63, 112, 5);
    ctx.fillRect(525, 96, 74, 5);
  }
}

export async function mountMacDesk(host: HTMLElement, signal: AbortSignal) {
  const urls = scenes.map(demoImages);
  const [bytes, decoded] = await Promise.all([
    fetch(modelUrl, { signal }).then((r) => {
      if (!r.ok) throw Error("Missing desk model");
      return r.arrayBuffer();
    }),
    Promise.all([...new Set(urls.flat())].map(async (url) => [url, await image(url)] as const)),
  ]);
  const previews = new Map(decoded);
  const home = previews.get(homeUrl)!;
  signal.throwIfAborted();
  const { scene: model } = await new GLTFLoader().parseAsync(bytes, "");
  const resources = new Set<THREE.Material | THREE.Texture | THREE.BufferGeometry>();
  const track = <T extends THREE.Material | THREE.Texture | THREE.BufferGeometry>(value: T) => {
    resources.add(value);
    return value;
  };
  const crew: { bot: THREE.Object3D; lane: number }[] = [];
  model.traverse((obj: THREE.Object3D) => {
    if (!(obj instanceof THREE.Mesh)) return;
    track(obj.geometry);
    for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      track(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) track(value);
    }
    obj.castShadow = true;
    obj.receiveShadow = true;
    const lane = laneFor(obj.name);
    if (lane !== -1) crew.push({ bot: obj, lane });
  });
  const releaseModel = () => {
    for (const resource of resources) resource.dispose();
  };
  if (signal.aborted) {
    releaseModel();
    return () => {};
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch (error) {
    releaseModel();
    throw error;
  }
  renderer.setClearColor(0, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.add(model, new THREE.HemisphereLight(0xfff9ed, 0xdfd8cb, 2.1));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.0);
  sun.position.set(-28, 55, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(768, 768);
  Object.assign(sun.shadow.camera, { left: -52, right: 40, top: 54, bottom: -42, far: 150 });
  sun.shadow.normalBias = 0.055;
  sun.shadow.intensity = 0.64;
  sun.shadow.bias = -0.00016;
  scene.add(sun, sun.target);
  const paper = new THREE.Mesh(
    track(new THREE.PlaneGeometry(45, 35)),
    track(new THREE.MeshStandardMaterial({ map: track(paperTexture()), roughness: 1 })),
  );
  paper.rotation.x = -Math.PI / 2;
  paper.rotation.z = -0.025;
  paper.position.set(0, -0.09, 2);
  paper.receiveShadow = true;
  scene.add(paper);
  const sheet = new THREE.Mesh(
    track(new THREE.PlaneGeometry(24, 12)),
    track(new THREE.MeshStandardMaterial({ map: track(handoffSheet()), roughness: 1 })),
  );
  sheet.rotation.set(-Math.PI / 2, 0, -0.085);
  sheet.position.set(32, -0.075, -6);
  sheet.receiveShadow = true;
  scene.add(sheet);
  const floor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(180, 180)),
    track(new THREE.ShadowMaterial({ opacity: 0.13 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.13;
  floor.receiveShadow = true;
  scene.add(floor);
  const surface = document.createElement("canvas");
  surface.width = home.naturalWidth;
  surface.height = home.naturalHeight;
  const ctx = surface.getContext("2d")!;
  ctx.scale(surface.width / 1024, surface.height / 665);
  drawHomeScreen(ctx, home, 0);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const screenTexture = (texture: THREE.Texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    return track(texture);
  };
  const homeScreen = screenTexture(new THREE.CanvasTexture(surface));
  const textures = new Map([[homeUrl, homeScreen as THREE.Texture]]);
  const screens = urls.map((chapter) =>
    chapter.map((url) => {
      let texture = textures.get(url);
      if (!texture) {
        texture = screenTexture(new THREE.Texture(previews.get(url)!));
        textures.set(url, texture);
      }
      return texture;
    }),
  );
  const nextScreen = { value: homeScreen };
  const screenMix = { value: 0 };
  const mapFit = { value: new THREE.Vector2(1, 1) };
  const nextFit = { value: new THREE.Vector2(1, 1) };
  const screenAspect = 29.9 / Math.hypot(18.75748, 5.02605);
  function fitScreen(texture: THREE.Texture, fit: THREE.Vector2) {
    const { width, height } = texture.image as HTMLImageElement | HTMLCanvasElement;
    const ratio = width / height / screenAspect;
    fit.set(Math.max(1, 1 / ratio), Math.max(1, ratio));
  }
  const screenMaterial = track(new THREE.MeshBasicMaterial({ map: homeScreen }));
  screenMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.nextScreen = nextScreen;
    shader.uniforms.screenMix = screenMix;
    shader.uniforms.mapFit = mapFit;
    shader.uniforms.nextFit = nextFit;
    // Blend the original textures on the GPU without resampling them into a canvas on scroll.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <map_pars_fragment>",
        `#include <map_pars_fragment>
        uniform sampler2D nextScreen;
        uniform float screenMix;
        uniform vec2 mapFit;
        uniform vec2 nextFit;
        vec4 preview(sampler2D panel, vec2 uv, vec2 fit) {
          vec2 coord = (uv - 0.5) * fit + 0.5;
          if (any(lessThan(coord, vec2(0.0))) || any(greaterThan(coord, vec2(1.0)))) {
            return vec4(0.09, 0.10, 0.105, 1.0);
          }
          return texture2D(panel, coord);
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `vec4 current = preview(map, vMapUv, mapFit);
        if (screenMix > 0.0) current = mix(current, preview(nextScreen, vMapUv, nextFit), screenMix);
        diffuseColor *= current;`,
      );
  };
  const display = model.getObjectByName("mac-screen") as THREE.Mesh;
  display.material = screenMaterial;
  display.castShadow = false;
  // The screen sits only 0.004 units above the bezel. Keep depth precision
  // around the desk throughout the orbit so the bezel cannot bleed through.
  const camera = new THREE.PerspectiveCamera(25, 1, 26, 200);
  const stage = host.closest<HTMLElement>(".tour-stage");
  let raf = 0;
  let visible = false;
  let previousFrame = 0;
  let previousProgress = -1;
  let scrollDirection = 1;
  let t = 0;
  let lastHomeUpdate = 0;
  let width = 1;
  let height = 1;
  let projectionHeight = 1;
  let phoneWidth = 40;
  let phoneHeight = 28;
  let displayed: THREE.Texture | undefined;
  let incoming: THREE.Texture | undefined;
  let demoChangedAt = 0;
  const resize = new ResizeObserver(() => {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    projectionHeight = (Math.min(width * 0.523, height * 0.86) * 1.86) / 1.45;
    const phone = stage?.querySelector<HTMLElement>(".object-phone");
    if (phone) {
      const unitsPerPixel =
        (2 * phoneScene.camera.radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
        projectionHeight;
      phoneWidth = phone.offsetWidth * unitsPerPixel;
      phoneHeight = phone.offsetHeight * unitsPerPixel;
    }
    // The camera covers the whole desk, but only the visible stage allocates backing pixels.
    const pixelRatio = Math.min(
      devicePixelRatio,
      maxPixelRatio,
      Math.sqrt(maxCanvasPixels / (width * height)),
    );
    renderer.setDrawingBufferSize(width, height, pixelRatio);
  });
  resize.observe(host);

  function selectedScreen(index: number) {
    // The handset has its own display. The Mac keeps the editor preview on the way there.
    const laptopIndex = index === phoneIndex ? phoneIndex - 1 : index;
    const chapter = scenes[laptopIndex]!;
    const selected = Number(stage?.getAttribute(`data-demo-${chapter.kind}`) ?? 0);
    return screens[laptopIndex]![selected] ?? screens[laptopIndex]![0]!;
  }

  function render(now: number) {
    raf = 0;
    if (!visible || document.hidden || signal.aborted) return;
    raf = requestAnimationFrame(render);
    const progress = Number(stage?.dataset.deskProgress ?? 0);
    const changed = progress !== previousProgress;
    // Follow scroll at display cadence. Idle hops only need about 30 updates per second.
    if (!changed && now - previousFrame < 30) return;
    t += Math.min((now - previousFrame) / 1000, 0.05);
    previousFrame = now;
    if (changed && previousProgress >= 0) scrollDirection = Math.sign(progress - previousProgress);
    previousProgress = progress;
    const travel = phoneTravel(progress);
    const chapter = Math.floor(progress);
    const next = Math.min(chapter + 1, scenes.length - 1);
    const fraction = progress - chapter;
    const blend = THREE.MathUtils.smoothstep(fraction, 0.06, 0.97);
    const crossing = Math.sin(Math.PI * blend);
    const direction = chapter % 2 === 0 ? -1 : 1;
    const from = scenes[chapter]!.camera;
    const to = scenes[next]!.camera;
    const phoneHandoff = chapter === phoneIndex - 1 || chapter === phoneIndex;
    const overhead = THREE.MathUtils.smoothstep(travel, 0.22, 0.96);
    const mac = chapter === phoneIndex - 1 ? from : to;
    const pose = phoneHandoff ? phoneScene.camera : to;
    const source = phoneHandoff ? mac : from;
    const motion = phoneHandoff ? overhead : blend;
    const radius =
      THREE.MathUtils.lerp(source.radius, pose.radius, motion) +
      (phoneHandoff ? 23 : 14) * crossing;
    const pitch = THREE.MathUtils.lerp(source.pitch, pose.pitch, motion) + 0.08 * crossing;
    const yaw = THREE.MathUtils.lerp(source.yaw, pose.yaw, motion) + direction * 0.19 * crossing;
    const targetHeight = THREE.MathUtils.lerp(source.targetHeight, pose.targetHeight, motion);
    const side = chapter % 2 === 0 ? blend : 1 - blend;
    // Let the shot temporarily open into the middle while the roster crosses the desk.
    const center = THREE.MathUtils.lerp(
      0.715 - 0.43 * side,
      0.5,
      phoneHandoff ? 0.28 * crossing : 0,
    );
    const targetX = mobileDeskX * travel;
    const targetZ = THREE.MathUtils.lerp(-4.5, -2, travel);
    camera.setViewOffset(
      width,
      projectionHeight,
      width * (0.5 - center),
      projectionHeight / 2 - height * 0.53,
      width,
      height,
    );
    camera.position.set(
      targetX + Math.sin(yaw) * Math.cos(pitch) * radius,
      targetHeight + Math.sin(pitch) * radius,
      targetZ + Math.cos(yaw) * Math.cos(pitch) * radius,
    );
    camera.lookAt(targetX, targetHeight, targetZ);
    sun.position.x = -28 + targetX;
    sun.target.position.x = targetX;
    for (const { bot, lane } of crew)
      runAcrossDesk(bot, lane, progress, t, phoneWidth, phoneHeight, scrollDirection);
    if (chapter === 0 && t - lastHomeUpdate > 0.11) {
      drawHomeScreen(ctx, home, t);
      homeScreen.needsUpdate = true;
      lastHomeUpdate = t;
    }
    const chapterMix = THREE.MathUtils.smoothstep(fraction, 0.35, 0.68);
    const fromScreen = selectedScreen(chapter);
    const toScreen = selectedScreen(next);
    const transitionMix = fromScreen === toScreen ? 0 : chapterMix;
    const selected = selectedScreen(fraction < 0.5 ? chapter : next);
    if (changed || !displayed) {
      displayed = selected;
      incoming = selected;
      screenMaterial.map = fromScreen;
      nextScreen.value = toScreen;
      screenMix.value = transitionMix;
    } else if (fraction < 0.18 || fraction > 0.82) {
      if (incoming !== selected) {
        displayed = incoming ?? selected;
        incoming = selected;
        demoChangedAt = t;
      }
      screenMaterial.map = displayed;
      nextScreen.value = selected;
      screenMix.value =
        displayed === selected ? 0 : THREE.MathUtils.smoothstep(t - demoChangedAt, 0, 0.28);
      if (screenMix.value >= 1) displayed = selected;
    } else {
      screenMaterial.map = fromScreen;
      nextScreen.value = toScreen;
      screenMix.value = transitionMix;
    }
    fitScreen(screenMaterial.map, mapFit.value);
    fitScreen(nextScreen.value, nextFit.value);
    renderer.render(scene, camera);
    if (!host.hasAttribute("data-rendered")) host.setAttribute("data-rendered", "");
  }
  function schedule() {
    cancelAnimationFrame(raf);
    if (visible && !document.hidden) {
      previousFrame = performance.now();
      raf = requestAnimationFrame(render);
    }
  }
  const observer = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    schedule();
  });
  observer.observe(host);
  document.addEventListener("visibilitychange", schedule);
  const lost = (event: Event) => {
    event.preventDefault();
    host.removeAttribute("data-rendered");
    visible = false;
    cancelAnimationFrame(raf);
  };
  renderer.domElement.addEventListener("webglcontextlost", lost);
  host.append(renderer.domElement);
  return () => {
    observer.disconnect();
    resize.disconnect();
    document.removeEventListener("visibilitychange", schedule);
    cancelAnimationFrame(raf);
    renderer.domElement.removeEventListener("webglcontextlost", lost);
    renderer.domElement.remove();
    host.removeAttribute("data-rendered");
    sun.shadow.map?.dispose();
    releaseModel();
    renderer.dispose();
    renderer.forceContextLoss();
  };
}
