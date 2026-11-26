import { scenes } from "./showcase-scenes";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import modelUrl from "./previews/workdesk.glb?url";
import homeUrl from "./previews/desk-display.jpg";
import codeUrl from "./previews/code.jpg";
import teamUrl from "./previews/team-execution.jpg";
import workflowUrl from "./previews/workflow.jpg";
import deployUrl from "./previews/deploy.jpg";
import learningUrl from "./previews/learning.jpg";

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

const crewPositions: Record<string, [number, number, number]> = {
  "bot-claude-body": [4.8, 1.72, -4.7],
  "bot-codex-body": [-4.9, 1.72, -4],
  "bot-qwen-body": [-11.8, 1.56, 9],
  "bot-pi-body": [-8.1, 1.56, 9.5],
  "bot-antigravity-body": [-4.5, 1.56, 9.4],
  "bot-deepseek-body": [2.4, 1.56, 9.6],
  "bot-copilot-body": [8.7, 1.56, 9.2],
};

export async function mountMacDesk(host: HTMLElement, signal: AbortSignal) {
  const [bytes, home, code, team, workflow, deploy, learning] = await Promise.all([
    fetch(modelUrl, { signal }).then((r) => {
      if (!r.ok) throw Error("Missing desk model");
      return r.arrayBuffer();
    }),
    image(homeUrl),
    image(codeUrl),
    image(teamUrl),
    image(workflowUrl),
    image(deployUrl),
    image(learningUrl),
  ]);
  const screens = [home, code, code, team, workflow, deploy, learning];
  signal.throwIfAborted();
  const { scene: model } = await new GLTFLoader().parseAsync(bytes, "");
  const resources = new Set<THREE.Material | THREE.Texture | THREE.BufferGeometry>();
  const track = <T extends THREE.Material | THREE.Texture | THREE.BufferGeometry>(value: T) => {
    resources.add(value);
    return value;
  };
  const crew: THREE.Object3D[] = [];
  model.traverse((obj: THREE.Object3D) => {
    if (!(obj instanceof THREE.Mesh)) return;
    track(obj.geometry);
    for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      track(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) track(value);
    }
    obj.castShadow = true;
    obj.receiveShadow = true;
    const pos = crewPositions[obj.name];
    if (pos) {
      obj.position.set(...pos);
      obj.rotation.y = 0.18;
      crew.push(obj);
    }
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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.add(model, new THREE.HemisphereLight(0xfff9ed, 0xdfd8cb, 2.1));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.0);
  sun.position.set(-28, 55, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -52, right: 40, top: 54, bottom: -42, far: 150 });
  sun.shadow.normalBias = 0.055;
  sun.shadow.bias = -0.00016;
  scene.add(sun);
  const paper = new THREE.Mesh(
    track(new THREE.PlaneGeometry(45, 35)),
    track(new THREE.MeshStandardMaterial({ map: track(paperTexture()), roughness: 1 })),
  );
  paper.rotation.x = -Math.PI / 2;
  paper.rotation.z = -0.025;
  paper.position.set(0, -0.09, 2);
  paper.receiveShadow = true;
  scene.add(paper);
  const floor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(180, 180)),
    track(new THREE.ShadowMaterial({ opacity: 0.13 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.13;
  floor.receiveShadow = true;
  scene.add(floor);
  const surface = document.createElement("canvas");
  surface.width = 1024;
  surface.height = 665;
  const ctx = surface.getContext("2d")!;
  const texture = track(new THREE.CanvasTexture(surface));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const display = model.getObjectByName("mac-screen") as THREE.Mesh;
  display.material = track(new THREE.MeshBasicMaterial({ map: texture }));
  display.castShadow = false;
  // The screen sits only 0.004 units above the bezel. Keep depth precision
  // around the desk throughout the orbit so the bezel cannot bleed through.
  const camera = new THREE.PerspectiveCamera(25, 1, 30, 220);
  const stage = host.closest<HTMLElement>(".tour-stage");
  let raf = 0,
    visible = false,
    prev = 0,
    t = 0,
    lastTexture = -1,
    lastProgress = -1;
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  function render(now: number) {
    raf = 0;
    if (!visible || document.hidden || signal.aborted) return;
    raf = requestAnimationFrame(render);
    if (now - prev < 32) return;
    t += Math.min((now - prev) / 1000, 0.05);
    prev = now;
    const progress = Number(stage?.dataset.deskProgress ?? 0);
    const chapter = Math.floor(progress);
    const next = Math.min(chapter + 1, scenes.length - 1);
    const fraction = progress - chapter;
    const blend = THREE.MathUtils.smoothstep(fraction, 0, 1);
    const from = scenes[chapter]!.camera;
    const to = scenes[next]!.camera;
    const radius = THREE.MathUtils.lerp(from.radius, to.radius, blend);
    const pitch = THREE.MathUtils.lerp(from.pitch, to.pitch, blend);
    const yaw = THREE.MathUtils.lerp(from.yaw, to.yaw, blend);
    const targetHeight = THREE.MathUtils.lerp(from.targetHeight, to.targetHeight, blend);
    camera.position.set(
      Math.sin(yaw) * Math.cos(pitch) * radius,
      targetHeight + Math.sin(pitch) * radius,
      -2 + Math.cos(yaw) * Math.cos(pitch) * radius,
    );
    camera.lookAt(0, targetHeight, -2);
    crew.forEach((bot, i) => {
      const p = crewPositions[bot.name]!;
      const hop = Math.max(0, Math.sin(t * 3 + i * 1.7));
      bot.position.y = p[1] + hop ** 3 * 0.48;
      bot.rotation.z = Math.sin(t * 3 + i) * 0.045;
    });
    if (progress !== lastProgress || (chapter === 0 && t - lastTexture > 0.11)) {
      lastTexture = t;
      lastProgress = progress;
      const screen = screens[chapter]!;
      ctx.drawImage(screen, 0, 0, 1024, 665);
      if (screen === home) {
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
      const screenBlend = THREE.MathUtils.smoothstep(fraction, 0.35, 0.68);
      if (screenBlend && screens[next] !== screen) {
        ctx.globalAlpha = screenBlend;
        ctx.drawImage(screens[next]!, 0, 0, 1024, 665);
        ctx.globalAlpha = 1;
      }
      texture.needsUpdate = true;
    }
    renderer.render(scene, camera);
    host.setAttribute("data-rendered", "");
  }
  function schedule() {
    cancelAnimationFrame(raf);
    if (visible && !document.hidden) {
      prev = performance.now();
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
