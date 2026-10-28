/**
 * 强制伪造真实 TTY 语义后再加载真实入口：用于验证构建产物在"没有人在场按键"的情况下，
 * Ink 挂载阶段本身是否存活（不会静默清空事件循环）。只伪造 isTTY 与 setRawMode，不改变
 * 其它任何行为；伪造对象在真实 PowerShell 终端里复现过一次由构建配置改动引入的挂载期
 * 卡死，本探针是复现该问题所用的最小手法，不是测试逻辑本身。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.stdin.isTTY = true;
process.stdout.isTTY = true;
process.stderr.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
process.stdin.ref = process.stdin.ref ?? (() => process.stdin);
process.stdin.unref = process.stdin.unref ?? (() => process.stdin);

const realEntry = resolve(process.argv[2]);
process.argv = [process.argv[0], realEntry, ...process.argv.slice(3)];

await import(pathToFileURL(realEntry).href);
