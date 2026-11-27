import { type CSSProperties } from "react";
import { MacDesk } from "./MacDesk";
import { PhoneDisplay } from "./DeskDevices";
import { phoneTravel } from "./showcase-scenes";

export function frameCamera(stage: HTMLElement, progress: number) {
  stage.dataset.deskProgress = String(progress);
  const chapter = Math.floor(progress);
  const phase = progress - chapter;
  const handoff = phase * phase * (3 - 2 * phase);
  const side = chapter % 2 === 0 ? handoff : 1 - handoff;
  stage.style.setProperty("--desk-side", String(side));
  const open = Math.sin(Math.PI * handoff);
  stage.style.setProperty("--desk-open", String(open));
  stage.style.setProperty("--phone-travel", String(phoneTravel(progress)));
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
    <>
      <div className="tour-art-background" aria-hidden="true" />
      <MacDesk />
      <div className="tour-art" aria-hidden="true">
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
    </>
  );
}
