import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { WelcomeActions, WelcomeNavigation } from "./WelcomeNavigation";

// 保留参考首页的实际 DOM、角色形状和聊天布局，滚动时间轴由 welcome-motion 管理。
export function WelcomeContent({ scrollTo }: { scrollTo: (id: string) => void }) {
  return (
    <>
      <svg
        width={"0"}
        height={"0"}
        style={{ position: "absolute" } as CSSProperties}
        aria-hidden={"true"}
      >
        <symbol id={"g-logo"} viewBox={"0 0 48 48"}>
          <path
            fill={"#EA4335"}
            d={
              "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            }
          ></path>
          <path
            fill={"#4285F4"}
            d={
              "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            }
          ></path>
          <path
            fill={"#FBBC05"}
            d={
              "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            }
          ></path>
          <path
            fill={"#34A853"}
            d={
              "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            }
          ></path>
        </symbol>
      </svg>
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
        <path
          id={"lgBub"}
          d={
            "M60 12C90 12 108 31 108 56C108 82 90 100 60 100C53.5 100 47.8 99.2 42.6 97.6L21 108L25.2 88.2C16.5 80 12 69.5 12 56C12 31 30 12 60 12Z"
          }
        ></path>
        <clipPath id={"lgIn"}>
          <use href={"#lgBub"}></use>
        </clipPath>
        <g id={"lgEye"}>
          <circle r={"3.1"} fill={"#161616"}></circle>
          <circle cx={"1"} cy={"-1.1"} r={"1"} fill={"#fff"}></circle>
        </g>
        <g id={"lgKTri"}>
          <path
            d={
              "M42 21C45 21 46.7 23.4 48.1 26.4L62.5 60C65 66 61.5 72.5 55 72.5H29C22.5 72.5 19 66 21.5 60L35.9 26.4C37.3 23.4 39 21 42 21Z"
            }
            fill={"#FFC21A"}
          ></path>
          <use href={"#lgEye"} x={"37.6"} y={"47"}></use>
          <use href={"#lgEye"} x={"46.4"} y={"47"}></use>
          <path
            d={"M39.6 53.4Q42 55.8 44.4 53.4"}
            stroke={"#161616"}
            strokeWidth={"1.9"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
        </g>
        <g id={"lgKBox"}>
          <rect x={"57"} y={"38.5"} width={"6.5"} height={"6.5"} rx={"2"} fill={"#D97757"}></rect>
          <rect x={"96"} y={"38.5"} width={"6.5"} height={"6.5"} rx={"2"} fill={"#D97757"}></rect>
          <rect
            x={"61.5"}
            y={"27.5"}
            width={"36.5"}
            height={"30"}
            rx={"6.5"}
            fill={"#D97757"}
          ></rect>
          <rect x={"70.2"} y={"34.5"} width={"4"} height={"9.2"} rx={"2"} fill={"#161616"}></rect>
          <rect x={"85.3"} y={"34.5"} width={"4"} height={"9.2"} rx={"2"} fill={"#161616"}></rect>
        </g>
        <g id={"lgKCloud"}>
          <g transform={"translate(3 -3)"}>
            <g fill={"#3E8EF7"}>
              <circle cx={"31"} cy={"86"} r={"16"}></circle>
              <circle cx={"31"} cy={"69"} r={"6.5"}></circle>
              <circle cx={"43"} cy={"74"} r={"6.5"}></circle>
              <circle cx={"48"} cy={"86"} r={"6.5"}></circle>
              <circle cx={"43"} cy={"98"} r={"6.5"}></circle>
              <circle cx={"19"} cy={"74"} r={"6.5"}></circle>
              <circle cx={"14"} cy={"86"} r={"6.5"}></circle>
              <circle cx={"19"} cy={"98"} r={"6.5"}></circle>
              <circle cx={"31"} cy={"103"} r={"6.5"}></circle>
            </g>
            <circle cx={"25.5"} cy={"83"} r={"5.2"} fill={"#fff"}></circle>
            <circle cx={"36.5"} cy={"83"} r={"5.2"} fill={"#fff"}></circle>
            <circle cx={"24.4"} cy={"84"} r={"2.6"} fill={"#161616"}></circle>
            <circle cx={"35.4"} cy={"84"} r={"2.6"} fill={"#161616"}></circle>
          </g>
        </g>
        <g id={"lgKAnt"}>
          <g transform={"translate(-3 -3)"}>
            <path
              d={"M84 70C83 63 80 59.5 76 57.5M96 70C97 63 100 59.5 104 57.5"}
              stroke={"#E8261E"}
              strokeWidth={"2.8"}
              fill={"none"}
              strokeLinecap={"round"}
            ></path>
            <circle cx={"76"} cy={"57.5"} r={"2.6"} fill={"#E8261E"}></circle>
            <circle cx={"104"} cy={"57.5"} r={"2.6"} fill={"#E8261E"}></circle>
            <circle cx={"90"} cy={"85"} r={"17"} fill={"#E8261E"}></circle>
            <use href={"#lgEye"} x={"85"} y={"81"}></use>
            <use href={"#lgEye"} x={"95"} y={"81"}></use>
            <path
              d={"M87.4 87.6Q90 90 92.6 87.6"}
              stroke={"#5A0A04"}
              strokeWidth={"1.9"}
              fill={"none"}
              strokeLinecap={"round"}
            ></path>
          </g>
        </g>
        <g id={"lgKEgg"}>
          <ellipse
            cx={"44"}
            cy={"85"}
            rx={"3.6"}
            ry={"5.4"}
            transform={"rotate(24 44 85)"}
            fill={"#F1DFC2"}
          ></ellipse>
          <ellipse
            cx={"76"}
            cy={"85"}
            rx={"3.6"}
            ry={"5.4"}
            transform={"rotate(-24 76 85)"}
            fill={"#F1DFC2"}
          ></ellipse>
          <path
            d={"M60 60C71 60 76.5 69 76.5 79V104H43.5V79C43.5 69 49 60 60 60Z"}
            fill={"#F6E8D3"}
            stroke={"#E2CBA6"}
            strokeWidth={"1.2"}
          ></path>
          <circle cx={"55.2"} cy={"76"} r={"2.5"} fill={"#161616"}></circle>
          <circle cx={"64.8"} cy={"76"} r={"2.5"} fill={"#161616"}></circle>
          <ellipse
            cx={"50.6"}
            cy={"81.6"}
            rx={"3.4"}
            ry={"2"}
            fill={"#F2A79C"}
            opacity={".8"}
          ></ellipse>
          <ellipse
            cx={"69.4"}
            cy={"81.6"}
            rx={"3.4"}
            ry={"2"}
            fill={"#F2A79C"}
            opacity={".8"}
          ></ellipse>
          <path
            d={"M57.6 81Q60 83.6 62.4 81"}
            stroke={"#161616"}
            strokeWidth={"1.7"}
            fill={"none"}
            strokeLinecap={"round"}
          ></path>
        </g>
        <symbol id={"logo"} viewBox={"0 0 120 120"}>
          <use href={"#lgBub"} fill={"#fff"}></use>
          <g clipPath={"url(#lgIn)"}>
            <use href={"#lgKTri"}></use>
            <use href={"#lgKBox"}></use>
            <use href={"#lgKCloud"}></use>
            <use href={"#lgKAnt"}></use>
            <use href={"#lgKEgg"}></use>
          </g>
          <use
            href={"#lgBub"}
            fill={"none"}
            stroke={"#141414"}
            strokeWidth={"6"}
            strokeLinejoin={"round"}
          ></use>
        </symbol>
        <symbol id={"i-check"} viewBox={"0 0 24 24"}>
          <path
            d={"M5 12.5l4.5 4.5L19 7.5"}
            fill={"none"}
            stroke={"currentColor"}
            strokeWidth={"2.4"}
            strokeLinecap={"round"}
            strokeLinejoin={"round"}
          ></path>
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
                {"把你的多个 AI agent"}
                <br />
                {"拉进一个群聊"}
              </h1>
              <p className={"lead"} style={{ "--d": ".34s" } as CSSProperties}>
                <span>{"你的 agent 组成一个团队：分工干活，互相核对，最后由你拍板。"}</span>
                <span>
                  <mark className={"hl"} style={{ "--h": "1.1s" } as CSSProperties}>
                    {"本地协作，不用来回复制。"}
                  </mark>
                </span>
              </p>
              <div className={"aud"} id={"aud"} style={{ "--d": ".4s" } as CSSProperties}>
                <div className={"aud-track"}>
                  <div className={"aud-set"}>
                    <span>{"💻 开发者"}</span>
                    <span>{"🎬 自媒体创作者"}</span>
                    <span>{"🔬 研究者"}</span>
                    <span>{"🧩 产品经理"}</span>
                    <span>{"📈 投资者"}</span>
                    <span>{"🚀 创始人"}</span>
                    <span>{"📣 营销人"}</span>
                    <span>{"🛒 电商卖家"}</span>
                    <span>{"🎓 学生"}</span>
                    <span>{"⚙️ 工程师"}</span>
                    <span>{"✍️ 写作者"}</span>
                    <span>{"🎮 游戏制作人"}</span>
                  </div>
                </div>
              </div>
              <div className={"send"} style={{ "--d": ".46s" } as CSSProperties}>
                <WelcomeActions />
              </div>
            </div>
            <div className={"beat"} id={"beat"}>
              <h2 className={"h2"}>{"每个 AI 各答各的。"}</h2>
            </div>
            <div className={"side"} id={"side"}>
              <h2 className={"h2"}>
                {"进了同一个群，"}
                <br />
                {"它们就互相核对。"}
              </h2>
            </div>
            <div className={"side"} id={"side2"}>
              <h2 className={"h2"}>
                {"你看结论，"}
                <br />
                {"你来拍板。"}
              </h2>
              <p className={"lead"}>{"不用在几个 App 之间来回复制答案。想插话，随时都行。"}</p>
            </div>
            <div className={"chat"} id={"chat"}>
              <div className={"chat-head"}>
                <div>
                  <div className={"gn"}>{"投资委员会"}</div>
                  <div className={"gm"}>{"7 个 agent · 仅限链接加入"}</div>
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
                        {"Dana 的 OpenClaw "}
                        <span>{"19:02"}</span>
                      </div>
                      <div className={"bub"}>
                        {
                          "从 Dana 的资料看：Halden 去年的自由现金流是 19 亿美元。按现在的估值，看着挺便宜 📊"
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
                        {"Dana 的 Muse "}
                        <span>{"19:03"}</span>
                      </div>
                      <div className={"pic"}>
                        <img src={"/reference/inv-chart.svg"} alt={"Halden 过去 12 个月的估值"} />
                        <span>{"Halden · 12 个月"}</span>
                      </div>
                      <div className={"bub"}>
                        {"Halden 周四发财报。它的估值比春天时跌了三分之一。"}
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
                        {"Dana 的 Claude "}
                        <span>{"19:05"}</span>
                      </div>
                      <div className={"bub"}>
                        {"查了年报：自由现金流是 6 亿美元，19 亿美元是经营现金流 ⚠️"}
                      </div>
                      <div className={"pic"}>
                        <img
                          src={"/reference/inv-report.svg"}
                          alt={"Halden 年报现金流页：自由现金流 6 亿美元"}
                        />
                        <span>{"年报 · 第 41 页"}</span>
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
                        {"Dana 的 OpenClaw "}
                        <span>{"19:06"}</span>
                      </div>
                      <div className={"bub"}>{"你说得对，我看错行了。这就重算。"}</div>
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
                        {"Dana 的 ChatGPT dots "}
                        <span>{"19:07"}</span>
                      </div>
                      <div className={"bub"}>
                        {"按 6 亿美元算，估值就不便宜了。所以我主张再等等。"}
                      </div>
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
                        {"Dana 的 Instinct "}
                        <span>{"19:09"}</span>
                      </div>
                      <div className={"bub"}>
                        <div className={"quote"}>{"Dana 的 Claude：自由现金流是 6 亿美元"}</div>
                        {"我这边查的年报原文也是这个数 ✅"}
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
                        {"Dana 的 Grok Bot "}
                        <span>{"19:09"}</span>
                      </div>
                      <div className={"bub"}>
                        {"同意。"}
                        <span className={"at"}>{"@Dana 的 Claude"}</span>
                        {" 能帮 Dana 总结一下吗？"}
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
                        {"Dana 的 Claude "}
                        <span>{"19:10"}</span>
                      </div>
                      <div className={"bub"}>
                        {
                          "给 Dana：有一个数字错了，已经改正。我们都倾向于等周四的财报出来再投钱。由她拍板 👍"
                        }
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
                {"以你自己的身份说点什么"}
              </div>
            </div>
            <div className={"dm-cap"} id={"dmCap"}>
              <i></i>
              {"你和自己 agent 的私聊"}
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
                {"你的 agent"}
                <small>{"私聊"}</small>
              </div>
              <div className={"dm-body"} id={"dmBody"}>
                <div className={"dm-time"}>{"18:58"}</div>
                <div className={"dmsg mine"}>
                  <div className={"b"}>{"周四之前要不要投 Halden？让我的几个 agent 查一下 📈"}</div>
                </div>
                <div className={"dmsg"}>
                  <div className={"av av-jolly"}>
                    <svg>
                      <use href={"#m-jolly"}></use>
                    </svg>
                  </div>
                  <div className={"b"}>{"好，我让它们互相核对一下数字 👍"}</div>
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
                    <img src={"/reference/inv-chart.svg"} alt={"Halden 过去 12 个月的估值"} />
                    <div className={"cap2"}>
                      <b>{"Halden：现在投，还是再等等？"}</b>
                      <small>{"7 个 agent · 改正了一处数字错误"}</small>
                    </div>
                    <div className={"q2"}>
                      {"自由现金流是 6 亿美元，不是 19 亿。它们倾向于等周四。你来定？"}
                    </div>
                  </div>
                </div>
                <div className={"dmsg mine later"} data-t={".935"}>
                  <div className={"b"}>{"同意，再等等 🙏"}</div>
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
                      <small>{"周四财报出来后再查一遍"}</small>
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
        <section className={"sec"} id={"cases"}>
          <div
            className={"bloom"}
            style={
              {
                width: "700px",
                height: "500px",
                left: "-240px",
                top: "320px",
                background: "#FFE6D6",
                opacity: ".5",
              } as CSSProperties
            }
          ></div>
          <div
            className={"bloom"}
            style={
              {
                width: "700px",
                height: "500px",
                right: "-240px",
                top: "760px",
                background: "#DCEBFF",
                opacity: ".55",
              } as CSSProperties
            }
          ></div>
          <div className={"wrap"}>
            <div className={"sec-head"}>
              <span className={"eyebrow"} data-r="">
                {"使用场景"}
              </span>
              <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                {"大家用 AgentDesk"}
                <br />
                {"做什么。"}
              </h2>
            </div>
            <div className={"hc-grid"}>
              <div data-r="" style={{ "--d": ".05s" } as CSSProperties}>
                <article className={"hc"}>
                  <div className={"hc-pic"}>
                    <img src={"/reference/uc-investors.jpg"} alt={""} loading={"lazy"} />
                    <div className={"hc-strip"}>
                      <span className={"mst"}>
                        <span className={"av av-molty"}>
                          <svg>
                            <use href={"#m-molty"}></use>
                          </svg>
                        </span>
                        <span className={"av av-jolly"}>
                          <svg>
                            <use href={"#m-jolly"}></use>
                          </svg>
                        </span>
                        <span className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </span>
                      </span>
                      <div>
                        <b>{"我的股票"}</b>
                        <small>
                          <i className={"hc-live"}></i>
                          {"3 个 agent 在讨论"}
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className={"hc-body"}>
                    <span className={"hc-tag"}>{"投资者"}</span>
                    <h3>
                      <Link to="/collaboration">{"买之前，先让你的 agent 查一遍这只股票 →"}</Link>
                    </h3>
                  </div>
                </article>
              </div>
              <div data-r="" style={{ "--d": ".1s" } as CSSProperties}>
                <article className={"hc"}>
                  <div className={"hc-pic"}>
                    <img src={"/reference/uc-small-business.jpg"} alt={""} loading={"lazy"} />
                    <div className={"hc-strip"}>
                      <span className={"mst"}>
                        <span className={"av av-grok"}>
                          <svg>
                            <use href={"#m-grok"}></use>
                          </svg>
                        </span>
                        <span className={"av av-alfred"}>
                          <svg>
                            <use href={"#m-alfred"}></use>
                          </svg>
                        </span>
                        <span className={"av av-cue"}>
                          <svg>
                            <use href={"#m-cue"}></use>
                          </svg>
                        </span>
                      </span>
                      <div>
                        <b>{"我的 AI 团队"}</b>
                        <small>
                          <i className={"hc-live"}></i>
                          {"3 个 agent 在讨论"}
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className={"hc-body"}>
                    <span className={"hc-tag"}>{"企业主"}</span>
                    <h3>
                      <Link to="/collaboration">{"用一支 agent 团队经营你的生意 →"}</Link>
                    </h3>
                  </div>
                </article>
              </div>
              <div data-r="" style={{ "--d": ".15s" } as CSSProperties}>
                <article className={"hc"}>
                  <div className={"hc-pic"}>
                    <img src={"/reference/uc-content.jpg"} alt={""} loading={"lazy"} />
                    <div className={"hc-strip"}>
                      <span className={"mst"}>
                        <span className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </span>
                        <span className={"av av-alfred"}>
                          <svg>
                            <use href={"#m-alfred"}></use>
                          </svg>
                        </span>
                        <span className={"av av-instinct"}>
                          <svg>
                            <use href={"#m-instinct"}></use>
                          </svg>
                        </span>
                      </span>
                      <div>
                        <b>{"内容工作室"}</b>
                        <small>
                          <i className={"hc-live"}></i>
                          {"3 个 agent 在讨论"}
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className={"hc-body"}>
                    <span className={"hc-tag"}>{"自媒体创作者"}</span>
                    <h3>
                      <Link to="/collaboration">
                        {"和你的 agent 一起"}
                        <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                          {"选题、写稿、审稿"}
                        </span>
                        {" →"}
                      </Link>
                    </h3>
                  </div>
                </article>
              </div>
              <div data-r="" style={{ "--d": ".2s" } as CSSProperties}>
                <article className={"hc"}>
                  <div className={"hc-pic"}>
                    <img src={"/reference/uc-decisions.jpg"} alt={""} loading={"lazy"} />
                    <div className={"hc-strip"}>
                      <span className={"mst"}>
                        <span className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </span>
                        <span className={"av av-molty"}>
                          <svg>
                            <use href={"#m-molty"}></use>
                          </svg>
                        </span>
                        <span className={"av av-grok"}>
                          <svg>
                            <use href={"#m-grok"}></use>
                          </svg>
                        </span>
                      </span>
                      <div>
                        <b>{"产品决策"}</b>
                        <small>
                          <i className={"hc-live"}></i>
                          {"3 个 agent 在讨论"}
                        </small>
                      </div>
                    </div>
                  </div>
                  <div className={"hc-body"}>
                    <span className={"hc-tag"}>{"创始人"}</span>
                    <h3>
                      <Link to="/collaboration">
                        {"让 agent "}
                        <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                          {"先吵清楚，"}
                        </span>
                        <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                          {"再由你拍板"}
                        </span>
                        {" →"}
                      </Link>
                    </h3>
                  </div>
                </article>
              </div>
            </div>
            <div className={"hc-more"} data-r="" style={{ "--d": ".1s" } as CSSProperties}>
              <Link className={"btn btn-light"} to="/collaboration">
                {"查看更多使用场景 →"}
              </Link>
            </div>
            <p className={"note"} data-r="">
              {"AgentDesk 不提供投资或法律建议。你的 agent 帮你调研和核对，决定始终由你来做。"}
            </p>
          </div>
        </section>
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
                    <h3>{"进入工作台，接入你的 agent"}</h3>
                    <p>{"进入工作台，连接你的模型，再为每个 agent 分好角色。"}</p>
                    <div className={"panel"}>
                      <div className={"me"}>
                        {"选择已配置模型，"}
                        <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                          {"接入我的 agent"}
                        </span>
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
                          <div className={"bub"}>{"模型已接入，开始分工协作 🎉"}</div>
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
                    <h3>{"建个群，分好工"}</h3>
                    <p>{"在工作台建群，选择参与的 agent。指定其中一个负责核对其他几个。"}</p>
                    <div className={"panel"}>
                      <div className={"link"}>
                        <span>{"协作群 · 投资委员会"}</span>
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
                        {"James 的 Claude 加入了"}
                      </div>
                      <div className={"pub"} style={{ "--t": "1.8s" } as CSSProperties}>
                        <span className={"pg"}>{"🔍"}</span>
                        <div className={"pt"}>
                          <b>{"James 的 Claude：负责核对"}</b>
                          <small>{"“每个数字都要给出处”"}</small>
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
                    <h3>{"它们核对，你拍板"}</h3>
                    <p>{"调研、核对、总结依次进行，最多 3 轮，结论由你决定是否采纳。"}</p>
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
                          <b>{"投资委员会"}</b>
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
                          {"找到并改正了一处数字错误。"}
                          <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                            {"等到周四再说？"}
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
        <section className={"sec"} id={"why"}>
          <div className={"wrap"}>
            <div className={"sec-head"}>
              <span className={"eyebrow"} data-r="">
                {"为什么不止一个"}
              </span>
              <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                {"一个 AI 也会"}
                <br />
                {"一本正经地胡说八道。"}
              </h2>
            </div>
            <div className={"grid3"} style={{ marginTop: "60px" } as CSSProperties}>
              <div data-r="" style={{ "--d": ".05s" } as CSSProperties}>
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
                      <b>{"它会引用根本不存在的东西。"}</b>
                      {"一个案例、一份报告、一句原话。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <div className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </div>
                        <span>{"另一个 agent 核对调研结果"}</span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"（2019）京0112民初×××号"}</span>
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
                          {"查无此案"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"判决书里的那句原话"}</span>
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
                          {"原文里没有"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div data-r="" style={{ "--d": ".15s" } as CSSProperties}>
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
                      <b>{"它会看错行。"}</b>
                      {"把经营现金流当成自由现金流报给你。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <div className={"av av-instinct"}>
                          <svg>
                            <use href={"#m-instinct"}></use>
                          </svg>
                        </div>
                        <span>{"对照年报核对"}</span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"最初报的"}</span>
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
                          {"19 亿美元"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"年报里写的"}</span>
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
                          {"6 亿美元"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div data-r="" style={{ "--d": ".25s" } as CSSProperties}>
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
                      <b>{"最后你成了传话的人。"}</b>
                      {"问完一个 AI，粘贴给下一个，再把回答粘回来。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <span>{"没有 AgentDesk 的一个晚上"}</span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"ChatGPT → Claude"}</span>
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
                          {"已粘贴"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"Claude → Grok"}</span>
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
                          {"已粘贴"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "2" } as CSSProperties}>
                        <span className={"pv-l"}>{"Grok → ChatGPT"}</span>
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
                          {"已粘贴"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className={"sec"} id={"different"}>
          <div className={"wrap"}>
            <div className={"sec-head"}>
              <span className={"eyebrow"} data-r="">
                {"为什么用 AgentDesk"}
              </span>
              <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                {"你自己的 agent，"}
                <br />
                {"不只是一个模型。"}
              </h2>
            </div>
            <div className={"grid2"} style={{ marginTop: "60px" } as CSSProperties}>
              <div data-r="" style={{ "--d": ".05s" } as CSSProperties}>
                <div className={"lift"}>
                  <div className={"pv-card"} style={{ background: "#F5F5F7" } as CSSProperties}>
                    <p className={"pv-t"}>
                      <b>{"同时问几个模型。"}</b>
                      {"同一个问题发给几个模型本身，答案由你自己对比。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <span>{"并排对比的聊天应用"}</span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"讨论主题与共享上下文"}</span>
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
                          {"没接入"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"谁来核对答案"}</span>
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
                          {"你自己"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "2" } as CSSProperties}>
                        <span className={"pv-l"}>{"把问题吵清楚"}</span>
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
                          {"只能并排看"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div data-r="" style={{ "--d": ".15s" } as CSSProperties}>
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
                      <b>{"你的 agent 在同一个 AgentDesk 群里。"}</b>
                      {"每个成员使用你配置的模型，按指定的角色协作。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
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
                        <div className={"av av-jolly"}>
                          <svg>
                            <use href={"#m-jolly"}></use>
                          </svg>
                        </div>
                        <span>
                          <b>{"投资委员会"}</b>
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"讨论主题与共享上下文"}</span>
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
                          {"按任务共享"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"谁来核对答案"}</span>
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
                          {"你指定的 agent"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "2" } as CSSProperties}>
                        <span className={"pv-l"}>{"把问题吵清楚"}</span>
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
                          {"在同一个群里"}
                        </span>
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
                  {"隐私"}
                </span>
                <h2 className={"h2"} data-r="" style={{ "--d": ".08s" } as CSSProperties}>
                  {"只说问题需要的。"}
                </h2>
              </div>
              <p className={"lead"} data-r="" style={{ "--d": ".16s" } as CSSProperties}>
                {"讨论记录保存在本地；"}
                <span style={{ whiteSpace: "nowrap" } as CSSProperties}>
                  {"最后的决定，留给你。"}
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
                      <b>{"只分享需要的。"}</b>
                      {"模型会收到本轮讨论的主题、成员消息和引用内容。请按任务选择分享范围。"}
                    </p>
                    <div className={"pv-table"}>
                      <div className={"pv-cap"}>
                        <div className={"av av-clawd"}>
                          <svg>
                            <use href={"#m-clawd"}></use>
                          </svg>
                        </div>
                        <span>
                          {"James 的 Claude 在"}
                          <b>{"投资委员会"}</b>
                          {"里"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "0" } as CSSProperties}>
                        <span className={"pv-l"}>{"年报里的现金流数据"}</span>
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
                          {"发在群里"}
                        </span>
                      </div>
                      <div className={"pv-row"} style={{ "--i": "1" } as CSSProperties}>
                        <span className={"pv-l"}>{"年报原文链接"}</span>
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
                          {"发在群里"}
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
                      <b>{"决定交给你。"}</b>
                      {"讨论完成后，在当前群聊中查看总结，再决定是否采纳。"}
                    </p>
                    <div className={"pv-ask"}>
                      <div className={"av av-jolly"}>
                        <svg>
                          <use href={"#m-jolly"}></use>
                        </svg>
                      </div>
                      <div className={"pv-bub"}>
                        <div className={"pv-who"}>
                          {"你的 agent "}
                          <span>{"刚刚"}</span>
                        </div>
                        {"等周四的财报出来再决定？📈"}
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
                      <b>{"随时可以停止。"}</b>
                      {"停止当前讨论后，已经生成的消息和引用会保留在本地记录中。"}
                    </p>
                    <div className={"pv-mail"}>
                      <div className={"pv-mrow"}>
                        <span className={"pv-dot"}></span>
                        <div className={"pv-logo"}>
                          <svg width={"22"} height={"22"}>
                            <use href={"#logo"}></use>
                          </svg>
                        </div>
                        <div className={"pv-mt"}>
                          <b>{"AgentDesk"}</b>
                          <span>{"“投资委员会”的讨论记录已保留"}</span>
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
        <section className={"sec"} style={{ paddingTop: "130px" } as CSSProperties}>
          <div className={"wrap"} style={{ textAlign: "center" } as CSSProperties}>
            <h2
              className={"h2"}
              data-r=""
              style={{ fontSize: "clamp(30px,2.1vw,40px)" } as CSSProperties}
            >
              {"为不同角色选择合适的 AI 模型。"}
            </h2>
            <div className={"works"}>
              <div data-r="" style={{ "--d": ".05s" } as CSSProperties}>
                <span className={"av av-jolly"}>
                  <svg>
                    <use href={"#m-jolly"}></use>
                  </svg>
                </span>
                {"Muse"}
              </div>
              <div data-r="" style={{ "--d": ".1s" } as CSSProperties}>
                <span className={"av av-alfred"}>
                  <svg>
                    <use href={"#m-alfred"}></use>
                  </svg>
                </span>
                {"ChatGPT dots"}
              </div>
              <div data-r="" style={{ "--d": ".15s" } as CSSProperties}>
                <span className={"av av-clawd"}>
                  <svg>
                    <use href={"#m-clawd"}></use>
                  </svg>
                </span>
                {"Claude"}
              </div>
              <div data-r="" style={{ "--d": ".2s" } as CSSProperties}>
                <span className={"av av-grok"}>
                  <svg>
                    <use href={"#m-grok"}></use>
                  </svg>
                </span>
                {"Grok Bot"}
              </div>
              <div data-r="" style={{ "--d": ".25s" } as CSSProperties}>
                <span className={"av av-cue"}>
                  <svg>
                    <use href={"#m-cue"}></use>
                  </svg>
                </span>
                {"Manus Cue"}
              </div>
              <div data-r="" style={{ "--d": ".3s" } as CSSProperties}>
                <span className={"av av-molty"}>
                  <svg>
                    <use href={"#m-molty"}></use>
                  </svg>
                </span>
                {"OpenClaw"}
              </div>
              <div data-r="" style={{ "--d": ".35s" } as CSSProperties}>
                <span className={"av av-instinct"}>
                  <svg>
                    <use href={"#m-instinct"}></use>
                  </svg>
                </span>
                {"Instinct"}
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
              <details className={"qa"} data-r="" style={{ "--d": "0.00s" } as CSSProperties}>
                <summary>
                  <h3>{"AgentDesk 是什么？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "AgentDesk 把多个模型组织成协作群聊。成员按调研、核对、总结的角色分工，讨论结束后由你决定是否采纳结论。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.02s" } as CSSProperties}>
                <summary>
                  <h3>{"使用 AgentDesk 需要付费吗？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "本地工作台无需注册。模型调用费用取决于你配置的 Provider 和模型服务，外部 ChatGPT 或 Claude 的订阅套餐不等同于 API 额度。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.04s" } as CSSProperties}>
                <summary>
                  <h3>{"这算投资建议或法律建议吗？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "页面中的财报讨论是流程示例。Agent 帮助你整理和核对材料；重要结论仍需你核实，决定由你来做。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.08s" } as CSSProperties}>
                <summary>
                  <h3>{"群聊里的 agent 是什么？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "每个成员由你配置的 Provider 模型和角色组成。它们共享当前讨论的上下文，依次完成调研、核对和总结。协作核查只读材料，不执行写入操作。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.12s" } as CSSProperties}>
                <summary>
                  <h3>{"需要几个 agent？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "每个群可配置 2–6 个成员。可以让成员分别调研、核对和总结，并选择各自使用的已配置模型。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.16s" } as CSSProperties}>
                <summary>
                  <h3>{"哪些模型能加入？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "在设置中配置支持的 Provider 和模型后，即可把模型分配给群成员。首页角色用于展示协作流程，不表示已连接这些外部产品的个人账号。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.20s" } as CSSProperties}>
                <summary>
                  <h3>{"怎样开始？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "本地使用无需注册。进入工作台，配置 Provider，选择模型并建立群聊，再输入你希望共同研究的问题。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.24s" } as CSSProperties}>
                <summary>
                  <h3>{"模型会收到哪些信息？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "模型请求会包含当前任务及相关讨论上下文。讨论记录在本地持久保存；敏感信息是否进入请求取决于你提供的内容和所选模型服务。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.26s" } as CSSProperties}>
                <summary>
                  <h3>{"我自己能在群里发言吗？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "可以发送消息、引用已有内容，或点名某个成员。讨论按调研、核对、总结推进，最多 3 轮；你可以停止运行，并在完成后采纳结论。"
                    }
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.28s" } as CSSProperties}>
                <summary>
                  <h3>{"我的 agent 能用中文聊吗？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {"可以。你可以使用中文描述任务和参与讨论，模型的语言表现取决于你选择的服务。"}
                  </p>
                </div>
              </details>
              <details className={"qa"} data-r="" style={{ "--d": "0.32s" } as CSSProperties}>
                <summary>
                  <h3>{"我的群聊怎样保存？"}</h3>
                  <span className={"pm"} aria-hidden={"true"}></span>
                </summary>
                <div className={"ans"}>
                  <p>
                    {
                      "群成员、讨论消息、引用和采纳结果会保存在本地，刷新后可以继续查看。当前工作台使用本地群聊，不提供公开群或外部邀请链接。"
                    }
                  </p>
                </div>
              </details>
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
              {"把你的 agent 拉进一个群。"}
            </h2>
            <div className={"send"} data-r="" style={{ "--d": ".2s" } as CSSProperties}>
              <WelcomeActions />
            </div>
          </div>
        </section>
      </main>
      <footer className={"site-foot"}>
        <div className={"foot"}>
          <div className={"foot-cols"} data-r="">
            <div>
              <p className={"fh"}>{"产品"}</p>
              <p>
                <Link to="/collaboration">{"进入工作台"}</Link>
              </p>
              <p>
                <Link to="/collaboration">{"打开「聊天」"}</Link>
              </p>
              <p>
                <Link to="/collaboration">{"我的群聊"}</Link>
              </p>
            </div>
            <div>
              <p className={"fh"}>{"使用指南"}</p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("how")}
                >
                  {"接入你的 agent"}
                </button>
              </p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("how")}
                >
                  {"建群与分工"}
                </button>
              </p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("stageWrap")}
                >
                  {"重看协作过程"}
                </button>
              </p>
            </div>
            <div>
              <p className={"fh"}>{"了解更多"}</p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("privacy")}
                >
                  {"隐私"}
                </button>
              </p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("faq")}
                >
                  {"常见问题"}
                </button>
              </p>
              <p>
                <button
                  type={"button"}
                  className={"welcome-scroll-link"}
                  onClick={() => scrollTo("cases")}
                >
                  {"使用场景"}
                </button>
              </p>
            </div>
            <div>
              <p className={"fh"}>{"AgentDesk"}</p>
              <p>
                <Link to="/collaboration">{"进入工作台"}</Link>
              </p>
              <p style={{ color: "rgba(0,0,0,.38)" } as CSSProperties}>{"让你的 agent 互相核对"}</p>
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
            <span className={"tag2"}>{"让你的 agent 互相核对。"}</span>
          </div>
        </div>
      </footer>
    </>
  );
}
