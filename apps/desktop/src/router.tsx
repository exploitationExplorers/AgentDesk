import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/AppShell";
import { ChatPage } from "./features/chat/ChatPage";
import { CodePage } from "./features/code/CodePage";
import { DeployPage } from "./features/deploy/DeployPage";
import { DiskPage } from "./features/disk/DiskPage";
import { FeedPage } from "./features/feed/FeedPage";
import { CareerMapPage } from "./features/learning/CareerMapPage";
import { LearningPage } from "./features/learning/LearningPage";
import { LibraryPage } from "./features/learning/LibraryPage";
import { InterviewPage } from "./features/learning/InterviewPage";
import { ReviewPage } from "./features/learning/ReviewPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { SkillsPage } from "./features/skills/SkillsPage";
import { WorkflowEditorPage } from "./features/workflows/WorkflowEditorPage";
import { WorkflowsPage } from "./features/workflows/WorkflowsPage";
import { AutomationsPage } from "./features/automations/AutomationsPage";

const rootRoute = createRootRoute({ component: AppShell });

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: z.object({ c: z.string().optional() }),
  component: ChatPage,
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});
const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/code",
  validateSearch: z.object({
    task: z.string().optional(),
    c: z.string().optional(),
    source: z.enum(["workbench", "cli"]).optional(),
  }),
  component: CodePage,
});
const deployRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deploy",
  component: DeployPage,
});
const diskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/disk",
  component: DiskPage,
});
const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed",
  component: FeedPage,
});
const learningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning",
  component: LearningPage,
});
const learningCareerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/career",
  component: CareerMapPage,
});
const learningLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/library",
  component: LibraryPage,
});
const learningReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/review",
  component: ReviewPage,
});
const learningInterviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/learning/interview",
  component: InterviewPage,
});
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});
const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automations",
  component: AutomationsPage,
});
const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$id",
  component: WorkflowEditorPage,
});
const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: z.object({ tab: z.string().optional() }),
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  chatRoute,
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
export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { chatRoute, codeRoute, settingsRoute, workflowEditorRoute };
