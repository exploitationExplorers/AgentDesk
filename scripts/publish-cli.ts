/**
 * 发布 apps/cli（npm: chuxin-agentdesk）。
 *
 * 用法（仓库根目录）：
 *   pnpm publish:cli                 # patch 升版并发布
 *   pnpm publish:cli -- --bump minor
 *   pnpm publish:cli -- --dry-run
 *   pnpm publish:cli -- --otp 123456
 *   pnpm publish:cli -- --skip-tests
 *   pnpm publish:cli -- --with-dist-smoke
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "apps", "cli");
const packagePath = join(cliDir, "package.json");

type Bump = "patch" | "minor" | "major" | "none";

function usage(): never {
  console.error(`用法: pnpm publish:cli [-- --bump patch|minor|major|none] [--dry-run] [--otp CODE] [--skip-tests] [--with-dist-smoke]

默认 patch 升版 apps/cli，跑 typecheck/test/build/package smoke，再 npm publish。
交互式 dist smoke 默认跳过（可用 --with-dist-smoke 打开）。
已升过版本时用 --bump none 只构建并发布。
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let bump: Bump = "patch";
  let dryRun = false;
  let skipTests = false;
  let withDistSmoke = false;
  let otp: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-tests") {
      skipTests = true;
      continue;
    }
    if (arg === "--with-dist-smoke") {
      withDistSmoke = true;
      continue;
    }
    if (arg === "--bump") {
      const value = argv[++i];
      if (value !== "patch" && value !== "minor" && value !== "major" && value !== "none") usage();
      bump = value;
      continue;
    }
    if (arg.startsWith("--bump=")) {
      const value = arg.slice("--bump=".length);
      if (value !== "patch" && value !== "minor" && value !== "major" && value !== "none") usage();
      bump = value;
      continue;
    }
    if (arg === "--otp") {
      otp = argv[++i];
      if (!otp) usage();
      continue;
    }
    if (arg.startsWith("--otp=")) {
      otp = arg.slice("--otp=".length);
      continue;
    }
    console.error(`未知参数：${arg}`);
    usage();
  }
  return { bump, dryRun, skipTests, withDistSmoke, otp };
}

function run(command: string, args: string[], cwd = root) {
  console.info(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 退出码 ${result.status ?? "null"}`);
  }
}

function bumpVersion(version: string, bump: Exclude<Bump, "none">): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`无法解析版本号：${version}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else patch += 1;
  return `${major}.${minor}.${patch}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  if (pkg.name !== "chuxin-agentdesk" || typeof pkg.version !== "string") {
    throw new Error(`期望包名 chuxin-agentdesk 且带 version，实际为 ${String(pkg.name)}`);
  }
  const previous = pkg.version;
  const next = options.bump === "none" ? previous : bumpVersion(previous, options.bump);
  console.info(
    options.bump === "none"
      ? `准备发布 ${pkg.name}@${next}${options.dryRun ? " (dry-run)" : ""}`
      : `准备发布 ${pkg.name}: ${previous} → ${next}${options.dryRun ? " (dry-run)" : ""}`,
  );

  if (options.bump !== "none") {
    pkg.version = next;
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  if (!options.skipTests) {
    run("pnpm", ["--filter", "./apps/cli", "typecheck"]);
    run("pnpm", ["--filter", "./apps/cli", "test"]);
  }
  run("pnpm", ["build:cli"]);
  if (!options.skipTests) {
    run("pnpm", ["--filter", "./apps/cli", "test:package"]);
    if (options.withDistSmoke) run("pnpm", ["--filter", "./apps/cli", "test:dist"]);
  }

  const publishArgs = [
    "publish",
    "--access",
    "public",
    "--registry",
    "https://registry.npmjs.org/",
    // 版本 bump 故意先于提交，跳过 pnpm 的 git 干净树检查。
    "--no-git-checks",
  ];
  if (options.dryRun) publishArgs.push("--dry-run");
  if (options.otp) publishArgs.push("--otp", options.otp);
  run("pnpm", ["--filter", "./apps/cli", ...publishArgs]);

  console.info(`\n已处理 ${pkg.name}@${next}`);
  if (!options.dryRun) {
    console.info("下一步建议提交版本号：");
    console.info(`  git add apps/cli/package.json && git commit -m "chore(cli): release v${next}"`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
