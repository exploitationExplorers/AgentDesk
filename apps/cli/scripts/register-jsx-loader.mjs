/** `node --test` 预加载入口：注册 jsx-loader.mjs，使测试可以直接 import .jsx 组件文件。 */
import { register } from "node:module";

register("./jsx-loader.mjs", import.meta.url);
