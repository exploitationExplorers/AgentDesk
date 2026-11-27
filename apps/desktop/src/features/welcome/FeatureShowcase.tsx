import remoteSetupGuide from "../../../../../deploy/cloud/README.md?url";
import { WelcomeLink } from "./WelcomeLink";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { DeskScene, frameCamera } from "./DeskScene";
import { scenes, tourPoints } from "./showcase-scenes";
import { TourPoints } from "./TourPoints";
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
  const [settled, setSettled] = useState(true);
  const [inView, setInView] = useState(false);
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = section.current;
    const camera = stage.current;
    const root = element?.closest<HTMLElement>("[data-welcome-scroll]");
    if (!tour || !element || !camera || !root) return;
    const captions = Array.from(camera.querySelectorAll<HTMLElement>(".tour-caption"));
    const chapterTrack = element.querySelector<HTMLElement>(".tour-chapters");
    if (!chapterTrack) return;
    let frame = 0;
    let last = -1;
    const update = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const progress = Math.max(
        0,
        Math.min(scenes.length - 1, top / (chapterTrack.offsetHeight / scenes.length)),
      );
      if (last === progress) return;
      last = progress;
      frameCamera(camera, progress);
      const active = Math.round(progress);
      setSettled(Math.abs(active - progress) < 0.18);
      for (const [i, caption] of captions.entries()) {
        const offset = Math.max(-1, Math.min(1, i - progress));
        // Let the desk fill the frame between the outgoing and incoming captions.
        const fade = Math.max(0, Math.min(1, (Math.abs(offset) - 0.05) / 0.22));
        const away = fade * fade * (3 - 2 * fade);
        caption.style.opacity = String(1 - away);
        caption.style.visibility = away === 1 ? "hidden" : "visible";
        caption.style.transform = `translate3d(${(i % 2 ? 1 : -1) * away * 36}px, ${Math.sign(offset) * away * 15}vh, 0)`;
        caption.inert = i !== active || away > 0.95;
      }
      setIndex(active);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(camera);
    observer.observe(root);
    observer.observe(chapterTrack);
    const visibility = new IntersectionObserver(
      ([entry]) => setInView((entry?.intersectionRatio ?? 0) >= 0.65),
      {
        root,
        threshold: 0.65,
      },
    );
    visibility.observe(camera);
    root.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      visibility.disconnect();
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
  const chapter = (scene: (typeof scenes)[number], active = false) => {
    const points = tourPoints[scene.kind];
    return (
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
        {tour && points && (
          <TourPoints kind={scene.kind} points={points} active={active && settled && inView} />
        )}
        <div className="tour-links">
          {scene.kind === "phone" && (
            <a href={remoteSetupGuide} target="_blank" rel="noreferrer">
              远程工作台部署文档
              <ArrowUpRight size={15} aria-hidden />
            </a>
          )}
          {scene.links.map(([label, to]) => (
            <WelcomeLink key={to} to={to}>
              {label}
              <ArrowUpRight size={15} aria-hidden />
            </WelcomeLink>
          ))}
        </div>
      </div>
    );
  };
  return (
    <section id="cases" className="welcome-explorer" ref={section} aria-label="探索工作台">
      {tour ? (
        <>
          <div className="tour-stage" ref={stage}>
            <DeskScene />
            {scenes.map((scene, i) => (
              <article
                className="tour-caption"
                key={scene.kind}
                data-side={i % 2 ? "right" : "left"}
              >
                {chapter(scene, index === i)}
              </article>
            ))}
            <div className="tour-bar">
              <h2>探索工作台</h2>
              {directory}
            </div>
          </div>
          <div className="tour-chapters" aria-hidden="true">
            {scenes.map((scene) => (
              <div className="tour-chapter" key={scene.title} />
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
