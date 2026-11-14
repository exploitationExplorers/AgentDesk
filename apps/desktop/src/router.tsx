import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/AppShell";

const rootRoute = createRootRoute({ component: AppShell });

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: z.object({ c: z.string().optional() }),
});
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
});
const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team",
  validateSearch: z.object({ invite: z.string().max(256).optional() }),
});
const collaborationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/collaboration",
  validateSearch: z.object({ room: z.string().optional() }),
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
});
const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/code",
  validateSearch: z.object({
    task: z.string().optional(),
    c: z.string().optional(),
    source: z.enum(["workbench", "cli"]).optional(),
  }),
});
const deployRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deploy",
});
const diskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/disk",
});
const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed",
});
const learningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning",
});
const learningCareerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/career",
});
const learningLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/library",
});
const learningReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/review",
});
const learningInterviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/interview",
});
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
});
const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations",
});
const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$id",
});
const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: z.object({ tab: z.string().optional() }),
});

// 先确定路由与搜索参数的类型，再绑定组件，避免页面反向引用路由时出现类型推导循环。
chatRoute.update({
  component: lazyRouteComponent(() => import("./features/chat/ChatPage"), "ChatPage"),
});
welcomeRoute.update({
  component: lazyRouteComponent(() => import("./features/welcome/WelcomePage"), "WelcomePage"),
});
teamRoute.update({
  component: lazyRouteComponent(() => import("./features/team/TeamPage"), "TeamPage"),
});
collaborationRoute.update({
  component: lazyRouteComponent(
    () => import("./features/collaboration/CollaborationPage"),
    "CollaborationPage",
  ),
});
projectsRoute.update({
  component: lazyRouteComponent(() => import("./features/projects/ProjectsPage"), "ProjectsPage"),
});
codeRoute.update({
  component: lazyRouteComponent(() => import("./features/code/CodePage"), "CodePage"),
});
deployRoute.update({
  component: lazyRouteComponent(() => import("./features/deploy/DeployPage"), "DeployPage"),
});
diskRoute.update({
  component: lazyRouteComponent(() => import("./features/disk/DiskPage"), "DiskPage"),
});
feedRoute.update({
  component: lazyRouteComponent(() => import("./features/feed/FeedPage"), "FeedPage"),
});
learningRoute.update({
  component: lazyRouteComponent(() => import("./features/learning/LearningPage"), "LearningPage"),
});
learningCareerRoute.update({
  component: lazyRouteComponent(() => import("./features/learning/CareerMapPage"), "CareerMapPage"),
});
learningLibraryRoute.update({
  component: lazyRouteComponent(() => import("./features/learning/LibraryPage"), "LibraryPage"),
});
learningReviewRoute.update({
  component: lazyRouteComponent(() => import("./features/learning/ReviewPage"), "ReviewPage"),
});
learningInterviewRoute.update({
  component: lazyRouteComponent(() => import("./features/learning/InterviewPage"), "InterviewPage"),
});
workflowsRoute.update({
  component: lazyRouteComponent(
    () => import("./features/workflows/WorkflowsPage"),
    "WorkflowsPage",
  ),
});
automationsRoute.update({
  component: lazyRouteComponent(
    () => import("./features/automations/AutomationsPage"),
    "AutomationsPage",
  ),
});
workflowEditorRoute.update({
  component: lazyRouteComponent(
    () => import("./features/workflows/WorkflowEditorPage"),
    "WorkflowEditorPage",
  ),
});
skillsRoute.update({
  component: lazyRouteComponent(() => import("./features/skills/SkillsPage"), "SkillsPage"),
});
settingsRoute.update({
  component: lazyRouteComponent(() => import("./features/settings/SettingsPage"), "SettingsPage"),
});

const routeTree = rootRoute.addChildren([
  chatRoute,
  welcomeRoute,
  teamRoute,
  collaborationRoute,
  projectsRoute,
  codeRoute,
  deployRoute,
  diskRoute,
  feedRoute,
  learningRoute,
  learningCareerRoute,
  learningLibraryRoute,
  learningReviewRoute,
  learningInterviewRoute,
  workflowsRoute,
  automationsRoute,
  workflowEditorRoute,
  skillsRoute,
  settingsRoute,
]);

/** Tauri 的自定义协议下使用 hash 路由，避免刷新时 404 */
const history = createHashHistory();
// 仅无深链接的启动进入介绍页，已有会话和其它显式路由保持原地址。
if (!window.location.hash || window.location.hash === "#")
  history.replace(import.meta.env.VITE_AGENTDESK_MODE === "team" ? "/team" : "/welcome");
export const router = createRouter({
  routeTree,
  history,
  defaultPreload: "intent",
  defaultPendingMs: 150,
  defaultPendingMinMs: 0,
  defaultPendingComponent: () => (
    <div role="status" className="flex h-full items-center justify-center text-sm text-muted">
      正在加载页面…
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { chatRoute, codeRoute, settingsRoute, workflowEditorRoute, collaborationRoute };
