/**
 * Ink 的 React DevTools 集成是可选依赖，仅在 DEV=true 且本机 devtools 可达时才会真正调用。
 * 发行包不随附该开发期工具；用这个空实现替代，让 esbuild 能在单文件 bundle 中完整解析该模块，
 * 不影响生产运行时行为（这段代码永远不会在 DEV 未设置时被执行）。
 */
export default {
  initialize() {},
  connectToDevTools() {},
};
