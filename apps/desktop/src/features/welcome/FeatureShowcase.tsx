import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { DeskScene, frameCamera } from "./DeskScene";
import { scenes } from "./showcase-scenes";
import "./desk-scene.css";

const tourMedia = matchMedia(
  "(min-width: 901px) and (min-height: 620px) and (prefers-reduced-motion: no-preference)",
);
function subscribeTour(callback: () => void) {
  tourMedia.addEventListener("change", callback);
  return () => tourMedia.removeEventListener("change", callback);
}

export function FeatureShowcase() {
  const tour = useSyncExternalStore(subscribeTour, () => tourMedia.matches);
  const [index, setIndex] = useState(0);
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = section.current;
    const camera = stage.current;
    const root = element?.closest<HTMLElement>("[data-welcome-scroll]");
    if (!tour || !element || !camera || !root) return;
    let frame = 0;
    let last = -1;
    const update = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const progress = Math.max(0, Math.min(scenes.length - 1, top / camera.offsetHeight));
      if (last === progress) return;
      last = progress;
      frameCamera(camera, progress);
      setIndex(Math.round(progress));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(camera);
    observer.observe(root);
    root.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [tour]);

  function visit(next: number) {
    if (!tour) {
      setIndex(next);
      section.current?.querySelector(".tour-static img")?.scrollIntoView({
        block: "nearest",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
      return;
    }
    section.current
      ?.querySelectorAll<HTMLElement>(".tour-chapter")
      [next]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const selected = scenes[index]!;
  const directory = (
    <nav className="tour-directory" aria-label="探索工作台目录">
      {scenes.map((scene, i) => (
        <button
          type="button"
          key={scene.title}
          aria-current={i === index ? "step" : undefined}
          onClick={() => visit(i)}
        >
          <scene.icon aria-hidden size={16} />
          <span>{scene.title}</span>
        </button>
      ))}
    </nav>
  );
  const chapter = (scene: (typeof scenes)[number]) => (
    <div className="tour-copy" style={{ "--tint": scene.tint } as CSSProperties}>
      <div className="tour-label">
        <scene.icon size={17} aria-hidden />
        {scene.title}
      </div>
      <h3>
        {scene.headline[0]}
        <br />
        {scene.headline[1]}
      </h3>
      <p>{scene.description}</p>
      {tour && scene.kind === "laptop" && (
        <div className="tour-roadmap">
          {scenes
            .filter((item) => ["editor", "phone", "board"].includes(item.kind))
            .map((item) => (
              <button type="button" key={item.kind} onClick={() => visit(scenes.indexOf(item))}>
                {item.title}
                <ArrowUpRight size={14} aria-hidden />
              </button>
            ))}
        </div>
      )}
      <div className="tour-links">
        {scene.kind === "phone" && (
          <a
            href="https://github.com/exploitationExplorers/AgentDesk/blob/main/deploy/cloud/README.md"
            target="_blank"
            rel="noreferrer"
          >
            设置远程工作台
            <ArrowUpRight size={15} aria-hidden />
          </a>
        )}
        {scene.links.map(([label, to]) => (
          <Link key={to} to={to}>
            {label}
            <ArrowUpRight size={15} aria-hidden />
          </Link>
        ))}
      </div>
    </div>
  );
  return (
    <section id="cases" className="welcome-explorer" ref={section} aria-label="探索工作台">
      {tour ? (
        <>
          <div
            className="tour-stage"
            ref={stage}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse") return;
              const box = event.currentTarget.getBoundingClientRect();
              event.currentTarget.style.setProperty(
                "--mx",
                String((event.clientX - box.left) / box.width - 0.5),
              );
              event.currentTarget.style.setProperty(
                "--my",
                String((event.clientY - box.top) / box.height - 0.5),
              );
            }}
            onPointerLeave={(event) => {
              event.currentTarget.style.removeProperty("--mx");
              event.currentTarget.style.removeProperty("--my");
            }}
          >
            <DeskScene />
            <div className="tour-bar">
              <h2>探索工作台</h2>
              {directory}
            </div>
          </div>
          <div className="tour-chapters">
            {scenes.map((scene) => (
              <article className="tour-chapter" key={scene.title}>
                {chapter(scene)}
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="tour-static">
          <h2>探索工作台</h2>
          {directory}
          <img
            className={selected.kind === "phone" ? "static-phone" : undefined}
            src={selected.image}
            alt={`${selected.caption}界面`}
            width="1200"
            height="750"
            loading="lazy"
          />
          {chapter(selected)}
        </div>
      )}
    </section>
  );
}
