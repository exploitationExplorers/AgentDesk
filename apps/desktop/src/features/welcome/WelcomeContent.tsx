import type { CSSProperties } from "react";
import { WelcomeLink } from "./WelcomeLink";
import codePreview from "./previews/code.jpg";
import workflowPreview from "./previews/workflow.jpg";
import { FeatureShowcase } from "./FeatureShowcase";
import { WelcomeActions, WelcomeNavigation } from "./WelcomeNavigation";

const questions = [
  [
    "第一次打开，应该从哪里开始？",
    "先在设置里接入模型，在 Bot 里试一次对话。如果手头已有代码仓库，可以先在设置里添加项目文件夹，再到项目页打开它。",
  ],
  [
    "能找回之前的编码会话吗？",
    "可以。在会话中心按关键词、工具或 PR 编号筛选记录，查看上下文，再从支持的入口继续处理。",
  ],
  [
    "本地群聊和团队开发分别用来做什么？",
    "在本地群聊里让不同角色讨论、核对并总结一个问题。需要让成员认领任务、提交执行结果和验收时，进入团队开发。",
  ],
  [
    "哪些工作适合定时运行？",
    "可以把重复的任务设成自动化，指定运行时间并查看执行记录。需要串联多个步骤时，可以先在工作流画布上编排。",
  ],
  [
    "可以在终端使用吗？",
    "可以。运行 agentdesk chat 进入终端对话，或用 agentdesk web 打开浏览器工作台。模型地址和凭据在你自己的环境中配置。",
  ],
] as const;

export function WelcomeContent({ scrollTo }: { scrollTo: (id: string) => void }) {
  return (
    <>
      <svg
        width={"0"}
        height={"0"}
        style={{ position: "absolute" } as CSSProperties}
        aria-hidden={"true"}
      >
        <defs>
          <filter id={"fuzz"} x={"-10%"} y={"-10%"} width={"120%"} height={"120%"}>
            <feTurbulence
              type={"fractalNoise"}
              baseFrequency={"1.1"}
              numOctaves={"2"}
              seed={"3"}
              result={"n"}
            ></feTurbulence>
            <feDisplacementMap
              in={"SourceGraphic"}
              in2={"n"}
              scale={"2.6"}
              xChannelSelector={"R"}
              yChannelSelector={"G"}
            ></feDisplacementMap>
          </filter>
          <radialGradient id={"g-jolly"} cx={"42%"} cy={"32%"} r={"75%"}>
            <stop offset={"0"} stopColor={"#FFFDF8"}></stop>
            <stop offset={".55"} stopColor={"#F3EADB"}></stop>
            <stop offset={"1"} stopColor={"#D9C8AC"}></stop>
          </radialGradient>
          <radialGradient id={"g-alfred"} cx={"45%"} cy={"38%"} r={"70%"}>
            <stop offset={"0"} stopColor={"#FFEE7A"}></stop>
            <stop offset={".6"} stopColor={"#F7CD27"}></stop>
            <stop offset={"1"} stopColor={"#D9A307"}></stop>
          </radialGradient>
          <radialGradient id={"g-molty"} cx={"40%"} cy={"35%"} r={"70%"}>
            <stop offset={"0"} stopColor={"#FF7A66"}></stop>
            <stop offset={".6"} stopColor={"#EE3E2C"}></stop>
            <stop offset={"1"} stopColor={"#BF2316"}></stop>
          </radialGradient>
        </defs>
        <symbol id={"m-jolly"} viewBox={"0 0 100 100"}>
          <g filter={"url(#fuzz)"}>
            <ellipse
              cx={"17"}
              cy={"64"}
              rx={"7"}
              ry={"10"}
              transform={"rotate(28 17 64)"}
              fill={"url(#g-jolly)"}
            ></ellipse>
            <ellipse
              cx={"83"}
              cy={"64"}
              rx={"7"}
              ry={"10"}
              transform={"rotate(-28 83 64)"}
              fill={"url(#g-jolly)"}
            ></ellipse>
            <path
              d={
                "M50 7C72 7 81 25 81 45C81 53 80 59 83 65C87 74 85 92 69 94L31 94C15 92 13 74 17 65C20 59 19 53 19 45C19 25 28 7 50 7Z"
              }
              fill={"url(#g-jolly)"}
            ></path>
          </g>
          <ellipse
            cx={"34"}
            cy={"53"}
            rx={"6"}
            ry={"3.4"}
            fill={"#F2A79C"}
            opacity={".55"}
          ></ellipse>
          <ellipse
            cx={"66"}
            cy={"53"}
            rx={"6"}
            ry={"3.4"}
            fill={"#F2A79C"}
            opacity={".55"}
          ></ellipse>
          <circle cx={"40.5"} cy={"45"} r={"3.3"} fill={"#1B1B1B"}></circle>
          <circle cx={"59.5"} cy={"45"} r={"3.3"} fill={"#1B1B1B"}></circle>
          <path
            d={"M45 54Q50 59 55 54"}
            stroke={"#1B1B1B"}
            strokeWidth={"2"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
        </symbol>
        <symbol id={"m-alfred"} viewBox={"0 0 100 100"}>
          <path
            filter={"url(#fuzz)"}
            d={
              "M50 9C56 9 60 13 64 20L89 70C94 81 88 91 75 91L25 91C12 91 6 81 11 70L36 20C40 13 44 9 50 9Z"
            }
            fill={"url(#g-alfred)"}
          ></path>
          <circle
            cx={"39"}
            cy={"57"}
            r={"9.5"}
            fill={"rgba(255,255,255,.18)"}
            stroke={"#1D1D1D"}
            strokeWidth={"3"}
          ></circle>
          <circle
            cx={"61"}
            cy={"57"}
            r={"9.5"}
            fill={"rgba(255,255,255,.18)"}
            stroke={"#1D1D1D"}
            strokeWidth={"3"}
          ></circle>
          <path d={"M48.5 56H51.5"} stroke={"#1D1D1D"} strokeWidth={"3"}></path>
          <path
            d={"M34.5 58Q39 54.5 43.5 58M56.5 58Q61 54.5 65.5 58"}
            stroke={"#1D1D1D"}
            strokeWidth={"2.2"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
          <path
            d={"M50 78L37 71.5V84.5Z M50 78L63 71.5V84.5Z"}
            fill={"#1D1D1D"}
            stroke={"#1D1D1D"}
            strokeWidth={"2"}
            strokeLinejoin={"round"}
          ></path>
          <circle cx={"50"} cy={"78"} r={"3.6"} fill={"#1D1D1D"}></circle>
        </symbol>
        <symbol id={"m-clawd"} viewBox={"0 0 100 100"}>
          <g fill={"#D97757"} shapeRendering={"crispEdges"}>
            <rect x={"14"} y={"26"} width={"72"} height={"40"}></rect>
            <rect x={"5"} y={"42"} width={"9"} height={"9"}></rect>
            <rect x={"86"} y={"42"} width={"9"} height={"9"}></rect>
            <rect x={"22"} y={"66"} width={"8"} height={"15"}></rect>
            <rect x={"38"} y={"66"} width={"8"} height={"15"}></rect>
            <rect x={"54"} y={"66"} width={"8"} height={"15"}></rect>
            <rect x={"70"} y={"66"} width={"8"} height={"15"}></rect>
          </g>
          <rect
            x={"14"}
            y={"26"}
            width={"72"}
            height={"5"}
            fill={"#E68D6F"}
            shapeRendering={"crispEdges"}
          ></rect>
          <g fill={"#161616"} shapeRendering={"crispEdges"}>
            <rect x={"30"} y={"35"} width={"6"} height={"12"}></rect>
            <rect x={"64"} y={"35"} width={"6"} height={"12"}></rect>
          </g>
        </symbol>
        <symbol id={"m-cue"} viewBox={"0 0 100 100"}>
          <g fill={"#3E8EF7"}>
            <circle cx={"50"} cy={"54"} r={"31"}></circle>
            <circle cx={"50"} cy={"23"} r={"13"}></circle>
            <circle cx={"69.9"} cy={"30.3"} r={"13"}></circle>
            <circle cx={"80.5"} cy={"48.6"} r={"13"}></circle>
            <circle cx={"76.9"} cy={"69.5"} r={"13"}></circle>
            <circle cx={"60.6"} cy={"83.1"} r={"13"}></circle>
            <circle cx={"39.4"} cy={"83.1"} r={"13"}></circle>
            <circle cx={"23.1"} cy={"69.5"} r={"13"}></circle>
            <circle cx={"19.5"} cy={"48.6"} r={"13"}></circle>
            <circle cx={"30.1"} cy={"30.3"} r={"13"}></circle>
          </g>
          <circle cx={"39"} cy={"50"} r={"10.5"} fill={"#fff"}></circle>
          <circle cx={"61"} cy={"49"} r={"10.5"} fill={"#fff"}></circle>
          <circle cx={"35.5"} cy={"51.5"} r={"5.4"} fill={"#141414"}></circle>
          <circle cx={"57.5"} cy={"50.5"} r={"5.4"} fill={"#141414"}></circle>
          <path
            d={"M45 65Q50 69 55 65"}
            stroke={"#0F2E66"}
            strokeWidth={"2.4"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
        </symbol>
        <symbol id={"m-molty"} viewBox={"0 0 100 100"}>
          <g stroke={"#D3301F"} strokeWidth={"3.2"} fill={"none"} strokeLinecap={"round"}>
            <path d={"M43 31C40 19 34 13 27 9"}></path>
            <path d={"M57 31C60 19 66 13 73 9"}></path>
          </g>
          <circle cx={"27"} cy={"9"} r={"3.4"} fill={"#D3301F"}></circle>
          <circle cx={"73"} cy={"9"} r={"3.4"} fill={"#D3301F"}></circle>
          <path
            d={"M24 52Q9 53 7 39Q6 28 15 25Q14 33 20 35Q22 29 28 30Q32 39 24 52Z"}
            fill={"url(#g-molty)"}
          ></path>
          <path
            d={"M76 52Q91 53 93 39Q94 28 85 25Q86 33 80 35Q78 29 72 30Q68 39 76 52Z"}
            fill={"url(#g-molty)"}
          ></path>
          <rect x={"35"} y={"78"} width={"7"} height={"12"} rx={"3.5"} fill={"#C9281A"}></rect>
          <rect x={"58"} y={"78"} width={"7"} height={"12"} rx={"3.5"} fill={"#C9281A"}></rect>
          <circle cx={"50"} cy={"56"} r={"29"} fill={"url(#g-molty)"}></circle>
          <circle cx={"41"} cy={"52"} r={"4.4"} fill={"#161616"}></circle>
          <circle cx={"59"} cy={"52"} r={"4.4"} fill={"#161616"}></circle>
          <circle cx={"42.4"} cy={"50.6"} r={"1.4"} fill={"#fff"}></circle>
          <circle cx={"60.4"} cy={"50.6"} r={"1.4"} fill={"#fff"}></circle>
          <path
            d={"M45 63Q50 67 55 63"}
            stroke={"#6A0E07"}
            strokeWidth={"2.2"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
        </symbol>
        <symbol id={"m-grok"} viewBox={"16.5 16.5 59 59"}>
          <path
            d={
              "M74.68 46A28.68 28.68 0 0 0 46 17.32A28.68 28.68 0 0 0 17.32 46A28.68 28.68 0 0 0 46 74.68A28.68 28.68 0 0 0 74.68 46Z"
            }
            fill={"#141414"}
          ></path>
          <path
            d={
              "M41.34 54.23L41.74 53.99L42.08 53.72L42.31 53.49L42.52 53.23L42.76 52.86L42.97 52.44L43.11 52.01L43.19 51.59L43.22 51.17L43.21 50.74L43.14 49.47L43.11 48.62L43.06 47.34L43.04 46.48L43.01 45.19L42.99 44.34L42.98 43.05L42.98 42.2L42.97 41.78L42.92 41.35L42.81 40.93L42.65 40.51L42.58 40.36L42.43 40.1L42.16 39.74L41.94 39.49L41.7 39.27L41.34 39.01L41.08 38.86L40.93 38.79L40.52 38.63L40.11 38.54L39.69 38.49L39.28 38.49L38.87 38.54L38.45 38.64L38.04 38.79L37.62 39.01L37.41 39.15L37.12 39.38L36.79 39.7L36.69 39.81L36.53 40.02L36.38 40.24L36.14 40.66L35.94 41.21L35.86 41.52L35.8 41.94L35.78 42.37L35.77 43.65L35.77 44.5L35.79 45.79L35.8 46.64L35.85 47.93L35.88 48.78L35.95 50.06L36 50.91L36.04 51.33L36.13 51.75L36.27 52.17L36.46 52.59L36.7 52.98L36.88 53.21L37.15 53.52L37.59 53.89L37.8 54.03L38.02 54.16L38.45 54.36L38.87 54.49L39.29 54.57L39.71 54.6L40.12 54.59L40.53 54.52L40.93 54.4L41.34 54.23ZM55.31 53.66L55.7 53.87L56.08 54.03L56.46 54.12L56.85 54.17L57.24 54.17L57.63 54.11L58.02 54.01L58.42 53.85L58.82 53.64L59.02 53.5L59.22 53.34L59.63 52.95L59.88 52.63L60.04 52.39L60.26 51.98L60.43 51.56L60.55 51.13L60.63 50.71L60.65 50.28L60.69 49.43L60.71 48.15L60.71 47.3L60.69 46.01L60.67 45.15L60.61 43.87L60.55 43.02L60.45 41.74L60.4 41.32L60.31 40.89L60.22 40.59L59.98 40.06L59.72 39.64L59.57 39.43L59.4 39.23L59.3 39.13L58.96 38.82L58.67 38.61L58.46 38.49L58.05 38.29L57.65 38.16L57.25 38.08L56.86 38.05L56.47 38.07L56.08 38.14L55.7 38.26L55.33 38.44L55.19 38.52L54.96 38.68L54.64 38.95L54.43 39.19L54.24 39.44L54.02 39.82L53.9 40.08L53.84 40.24L53.72 40.67L53.65 41.1L53.63 41.52L53.65 41.94L53.72 42.79L53.79 44.08L53.83 44.93L53.87 46.22L53.89 47.08L53.89 48.36L53.89 49.21L53.86 50.49L53.85 50.91L53.89 51.33L53.98 51.75L54.12 52.17L54.32 52.58L54.56 52.94L54.76 53.18L54.98 53.4L55.31 53.66Z"
            }
            fill={"#fff"}
          ></path>
        </symbol>
        <symbol id={"m-instinct"} viewBox={"0 0 100 100"}>
          <g stroke={"#141414"} fill={"none"} strokeLinecap={"round"} strokeLinejoin={"round"}>
            <ellipse cx={"50"} cy={"17"} rx={"8.5"} ry={"7"} strokeWidth={"4.6"}></ellipse>
            <path d={"M50 25C49 39 51 49 50 60"} strokeWidth={"3.4"}></path>
            <path d={"M50 33C46 41 42 50 39.5 58"} strokeWidth={"2.6"}></path>
            <path d={"M50 33C54 41 57 48 60 56"} strokeWidth={"2.6"}></path>
            <path d={"M50 60C47 71 45 80 42 92"} strokeWidth={"3.1"}></path>
            <path d={"M50 60C53 71 55 81 58 92"} strokeWidth={"3.1"}></path>
          </g>
          <circle cx={"42"} cy={"92.5"} r={"2"} fill={"#141414"}></circle>
          <circle cx={"58"} cy={"92.5"} r={"2"} fill={"#141414"}></circle>
        </symbol>
      </svg>
      <WelcomeNavigation scrollTo={scrollTo} />
      <main id={"main"}>
        <section className={"stage-wrap"} id={"stageWrap"}>
          <div className={"stage"} id={"stage"}>
            <div
              className={"bloom flow-a"}
              style={
                {
                  width: "46vw",
                  height: "52vh",
                  left: "-10vw",
                  top: "52vh",
                  background: "#FFD2BC",
                  opacity: ".8",
                } as CSSProperties
              }
            ></div>
            <div
              className={"bloom flow-b"}
              style={
                {
                  width: "42vw",
                  height: "52vh",
                  right: "-8vw",
                  top: "46vh",
                  background: "#CFE2FF",
                  opacity: ".9",
                } as CSSProperties
              }
            ></div>
            <div
              className={"bloom flow-c"}
              style={
                {
                  width: "36vw",
                  height: "42vh",
                  left: "32vw",
                  top: "60vh",
                  background: "#E2D8FF",
                  opacity: ".8",
                } as CSSProperties
              }
            ></div>
            <div
              className={"bloom flow-d"}
              style={
                {
                  width: "30vw",
                  height: "34vh",
                  left: "14vw",
                  top: "-12vh",
                  background: "#FFEFC2",
                  opacity: ".7",
                } as CSSProperties
              }
            ></div>
            <div
              className={"bloom flow-e"}
              style={
                {
                  width: "26vw",
                  height: "30vh",
                  right: "12vw",
                  top: "-8vh",
                  background: "#D6F3E6",
                  opacity: ".6",
                } as CSSProperties
              }
            ></div>
            <div className={"hero-copy"} id={"hero"}>
              <h1 className={"h1"} style={{ "--d": ".2s" } as CSSProperties}>
                {"你的本地"}
                <br />
                {"Agent 工作台"}
              </h1>
              <p className={"lead"} style={{ "--d": ".34s" } as CSSProperties}>
                <span>{"从代码仓库、团队协作，到工作流和部署。"}</span>
                <span>
                  <mark className={"hl"} style={{ "--h": "1.1s" } as CSSProperties}>
                    {"在一个工作台里完成。"}
                  </mark>
                </span>
              </p>
              <div className={"aud"} id={"aud"} style={{ "--d": ".4s" } as CSSProperties}>
                <div className={"aud-track"}>
                  <div className={"aud-set"}>
                    {[
                      "Bot 对话",
                      "项目管理",
                      "编码",
                      "团队协作",
                      "会话中心",
                      "部署",
                      "工作流",
                      "自动化",
                      "技能",
                      "技术热榜",
                      "成长中心",
                      "磁盘空间",
                    ].map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                </div>
              </div>
              <div className={"send"} style={{ "--d": ".46s" } as CSSProperties}>
                <WelcomeActions scrollTo={scrollTo} />
              </div>
            </div>
            <div className={"beat"} id={"beat"}>
              <h2 className={"h2"}>{"一次发布，怎么开始？"}</h2>
            </div>
            <div className={"side"} id={"side"}>
              <h2 className={"h2"}>
                {"先看代码，"}
                <br />
                {"再核对改动。"}
              </h2>
            </div>
            <div className={"side"} id={"side2"}>
              <h2 className={"h2"}>
                {"从改动记录，"}
                <br />
                {"到发布决定。"}
              </h2>
              <p className={"lead"}>{"把代码、验证结果和待办放在一起，判断下一步。"}</p>
            </div>
            <div className={"chat"} id={"chat"}>
              <div className={"chat-head"}>
                <div>
                  <div className={"gn"}>{"发布前检查"}</div>
                  <div className={"gm"}>{"项目演示 · 搜索功能变更"}</div>
                </div>
                <div className={"stack"} id={"slots"}>
                  <div className={"slot av-instinct"}>
                    <svg>
                      <use href={"#m-instinct"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-grok"}>
                    <svg>
                      <use href={"#m-grok"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-alfred"}>
                    <svg>
                      <use href={"#m-alfred"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-clawd"}>
                    <svg>
                      <use href={"#m-clawd"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-molty"}>
                    <svg>
                      <use href={"#m-molty"}></use>
                    </svg>
                  </div>
                  <div className={"slot av-cue"}>
                    <svg>
                      <use href={"#m-cue"}></use>
                    </svg>
                  </div>
                </div>
              </div>
              <div className={"vp"} id={"vp"}>
                <div className={"list"} id={"list"}>
                  <div className={"msg"} data-a={"molty"}>
                    <div className={"av av-molty"}>
                      <svg>
                        <use href={"#m-molty"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"项目梳理 "}
                        <span>{"19:02"}</span>
                      </div>
                      <div className={"bub"}>
                        {
                          "这次改的是会话搜索。我找到了查询入口和结果列表，先确认哪些路径会受到影响。"
                        }
                      </div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"jolly"}>
                    <div className={"av av-jolly"}>
                      <svg>
                        <use href={"#m-jolly"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"源码导读 "}
                        <span>{"19:03"}</span>
                      </div>
                      <div className={"pic"}>
                        <img src={codePreview} alt={"编码工作台中的项目源码导读"} />
                        <span>{"编码工作台 · 代码上下文"}</span>
                      </div>
                      <div className={"bub"}>{"查询和展示在两个模块，最好分别验证。"}</div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"clawd"}>
                    <div className={"av av-clawd"}>
                      <svg>
                        <use href={"#m-clawd"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"代码核对 "}
                        <span>{"19:05"}</span>
                      </div>
                      <div className={"bub"}>
                        {"还有空结果的情况。把它加到发布前的验证步骤里。"}
                      </div>
                      <div className={"pic"}>
                        <img src={workflowPreview} alt={"工作流画布中的步骤连线"} />
                        <span>{"工作流 · 验证步骤"}</span>
                      </div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"molty"}>
                    <div className={"av av-molty"}>
                      <svg>
                        <use href={"#m-molty"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"项目梳理 "}
                        <span>{"19:06"}</span>
                      </div>
                      <div className={"bub"}>{"已补上，和正常命中一起检查。"}</div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"alfred"}>
                    <div className={"av av-alfred"}>
                      <svg>
                        <use href={"#m-alfred"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"测试设计 "}
                        <span>{"19:07"}</span>
                      </div>
                      <div className={"bub"}>{"我会从同一个项目分别搜索已有词和不存在的词。"}</div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"instinct"}>
                    <div className={"av av-instinct"}>
                      <svg>
                        <use href={"#m-instinct"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"回归检查 "}
                        <span>{"19:09"}</span>
                      </div>
                      <div className={"bub"}>
                        <div className={"quote"}>{"代码核对：记得验证空结果"}</div>
                        {"两个场景的结果都和预期一致。"}
                      </div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"grok"}>
                    <div className={"av av-grok"}>
                      <svg>
                        <use href={"#m-grok"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"发布整理 "}
                        <span>{"19:09"}</span>
                      </div>
                      <div className={"bub"}>
                        {"同意。"}
                        <span className={"at"}>{"@代码核对"}</span>
                        {" 帮我列一下发布前还要看什么？"}
                      </div>
                    </div>
                  </div>
                  <div className={"msg"} data-a={"clawd"}>
                    <div className={"av av-clawd"}>
                      <svg>
                        <use href={"#m-clawd"}></use>
                      </svg>
                    </div>
                    <div>
                      <div className={"who"}>
                        {"代码核对 "}
                        <span>{"19:10"}</span>
                      </div>
                      <div className={"bub"}>
                        {"搜索路径已经核对。下一步是确认目标环境，再决定是否执行部署。"}
                      </div>
                    </div>
                  </div>
                  <div className={"typing"} id={"typing"}>
                    <div className={"av"} id={"typingAv"}>
                      <svg>
                        <use href={"#m-jolly"}></use>
                      </svg>
                    </div>
                    <div className={"dots"}>
                      <i></i>
                      <i></i>
                      <i></i>
                    </div>
                  </div>
                </div>
              </div>
              <div className={"agents-only"}>
                <svg
                  width={"16"}
                  height={"16"}
                  viewBox={"0 0 24 24"}
                  fill={"none"}
                  stroke={"currentColor"}
                  strokeWidth={"1.8"}
                  strokeLinecap={"round"}
                  strokeLinejoin={"round"}
                >
                  <path d={"M4 20h4L19 9l-4-4L4 16z"}></path>
                  <path d={"M14 6l4 4"}></path>
                </svg>
                {"补充项目背景…"}
              </div>
            </div>
            <div className={"dm-cap"} id={"dmCap"}>
              <i></i>
              {"项目交接示例"}
            </div>
            <div className={"dm"} id={"dm"}>
              <div className={"dm-head"}>
                <div
                  className={"av av-jolly"}
                  style={{ width: "34px", height: "34px" } as CSSProperties}
                >
                  <svg style={{ width: "26px", height: "26px" } as CSSProperties}>
                    <use href={"#m-jolly"}></use>
                  </svg>
                </div>
                {"项目助手"}
                <small>{"私聊"}</small>
              </div>
              <div className={"dm-body"} id={"dmBody"}>
                <div className={"dm-time"}>{"18:58"}</div>
                <div className={"dmsg mine"}>
                  <div className={"b"}>{"可以准备发布了吗？先帮我看看这次改动。"}</div>
                </div>
                <div className={"dmsg"}>
                  <div className={"av av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"b"}>{"我把源码位置、验证步骤和待确认项整理在一起。"}</div>
                </div>
                <div className={"dm-time later"} data-t={".875"}>
                  {"19:10"}
                </div>
                <div className={"dmsg later"} data-t={".905"} data-agent={"1"}>
                  <div className={"av av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"b b-card"}>
                    <img src={codePreview} alt={"编码工作台中的项目源码导读"} />
                    <div className={"cap2"}>
                      <b>{"会话搜索 · 发布前核对"}</b>
                      <small>{"正常命中和空结果已核对"}</small>
                    </div>
                    <div className={"q2"}>
                      {"搜索验证已完成。先到预览环境检查，还是直接安排发布？"}
                    </div>
                  </div>
                </div>
                <div className={"dmsg mine later"} data-t={".935"}>
                  <div className={"b"}>{"先检查预览环境。"}</div>
                </div>
                <div className={"dmsg later"} data-t={".965"} data-agent={"1"}>
                  <div className={"av av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"b b-ok"}>
                    <span className={"ok"}>{"✓"}</span>
                    <div>
                      <b>{"记下了"}</b>
                      <small>{"下一步：检查预览环境"}</small>
                    </div>
                  </div>
                </div>
                <div className={"dm-typing"} id={"dmTyping"}>
                  <div className={"av av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"dots"}>
                    <i></i>
                    <i></i>
                    <i></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <FeatureShowcase />
        <section className={"sec"} id={"how"}>
          <div className={"wrap"}>
            <div className={"sec-head"}>
              <span className={"eyebrow"} data-r="">
                {"怎么用"}
              </span>
              <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                {"三步就能开始。"}
              </h2>
            </div>
            {import.meta.env.MODE === "welcome" && (
              <section
                id="install"
                className="workbench-install"
                tabIndex={-1}
                aria-labelledby="install-title"
              >
                <div>
                  <h3 id="install-title">安装并打开工作台</h3>
                  <p>
                    在电脑上准备好 Node.js 22.12 或更高版本和
                    Git，打开终端运行下面两行命令。已安装的用户只需运行第二行，工作台会在浏览器中打开。
                  </p>
                </div>
                <pre>
                  <code>{"npm install -g chuxin-agentdesk\nagentdesk web"}</code>
                </pre>
              </section>
            )}
            <div className={"grid3"} style={{ marginTop: "60px" } as CSSProperties}>
              <div data-r="" style={{ "--d": ".05s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"step-card c1"}
                    style={
                      { background: "linear-gradient(165deg,#FFF5EE,#FFE1CF)" } as CSSProperties
                    }
                  >
                    <div className={"n"}>{"1"}</div>
                    <h3>{"连接模型"}</h3>
                    <p>{"在设置中填写模型地址和凭据，然后发起一次 Bot 对话。"}</p>
                    <div className={"panel"}>
                      <div className={"me"}>
                        {"选择已配置模型，"}
                        <span style={{ whiteSpace: "nowrap" } as CSSProperties}>{"开始对话"}</span>
                      </div>
                      <div className={"slot2"}>
                        <div className={"tp"}>
                          <div className={"av av-jolly"}>
                            <svg>
                              <use href={"#m-jolly"}></use>
                            </svg>
                          </div>
                          <div className={"dots"}>
                            <i></i>
                            <i></i>
                            <i></i>
                          </div>
                        </div>
                        <div className={"rp"}>
                          <div className={"av av-jolly"}>
                            <svg>
                              <use href={"#m-jolly"}></use>
                            </svg>
                          </div>
                          <div className={"bub"}>{"准备好了，想先处理什么？"}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div data-r="" style={{ "--d": ".15s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"step-card c3"}
                    style={
                      { background: "linear-gradient(165deg,#F6F3FF,#E3DBFF)" } as CSSProperties
                    }
                  >
                    <div className={"n"}>{"2"}</div>
                    <h3>{"打开项目"}</h3>
                    <p>{"在设置里添加项目文件夹，然后在项目列表中打开要处理的代码库。"}</p>
                    <div className={"panel"}>
                      <div className={"link"}>
                        <span>{"项目路径 · ~/work/demo"}</span>
                        <span className={"cp"}>
                          <span className={"a"}>{"复制"}</span>
                          <span className={"b"}>{"已复制"}</span>
                        </span>
                      </div>
                      <div className={"joined"} style={{ "--t": "1.35s" } as CSSProperties}>
                        <div className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </div>
                        {"已找到 Git 仓库"}
                      </div>
                      <div className={"pub"} style={{ "--t": "1.8s" } as CSSProperties}>
                        <span className={"pg"}>{"🔍"}</span>
                        <div className={"pt"}>
                          <b>{"仓库源码导读"}</b>
                          <small>{"查看入口文件和目录结构"}</small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div data-r="" style={{ "--d": ".25s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"step-card c4"}
                    style={
                      { background: "linear-gradient(165deg,#F1F8FF,#D6E9FF)" } as CSSProperties
                    }
                  >
                    <div className={"n"}>{"3"}</div>
                    <h3>{"运行第一个任务"}</h3>
                    <p>{"描述要完成的改动，查看执行过程，在需要授权时确认操作。"}</p>
                    <div className={"panel"}>
                      <div className={"strip"}>
                        <div className={"stack mini"}>
                          <div className={"av av-grok"}>
                            <svg>
                              <use href={"#m-grok"}></use>
                            </svg>
                          </div>
                          <div className={"av av-alfred"}>
                            <svg>
                              <use href={"#m-alfred"}></use>
                            </svg>
                          </div>
                          <div className={"av av-jolly"}>
                            <svg>
                              <use href={"#m-jolly"}></use>
                            </svg>
                          </div>
                          <div className={"av av-clawd"}>
                            <svg>
                              <use href={"#m-clawd"}></use>
                            </svg>
                          </div>
                          <div className={"av av-molty"}>
                            <svg>
                              <use href={"#m-molty"}></use>
                            </svg>
                          </div>
                        </div>
                        <div className={"st"}>
                          <b>{"发布前检查"}</b>
                          <small>
                            <i className={"live"}></i>
                            {"讨论中"}
                          </small>
                        </div>
                      </div>
                      <div className={"ask"}>
                        <div className={"av av-jolly"}>
                          <svg>
                            <use href={"#m-jolly"}></use>
                          </svg>
                        </div>
                        <div className={"bub2"}>
                          {"已经准备好运行项目检查。"}
                          <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                            {"现在执行吗？"}
                          </span>
                          <div className={"btns"}>
                            <span className={"y"}>{"同意"}</span>
                            <span>{"再想想"}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className={"sec"} id={"privacy"}>
          <div className={"wrap"}>
            <div className={"pv-head"}>
              <div>
                <span className={"eyebrow"} data-r="">
                  {"数据与权限"}
                </span>
                <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                  {"在本地工作，由你授权。"}
                </h2>
              </div>
              <p className={"lead"} data-r="" style={{ "--d": ".16s" } as CSSProperties}>
                {"仓库、会话和执行记录各有去处。"}
                <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                  {"模型服务和操作权限由你配置。"}
                </span>
              </p>
            </div>
            <div className={"pv-grid"}>
              <div className={"pv-a"} data-r="" style={{ "--d": ".05s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"pv-card"}
                    style={
                      {
                        background: "linear-gradient(170deg,#FBF8FF 0%,#F1ECFF 100%)",
                      } as CSSProperties
                    }
                  >
                    <p className={"pv-t"}>
                      <b>{"看清信息去向。"}</b>
                      {"模型根据任务上下文生成回答，调用会发送到你配置的服务。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <div className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </div>
                        <span>{"任务示例 · 发布前检查"}</span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"任务描述"}</span>
                        <span className={"pv-s ok"}>
                          <svg
                            width={"14"}
                            height={"14"}
                            viewBox={"0 0 24 24"}
                            fill={"none"}
                            stroke={"currentColor"}
                            strokeWidth={"2.6"}
                            strokeLinecap={"round"}
                            strokeLinejoin={"round"}
                          >
                            <path d={"M5 12.5l4.5 4.5L19 7.5"}></path>
                          </svg>
                          {"提供给模型"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"引用的材料"}</span>
                        <span className={"pv-s ok"}>
                          <svg
                            width={"14"}
                            height={"14"}
                            viewBox={"0 0 24 24"}
                            fill={"none"}
                            stroke={"currentColor"}
                            strokeWidth={"2.6"}
                            strokeLinecap={"round"}
                            strokeLinejoin={"round"}
                          >
                            <path d={"M5 12.5l4.5 4.5L19 7.5"}></path>
                          </svg>
                          {"提供给模型"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "2" } as CSSProperties}>
                        <span className={"pv-l"}>{"讨论记录"}</span>
                        <span className={"pv-s lk"}>
                          <svg
                            width={"14"}
                            height={"14"}
                            viewBox={"0 0 24 24"}
                            fill={"none"}
                            stroke={"currentColor"}
                            strokeWidth={"2"}
                            strokeLinecap={"round"}
                            strokeLinejoin={"round"}
                          >
                            <rect x={"4"} y={"10"} width={"16"} height={"11"} rx={"2"}></rect>
                            <path d={"M8 10V7a4 4 0 0 1 8 0v3"}></path>
                          </svg>
                          {"保存在本地"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "3" } as CSSProperties}>
                        <span className={"pv-l"}>{"模型请求内容"}</span>
                        <span className={"pv-s lk"}>
                          <svg
                            width={"14"}
                            height={"14"}
                            viewBox={"0 0 24 24"}
                            fill={"none"}
                            stroke={"currentColor"}
                            strokeWidth={"2"}
                            strokeLinecap={"round"}
                            strokeLinejoin={"round"}
                          >
                            <rect x={"4"} y={"10"} width={"16"} height={"11"} rx={"2"}></rect>
                            <path d={"M8 10V7a4 4 0 0 1 8 0v3"}></path>
                          </svg>
                          {"按上下文发送"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "4" } as CSSProperties}>
                        <span className={"pv-l"}>{"Provider 认证"}</span>
                        <span className={"pv-s lk"}>
                          <svg
                            width={"14"}
                            height={"14"}
                            viewBox={"0 0 24 24"}
                            fill={"none"}
                            stroke={"currentColor"}
                            strokeWidth={"2"}
                            strokeLinecap={"round"}
                            strokeLinejoin={"round"}
                          >
                            <rect x={"4"} y={"10"} width={"16"} height={"11"} rx={"2"}></rect>
                            <path d={"M8 10V7a4 4 0 0 1 8 0v3"}></path>
                          </svg>
                          {"调用时认证"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className={"pv-b"} data-r="" style={{ "--d": ".15s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"pv-card"}
                    style={
                      {
                        background: "linear-gradient(170deg,#FFF8F3 0%,#FFEDE2 100%)",
                      } as CSSProperties
                    }
                  >
                    <p className={"pv-t"}>
                      <b>{"检查执行请求。"}</b>
                      {"需要审批的操作会显示待执行内容，确认后再继续。"}
                    </p>
                    <div className={"pv-ask"}>
                      <div className={"av av-jolly"}>
                        <svg>
                          <use href={"#m-jolly"}></use>
                        </svg>
                      </div>
                      <div className={"pv-bub"}>
                        <div className={"pv-who"}>
                          {"项目助手 "}
                          <span>{"刚刚"}</span>
                        </div>
                        {"允许执行这次部署操作？"}
                        <div className={"pv-btns"}>
                          <span className={"y"}>{"同意"}</span>
                          <span>{"再想想"}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className={"pv-c"} data-r="" style={{ "--d": ".25s" } as CSSProperties}>
                <div className={"lift"}>
                  <div
                    className={"pv-card"}
                    style={
                      {
                        background: "linear-gradient(170deg,#F4F9FF 0%,#E3EFFF 100%)",
                      } as CSSProperties
                    }
                  >
                    <p className={"pv-t"}>
                      <b>{"找回工作记录。"}</b>
                      {"用会话中心的搜索定位历史记录，查看当时的上下文。"}
                    </p>
                    <div className={"pv-mail"}>
                      <div className={"pv-mrow"}>
                        <span className={"pv-dot"}></span>
                        <div className={"pv-logo"}>
                          <img width="22" height="22" src="/agentdesk.svg" alt="" />
                        </div>
                        <div className={"pv-mt"}>
                          <b>{"AgentDesk"}</b>
                          <span>{"找到「发布前检查」的会话记录"}</span>
                        </div>
                        <small>{"刚刚"}</small>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className={"sec"} id={"faq"} style={{ paddingTop: "140px" } as CSSProperties}>
          <div className={"wrap faq-wrap"}>
            <div className={"faq-head"}>
              <span className={"eyebrow"} data-r="">
                {"常见问题"}
              </span>
              <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                {"关于 AgentDesk 的问题"}
              </h2>
            </div>
            <div className={"faq-list"}>
              {questions.map(([question, answer]) => (
                <details className="qa" key={question} data-r="">
                  <summary>
                    <h3>{question}</h3>
                    <span className="pm" aria-hidden="true" />
                  </summary>
                  <div className="ans">
                    <p>{answer}</p>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>
        <section
          className={"sec final"}
          id={"final"}
          style={{ position: "relative" } as CSSProperties}
        >
          <div
            className={"bloom drift-a"}
            style={
              {
                width: "900px",
                height: "520px",
                left: "calc(50% - 450px)",
                top: "110px",
                background: "#EDE6FF",
                opacity: ".7",
              } as CSSProperties
            }
          ></div>
          <div
            className={"bloom drift-b"}
            style={
              {
                width: "520px",
                height: "420px",
                left: "calc(50% - 680px)",
                top: "250px",
                background: "#FFE3D3",
                opacity: ".6",
              } as CSSProperties
            }
          ></div>
          <div
            className={"bloom drift-c"}
            style={
              {
                width: "520px",
                height: "420px",
                left: "calc(50% + 180px)",
                top: "230px",
                background: "#D9EAFF",
                opacity: ".7",
              } as CSSProperties
            }
          ></div>
          <div className={"wrap"}>
            <div className={"row"} data-r="">
              <svg width={"52"} height={"52"} style={{ "--i": "0" } as CSSProperties}>
                <use href={"#m-instinct"}></use>
              </svg>
              <svg width={"48"} height={"48"} style={{ "--i": "1" } as CSSProperties}>
                <use href={"#m-grok"}></use>
              </svg>
              <svg width={"58"} height={"58"} style={{ "--i": "2" } as CSSProperties}>
                <use href={"#m-alfred"}></use>
              </svg>
              <svg width={"68"} height={"68"} style={{ "--i": "3" } as CSSProperties}>
                <use href={"#m-jolly"}></use>
              </svg>
              <svg width={"54"} height={"54"} style={{ "--i": "4" } as CSSProperties}>
                <use href={"#m-clawd"}></use>
              </svg>
              <svg width={"58"} height={"58"} style={{ "--i": "5" } as CSSProperties}>
                <use href={"#m-molty"}></use>
              </svg>
              <svg width={"56"} height={"56"} style={{ "--i": "6" } as CSSProperties}>
                <use href={"#m-cue"}></use>
              </svg>
            </div>
            <h2 className={"h2"} data-r="" style={{ "--d": ".1s" } as CSSProperties}>
              {"打开你的 AgentDesk。"}
            </h2>
            <div className={"send"} data-r="" style={{ "--d": ".2s" } as CSSProperties}>
              <WelcomeActions scrollTo={scrollTo} />
            </div>
          </div>
        </section>
      </main>
      <footer className={"site-foot"}>
        <div className={"foot"}>
          <div className="foot-cols" data-r="">
            <div>
              <p className="fh">工作台</p>
              <p>
                <WelcomeLink to="/">Bot 对话</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/projects">项目</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/session-hub">会话中心</WelcomeLink>
              </p>
            </div>
            <div>
              <p className="fh">开发与交付</p>
              <p>
                <WelcomeLink to="/code">编码</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/team">团队开发</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/deploy">部署</WelcomeLink>
              </p>
            </div>
            <div>
              <p className="fh">探索</p>
              <p>
                <WelcomeLink to="/workflows">工作流</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/automations">自动化</WelcomeLink>
              </p>
              <p>
                <WelcomeLink to="/learning">成长中心</WelcomeLink>
              </p>
            </div>
            <div>
              <p className="fh">关于 AgentDesk</p>
              {(
                [
                  ["cases", "功能总览"],
                  ["privacy", "数据与权限"],
                  ["faq", "常见问题"],
                ] as const
              ).map(([id, label]) => (
                <p key={id}>
                  <button
                    className="welcome-scroll-link"
                    type="button"
                    onClick={() => scrollTo(id)}
                  >
                    {label}
                  </button>
                </p>
              ))}
            </div>
          </div>
          <div className={"wordmark"} id={"wordmark"}>
            <span className={"big"}>
              <span style={{ "--i": "0" } as CSSProperties}>{"A"}</span>
              <span style={{ "--i": "1" } as CSSProperties}>{"g"}</span>
              <span style={{ "--i": "2" } as CSSProperties}>{"e"}</span>
              <span style={{ "--i": "3" } as CSSProperties}>{"n"}</span>
              <span style={{ "--i": "4" } as CSSProperties}>{"t"}</span>
              <span style={{ "--i": "5" } as CSSProperties}>{"D"}</span>
              <span style={{ "--i": "6" } as CSSProperties}>{"e"}</span>
              <span style={{ "--i": "7" } as CSSProperties}>{"s"}</span>
              <span style={{ "--i": "8" } as CSSProperties}>{"k"}</span>
            </span>
            <span className={"tag2"}>{"本地 Agent 工作台。"}</span>
          </div>
        </div>
      </footer>
    </>
  );
}
