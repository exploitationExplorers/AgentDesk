import { type CSSProperties } from "react";
import { MacDesk } from "./MacDesk";
import { PhoneDisplay } from "./DeskDevices";
import { scenes } from "./showcase-scenes";

const phoneChapter = scenes.findIndex((scene) => scene.kind === "phone");

export function frameCamera(stage: HTMLElement, progress: number) {
  stage.dataset.deskProgress = String(progress);
  // One viewport of travel separates the two devices on the desk.
  const distance = Math.abs(progress - phoneChapter);
  const reveal = Math.max(0, Math.min(1, (0.95 - distance) / 0.9));
  stage.style.setProperty("--phone-travel", String(reveal * reveal * (3 - 2 * reveal)));
}

function Crew() {
  return (
    <div className="tour-crew">
      {["mint", "amber", "violet"].map((color, i) => (
        <div
          key={color}
          className={`desk-companion companion-${color}`}
          style={{ "--delay": `${-0.64 * i}s` } as CSSProperties}
        >
          <div className="desk-contact-shadow" />
          <div className="desk-robot">
            <i className="desk-antenna" />
            <i className="desk-visor" />
            <i className="desk-boot left" />
            <i className="desk-boot right" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DeskScene() {
  return (
    <div className="tour-art" aria-hidden="true">
      <div className="tour-parallax">
        <div className="tour-camera-track">
          <div className="tour-object object-laptop">
            <MacDesk />
          </div>
          <div className="tour-object object-phone" data-in-view="">
            <div className="tour-prop">
              <div className="mobile-blueprint-label">
                <b>AgentDesk</b>
                <span>REMOTE WORKSPACE</span>
              </div>
              <div className="phone-watch">
                <div className="watch-band" />
                <div className="watch-face">
                  <b>✓</b>
                  <span>已完成</span>
                </div>
              </div>
              <div className="device-drawing">
                <div className="drawing-outline">
                  <i />
                  <i />
                  <i />
                </div>
                <span>390 × 844</span>
              </div>
              <PhoneDisplay />
              <Crew />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
