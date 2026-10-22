import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { DiskCategory, DiskMode, DiskTier } from "@agentdesk/shared";

export interface DiskEnv {
  platform: NodeJS.Platform;
  home: string;
  /** Windows 为 LocalAppData；macOS 为 ~/Library */
  local: string;
  /** Windows 为 Roaming AppData；macOS 为 ~/Library/Application Support */
  roaming: string;
}

export interface DiskLimits {
  knownMinBytes: number;
  genericMinBytes: number;
  largeFileMinBytes: number;
  largeDirMinBytes: number;
  maxEntries: number;
  maxEntriesPerItem: number;
}

export const DEFAULT_DISK_LIMITS: DiskLimits = {
  knownMinBytes: 8 * 1024 * 1024,
  genericMinBytes: 150 * 1024 * 1024,
  largeFileMinBytes: 500 * 1024 * 1024,
  largeDirMinBytes: 1024 * 1024 * 1024,
  maxEntries: 200_000,
  maxEntriesPerItem: 20_000,
};

export interface DiskRule {
  id: string;
  title: string;
  category: DiskCategory;
  tier: DiskTier;
  mode: Exclude<DiskMode, "recycle">;
  regenerable: boolean;
  reason: string;
  platforms: Array<"win32" | "darwin" | "linux">;
  paths: (env: DiskEnv) => string[];
  minBytes?: number;
  /** 为 true 时模型不能改档 */
  locked?: boolean;
}

export interface TierSubject {
  tier: DiskTier;
  ruleTier: DiskTier;
  category: DiskCategory;
  regenerable: boolean;
  protected: boolean;
  locked: boolean;
  hasGit: boolean;
}

const MB = 1024 * 1024;

export function detectDiskEnv(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): DiskEnv {
  if (platform === "win32") {
    return {
      platform,
      home,
      local: process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
      roaming: process.env.APPDATA || join(home, "AppData", "Roaming"),
    };
  }
  return {
    platform,
    home,
    local: join(home, "Library"),
    roaming: join(home, "Library", "Application Support"),
  };
}

export function pathKey(target: string, platform: NodeJS.Platform): string {
  const normalized = normalize(resolve(target));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

export function isStrictChild(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const root = pathKey(parent, platform);
  const target = pathKey(child, platform);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/** 受保护前缀：命中后既不扫描，也不允许删除。 */
export function protectedPrefixes(env: DiskEnv, extra: string[] = []): string[] {
  const { home, roaming, local } = env;
  const list = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".config"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".ollama"),
    join(home, ".cache", "huggingface"),
    join(home, ".cache", "torch"),
    join(home, ".cache", "whisper"),
    join(home, ".cache", "codex-runtimes"),
    ...extra,
  ];
  if (env.platform === "darwin") {
    list.push(
      join(home, "Library", "Keychains"),
      join(home, "Library", "Mail"),
      join(home, "Library", "Messages"),
      join(home, "Library", "Photos"),
      join(home, "Library", "Mobile Documents"),
      join(home, "Pictures", "Photos Library.photoslibrary"),
    );
  }
  if (env.platform === "win32") {
    list.push(
      join(roaming, "Microsoft", "Credentials"),
      join(roaming, "Microsoft", "Protect"),
      join(roaming, "Microsoft", "Crypto"),
      join(local, "Microsoft", "Credentials"),
    );
  }
  return list;
}

export function isProtectedPath(target: string, env: DiskEnv, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) =>
      samePath(prefix, target, env.platform) || isStrictChild(prefix, target, env.platform),
  );
}

const SHELL_FOLDERS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Music",
  "Videos",
  "Movies",
];

/** 这些目录名出现在家目录、Local 或 Roaming 的直接子级时，不允许作为删除目标。 */
const DENY_CHILD_NAMES = new Set([
  "appdata",
  "local",
  "roaming",
  "locallow",
  "library",
  "application support",
  "documents",
  "desktop",
  "downloads",
  "pictures",
  "music",
  "videos",
  "movies",
  ".ssh",
  ".gnupg",
  ".config",
  ".claude",
  ".codex",
  ".ollama",
]);

/** 无论深度如何，目录名本身就不能删。 */
const DENY_ANY_BASENAME = new Set([
  "user data",
  "keychains",
  "cookies",
  "login data",
  "system32",
  "windows",
  "program files",
  "program files (x86)",
]);

/** 少数缓存工具会把仓库直接放在家目录下，只放行这些名字。 */
const ALLOW_HOME_CACHE = new Set([".pnpm-store"]);

/** Local/Roaming 不在家目录下时，这些直接子目录仍然不能整目录删除。 */
const BROAD_DIRECT_NAMES = new Set([
  "google",
  "microsoft",
  "mozilla",
  "packages",
  "programs",
  "temp",
  "crashdumps",
  "apple",
  "windows",
]);

/**
 * 删除前的路径闸门。不跟随符号链接；调用方应先 realpath，再把真实路径传进来。
 * 家目录、磁盘根、用户壳层目录、浏览器配置档和受保护前缀一律拒绝。
 */
export function isSafeDeletionTarget(target: string, env: DiskEnv, prefixes: string[]): boolean {
  if (!target.trim()) return false;
  const platform = env.platform;
  const resolved = resolve(target);
  if (samePath(parse(resolved).root, resolved, platform)) return false;
  if (samePath(parse(env.home).root, env.home, platform)) return false;
  if (isProtectedPath(resolved, env, prefixes)) return false;

  const anchors = [env.home, env.local, env.roaming];
  const anchor = anchors.find((item) => isStrictChild(item, resolved, platform));
  if (!anchor) return false;

  const forbidden = [
    env.home,
    env.local,
    env.roaming,
    join(env.home, "AppData"),
    join(env.home, "Library"),
    ...SHELL_FOLDERS.map((name) => join(env.home, name)),
  ];
  if (forbidden.some((item) => samePath(item, resolved, platform))) return false;

  const rel = relative(resolve(anchor), resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;

  const name = basename(resolved).toLowerCase();
  if (DENY_ANY_BASENAME.has(name)) return false;
  const parent = dirname(resolved);
  const parentIsRoot =
    samePath(parent, env.home, platform) ||
    samePath(parent, env.local, platform) ||
    samePath(parent, env.roaming, platform);
  if (parentIsRoot && DENY_CHILD_NAMES.has(name)) return false;

  const fromHome = relativeDepth(env.home, resolved, platform);
  const fromLocal = relativeDepth(env.local, resolved, platform);
  const fromRoaming = relativeDepth(env.roaming, resolved, platform);
  if (fromHome >= 2 || fromLocal >= 2 || fromRoaming >= 2) return true;
  if (
    fromHome === 1 &&
    ALLOW_HOME_CACHE.has(name) &&
    samePath(dirname(resolved), env.home, platform)
  ) {
    return true;
  }
  // 缓存目录有时直接放在 Local/Roaming，且这两处不在家目录下
  return fromHome === 0 && (fromLocal === 1 || fromRoaming === 1) && !BROAD_DIRECT_NAMES.has(name);
}

function relativeDepth(parent: string, child: string, platform: NodeJS.Platform): number {
  if (!isStrictChild(parent, child, platform)) return 0;
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return 0;
  return rel.split(sep).filter(Boolean).length;
}

const RANK: Record<DiskTier, number> = { keep: 0, optional: 1, primary: 2 };

/** 模型只能把档位改得更保守。用户文件、版本库和受保护路径不能升到首要清理。 */
export function applyTierGuard(subject: TierSubject, suggested?: DiskTier): DiskTier {
  if (subject.protected || subject.hasGit || subject.ruleTier === "keep") return "keep";
  let tier = subject.locked ? subject.ruleTier : (suggested ?? subject.tier);
  if (RANK[tier] > RANK[subject.ruleTier]) tier = subject.ruleTier;
  if (subject.category === "user" && tier === "primary") tier = "optional";
  if (!subject.regenerable && tier === "primary") tier = "optional";
  return tier;
}

export function cacheRules(platform: NodeJS.Platform): DiskRule[] {
  return RULES.filter((rule) => rule.platforms.includes(platform as "win32" | "darwin" | "linux"));
}

export function userContentRoots(env: DiskEnv): Array<{ path: string; label: string }> {
  const names: Array<{ name: string; label: string }> = [
    { name: "Downloads", label: "下载" },
    { name: "Desktop", label: "桌面" },
    { name: "Documents", label: "文稿" },
  ];
  if (env.platform === "darwin") names.push({ name: "Movies", label: "影片" });
  if (env.platform === "win32") names.push({ name: "Videos", label: "视频" });
  return names.map((item) => ({ path: join(env.home, item.name), label: item.label }));
}

export function genericCacheRoots(env: DiskEnv): string[] {
  const roots = [join(env.home, ".cache")];
  if (env.platform === "darwin") roots.push(join(env.home, "Library", "Caches"));
  return roots;
}

const POSIX = ["darwin", "linux"] as const;
const ALL = ["win32", "darwin", "linux"] as const;

const RULES: DiskRule[] = [
  rule({
    id: "npm-cache",
    title: "npm 下载缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载，不影响已安装的项目",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "npm-cache"), join(env.roaming, "npm-cache")],
  }),
  rule({
    id: "npm-cache-posix",
    title: "npm 下载缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载，不影响已安装的项目",
    platforms: [...POSIX],
    paths: (env) => [join(env.home, ".npm", "_cacache")],
  }),
  rule({
    id: "npx-cache",
    title: "npx 临时安装包",
    category: "dev",
    tier: "primary",
    mode: "whole",
    regenerable: true,
    reason: "下次执行 npx 时会重新下载",
    platforms: [...ALL],
    paths: (env) => [join(env.home, ".npm", "_npx")],
  }),
  rule({
    id: "pnpm-store",
    title: "pnpm 包仓库",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载，项目里的 node_modules 不受影响",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "pnpm", "store"), join(env.local, "pnpm-store")],
  }),
  rule({
    id: "pnpm-store-posix",
    title: "pnpm 包仓库",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载，项目里的 node_modules 不受影响",
    platforms: [...POSIX],
    paths: (env) => [
      join(env.home, "Library", "pnpm", "store"),
      join(env.home, ".local", "share", "pnpm", "store"),
      join(env.home, ".pnpm-store"),
    ],
  }),
  rule({
    id: "yarn-cache",
    title: "Yarn 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "Yarn", "Cache")],
  }),
  rule({
    id: "yarn-cache-posix",
    title: "Yarn 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装依赖时会重新下载",
    platforms: [...POSIX],
    paths: (env) => [join(env.home, ".cache", "yarn"), join(env.home, "Library", "Caches", "Yarn")],
  }),
  rule({
    id: "pip-cache",
    title: "pip 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装 Python 包时会重新下载",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "pip", "Cache")],
  }),
  rule({
    id: "pip-cache-posix",
    title: "pip 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装 Python 包时会重新下载",
    platforms: [...POSIX],
    paths: (env) => [join(env.home, ".cache", "pip"), join(env.home, "Library", "Caches", "pip")],
  }),
  rule({
    id: "uv-cache",
    title: "uv 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装 Python 包时会重新下载",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "uv", "cache")],
  }),
  rule({
    id: "uv-cache-posix",
    title: "uv 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "安装 Python 包时会重新下载",
    platforms: [...POSIX],
    paths: (env) => [join(env.home, ".cache", "uv"), join(env.home, "Library", "Caches", "uv")],
  }),
  rule({
    id: "cargo-cache",
    title: "Cargo 下载缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "Rust 构建时会重新下载，已安装的工具不受影响",
    platforms: [...ALL],
    paths: (env) => [
      join(env.home, ".cargo", "registry", "cache"),
      join(env.home, ".cargo", "git", "db"),
    ],
  }),
  rule({
    id: "go-build-cache",
    title: "Go 构建缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "下次编译会慢一些，源码不受影响",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "go-build")],
  }),
  rule({
    id: "go-build-cache-posix",
    title: "Go 构建缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "下次编译会慢一些，源码不受影响",
    platforms: [...POSIX],
    paths: (env) => [
      join(env.home, "Library", "Caches", "go-build"),
      join(env.home, ".cache", "go-build"),
    ],
  }),
  rule({
    id: "gradle-cache",
    title: "Gradle 缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "下次构建会重新下载依赖",
    platforms: [...ALL],
    paths: (env) => [join(env.home, ".gradle", "caches")],
  }),
  rule({
    id: "maven-repo",
    title: "Maven 本地依赖仓库",
    category: "dev",
    tier: "optional",
    mode: "contents",
    regenerable: true,
    locked: true,
    reason: "Java 项目下次构建会重新下载全部依赖，比较耗时",
    platforms: [...ALL],
    paths: (env) => [join(env.home, ".m2", "repository")],
  }),
  rule({
    id: "playwright",
    title: "Playwright 浏览器",
    category: "dev",
    tier: "optional",
    mode: "whole",
    regenerable: true,
    locked: true,
    reason: "自动化测试需要时要重新下载浏览器",
    platforms: ["win32"],
    paths: (env) => [join(env.local, "ms-playwright")],
  }),
  rule({
    id: "playwright-posix",
    title: "Playwright 浏览器",
    category: "dev",
    tier: "optional",
    mode: "whole",
    regenerable: true,
    locked: true,
    reason: "自动化测试需要时要重新下载浏览器",
    platforms: [...POSIX],
    paths: (env) => [
      join(env.home, "Library", "Caches", "ms-playwright"),
      join(env.home, ".cache", "ms-playwright"),
    ],
  }),
  rule({
    id: "puppeteer",
    title: "Puppeteer 浏览器",
    category: "dev",
    tier: "optional",
    mode: "whole",
    regenerable: true,
    locked: true,
    reason: "需要时要重新下载浏览器",
    platforms: [...ALL],
    paths: (env) => [join(env.home, ".cache", "puppeteer")],
  }),
  rule({
    id: "chrome-cache",
    title: "Chrome 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建；书签、密码和登录状态不在这里",
    platforms: ["win32"],
    paths: (env) => [
      join(env.local, "Google", "Chrome", "User Data", "Default", "Cache"),
      join(env.local, "Google", "Chrome", "User Data", "Default", "Code Cache"),
      join(env.local, "Google", "Chrome", "User Data", "ShaderCache"),
      join(env.local, "Google", "Chrome", "User Data", "GrShaderCache"),
    ],
  }),
  rule({
    id: "edge-cache",
    title: "Edge 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建；书签和登录状态不在这里",
    platforms: ["win32"],
    paths: (env) => [
      join(env.local, "Microsoft", "Edge", "User Data", "Default", "Cache"),
      join(env.local, "Microsoft", "Edge", "User Data", "Default", "Code Cache"),
      join(env.local, "Microsoft", "Edge", "User Data", "ShaderCache"),
    ],
  }),
  rule({
    id: "chrome-cache-mac",
    title: "Chrome 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建；书签、密码和登录状态不在这里",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "Google", "Chrome")],
  }),
  rule({
    id: "edge-cache-mac",
    title: "Edge 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "Microsoft Edge")],
  }),
  rule({
    id: "firefox-cache-mac",
    title: "Firefox 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "Firefox")],
  }),
  rule({
    id: "safari-cache",
    title: "Safari 网页缓存",
    category: "browser",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "网页缓存，删除后自动重建",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "com.apple.Safari")],
  }),
  rule({
    id: "homebrew-cache",
    title: "Homebrew 下载缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "旧安装包，已安装的软件不受影响",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "Homebrew")],
  }),
  rule({
    id: "xcode-derived",
    title: "Xcode 编译缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "项目下次编译时重建",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Developer", "Xcode", "DerivedData")],
  }),
  rule({
    id: "xcode-archives",
    title: "Xcode 归档包",
    category: "dev",
    tier: "optional",
    mode: "contents",
    regenerable: false,
    locked: true,
    reason: "已打包的历史版本，删除后无法再提交这些版本",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Developer", "Xcode", "Archives")],
  }),
  rule({
    id: "simulator-cache",
    title: "模拟器缓存",
    category: "dev",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "模拟器下次启动时重建",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Developer", "CoreSimulator", "Caches")],
  }),
  rule({
    id: "macos-logs",
    title: "应用日志",
    category: "system",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    minBytes: 200 * MB,
    reason: "历史日志，不影响应用设置",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Logs")],
  }),
  rule({
    id: "vscode-cache",
    title: "VS Code 缓存",
    category: "app",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "编辑器缓存，设置和插件不受影响",
    platforms: ["win32"],
    paths: (env) => editorCaches(env.roaming, "Code"),
  }),
  rule({
    id: "cursor-cache",
    title: "Cursor 缓存",
    category: "ai",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "编辑器缓存，设置、对话和插件不受影响",
    platforms: ["win32"],
    paths: (env) => editorCaches(env.roaming, "Cursor"),
  }),
  rule({
    id: "vscode-cache-mac",
    title: "VS Code 缓存",
    category: "app",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "编辑器缓存，设置和插件不受影响",
    platforms: ["darwin"],
    paths: (env) => editorCaches(env.roaming, "Code"),
  }),
  rule({
    id: "cursor-cache-mac",
    title: "Cursor 缓存",
    category: "ai",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "编辑器缓存，设置、对话和插件不受影响",
    platforms: ["darwin"],
    paths: (env) => editorCaches(env.roaming, "Cursor"),
  }),
  rule({
    id: "jetbrains-cache-mac",
    title: "JetBrains 缓存",
    category: "app",
    tier: "primary",
    mode: "contents",
    regenerable: true,
    reason: "索引缓存，下次打开项目会重新建立索引",
    platforms: ["darwin"],
    paths: (env) => [join(env.home, "Library", "Caches", "JetBrains")],
  }),
];

function editorCaches(root: string, product: string): string[] {
  return ["Cache", "CachedData", "CachedExtensionVSIXs", "Code Cache", "GPUCache"].map((name) =>
    join(root, product, name),
  );
}

function rule(input: DiskRule): DiskRule {
  return input;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}
