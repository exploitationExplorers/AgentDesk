import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "./components/AppShell";
import { ChatPage } from "./features/chat/ChatPage";
import { DeployPage } from "./features/deploy/DeployPage";
import { FeedPage } from "./features/feed/FeedPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { WorkflowEditorPage } from "./features/workflows/WorkflowEditorPage";
import { WorkflowsPage } from "./features/workflows/WorkflowsPage";

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
const deployRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deploy",
  component: DeployPage,
});
const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed",
  component: FeedPage,
});
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});
const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$id",
  component: WorkflowEditorPage,
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
  deployRoute,
  feedRoute,
  workflowsRoute,
  workflowEditorRoute,
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

export { chatRoute, settingsRoute, workflowEditorRoute };
