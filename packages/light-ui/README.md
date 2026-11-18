# AgentDesk Light UI

从 [Lancer Light UI](https://github.com/raylee-ai/lancer/tree/0ccc4584fc0753fa128e71464814d1ed09dd1dbc/packages/light-ui) 引入的实际光线路径与流动边框源码。上游提交 `0ccc4584fc0753fa128e71464814d1ed09dd1dbc`，引入日期 2026-11-18；核心 `src/` 与上游保持一致。MIT 许可、Matthew Lam 版权及 Lancer 贡献声明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。不含上游角色图片、模型配置或会话。

它使用 TypeScript 与原生 SVG，没有运行时依赖。项目内通过 workspace 包使用：

```ts
import { createLightLayer } from "@agentdesk/light-ui";
const layer = createLightLayer(container);
const flight = layer.emit({
  id: "event-1",
  source: sourceElement,
  target: targetElement,
  color: "#818cf8",
});
await flight.finished;
layer.destroy();
```

容器需 `position: relative`。React 卸载时销毁图层；节点缺失时返回 `missing-anchor`，不会射向其他节点。每个业务事件使用独立 ID；仅在新事件发生时发射，刷新不重放历史。遵循 `prefers-reduced-motion`，支持暂停、取消、页面隐藏与空闲清理。不要把逐帧状态存入 React state。

导入 `@agentdesk/light-ui/running-border.css` 后，执行中的节点可挂载 `light-running-border` SVG；AgentDesk 的适配组件位于 `apps/desktop/src/components/execution-light/`。

工作台构建会将许可和来源写入产物 `licenses/lancer-light-ui-LICENSE.txt` 与 `licenses/lancer-light-ui-NOTICE.txt`，CLI 内置网页与团队网页沿用同一构建配置。

```sh
corepack pnpm --filter @agentdesk/light-ui test
corepack pnpm --filter @agentdesk/light-ui typecheck
```

几何测试沿用上游；浏览器集成回归在 `apps/desktop/e2e/lancer-ui.spec.ts`。单包可以复制到其它前端项目，按项目构建方式导入 `src/index.ts` 或构建后的 `dist/index.js`，始终保留 LICENSE 和 NOTICE。原设计接入提示见 [PROMPT.md](PROMPT.md)。
