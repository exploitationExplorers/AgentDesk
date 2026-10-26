import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  completeText,
  extractJson,
  type ModelResolver,
  type SkillRegistry,
} from "@agentdesk/agent-core";
import { run } from "@agentdesk/integrations";
import { AppError, ErrorCode } from "@agentdesk/shared";
import { errorMessage, localDate, newId, nowIso } from "../util";

export interface WechatGroup {
  username: string;
  displayName: string;
  nickName: string;
  remark: string;
  messageCount: number;
}

export type WechatReportPhase =
  "queued" | "analyzing" | "writing" | "rendering" | "succeeded" | "failed";

export interface WechatReportJob {
  id: string;
  chatroom: string;
  date: string;
  status: WechatReportPhase;
  logs: string[];
  error?: string;
  reportFile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WechatSkillStatus {
  skillDir: string;
  decryptedReady: boolean;
  decryptedDir: string;
  pythonOk: boolean;
  python?: string;
  message: string;
}

const SKILL_NAME = "wechat-daily-report";

export class WechatReportService {
  private readonly jobs = new Map<string, WechatReportJob>();
  private pythonBin: string | null = null;

  constructor(
    private readonly skills: SkillRegistry,
    private readonly providers: ModelResolver,
    private readonly dataDir: string,
  ) {}

  private skillDir(): string {
    const skill = this.skills.get(SKILL_NAME);
    if (!skill)
      throw new AppError(
        ErrorCode.NotFound,
        "未找到私有技能 wechat-daily-report，请将技能安装到数据目录的 skills 文件夹或 AGENTDESK_SKILLS_DIR 后重启",
      );
    return skill.dir;
  }

  private reportsDir(): string {
    return join(this.dataDir, "wechat-reports");
  }

  private async resolvePython(): Promise<string> {
    if (this.pythonBin) return this.pythonBin;
    for (const candidate of ["python", "py"]) {
      const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
      const result = await run(candidate, args, { timeoutMs: 8_000 });
      if (result.code === 0) {
        this.pythonBin = candidate === "py" ? "py" : "python";
        return this.pythonBin;
      }
    }
    throw new AppError(
      ErrorCode.BadRequest,
      "未找到 Python，请安装 Python 3.10+ 并确保 python 在 PATH 中",
    );
  }

  private async pythonArgs(
    scriptRel: string,
    extra: string[],
  ): Promise<{ bin: string; args: string[] }> {
    const bin = await this.resolvePython();
    const script = join(this.skillDir(), "scripts", scriptRel);
    return bin === "py"
      ? { bin, args: ["-3", script, ...extra] }
      : { bin, args: [script, ...extra] };
  }

  private async runPython(scriptRel: string, extra: string[], cwd?: string): Promise<string> {
    const { bin, args } = await this.pythonArgs(scriptRel, extra);
    const result = await run(bin, args, {
      cwd: cwd ?? this.skillDir(),
      timeoutMs: 10 * 60_000,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-2000);
      throw new AppError(
        ErrorCode.Internal,
        `脚本 ${scriptRel} 失败：${detail || `exit ${result.code}`}`,
      );
    }
    return result.stdout;
  }

  async status(): Promise<WechatSkillStatus> {
    const skillDir = this.skillDir();
    const decryptedDir = join(skillDir, "decrypted");
    let decryptedReady = false;
    try {
      await access(join(decryptedDir, "contact", "contact.db"));
      decryptedReady = true;
    } catch {
      decryptedReady = false;
    }
    let pythonOk = false;
    let python: string | undefined;
    try {
      python = await this.resolvePython();
      pythonOk = true;
    } catch {
      pythonOk = false;
    }
    return {
      skillDir,
      decryptedReady,
      decryptedDir,
      pythonOk,
      python,
      message: !pythonOk
        ? "需要先安装 Python 3.10+（pip install jieba jinja2 pillow）"
        : !decryptedReady
          ? "尚未解密微信数据库：请保持微信登录，以管理员运行解密后再试"
          : "就绪：可列出群聊并生成日报",
    };
  }

  async decrypt(): Promise<{ ok: true; message: string }> {
    await this.runPython("decrypt_wechat.py", []);
    return { ok: true, message: "解密完成" };
  }

  async listGroups(): Promise<WechatGroup[]> {
    const status = await this.status();
    if (!status.decryptedReady) {
      throw new AppError(
        ErrorCode.BadRequest,
        "解密库未就绪。请先在技能页点击「解密微信数据库」（需微信已登录，Windows 首次需管理员权限）",
      );
    }
    const stdout = await this.runPython("list_wechat_groups.py", []);
    const raw = JSON.parse(stdout) as Array<{
      username: string;
      display_name: string;
      nick_name: string;
      remark: string;
      message_count: number;
    }>;
    return raw.map((g) => ({
      username: g.username,
      displayName: g.display_name,
      nickName: g.nick_name,
      remark: g.remark,
      messageCount: g.message_count,
    }));
  }

  listJobs(): WechatReportJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(id: string): WechatReportJob {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(ErrorCode.NotFound, "日报任务不存在");
    return job;
  }

  resolveReportPath(id: string): string {
    const job = this.getJob(id);
    if (job.status !== "succeeded" || !job.reportFile) {
      throw new AppError(ErrorCode.BadRequest, "报告尚未生成");
    }
    const safe = basename(job.reportFile);
    return join(this.reportsDir(), safe);
  }

  startReport(input: { chatroom: string; date?: string }): WechatReportJob {
    const chatroom = input.chatroom.trim();
    if (!chatroom) throw new AppError(ErrorCode.BadRequest, "请选择群聊");
    const date = (input.date?.trim() || localDate()).slice(0, 10);
    const job: WechatReportJob = {
      id: newId(),
      chatroom,
      date,
      status: "queued",
      logs: ["任务已创建"],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.jobs.set(job.id, job);
    void this.runJob(job.id).catch((error) => {
      this.patch(job.id, {
        status: "failed",
        error: errorMessage(error),
        logs: [...(this.jobs.get(job.id)?.logs ?? []), `失败：${errorMessage(error)}`],
      });
    });
    return job;
  }

  private patch(id: string, patch: Partial<WechatReportJob>): WechatReportJob {
    const current = this.getJob(id);
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.jobs.set(id, next);
    return next;
  }

  private log(id: string, line: string): void {
    const job = this.getJob(id);
    this.patch(id, { logs: [...job.logs, line] });
  }

  private async runJob(id: string): Promise<void> {
    const job = this.getJob(id);
    const status = await this.status();
    if (!status.pythonOk) throw new AppError(ErrorCode.BadRequest, status.message);
    if (!status.decryptedReady) throw new AppError(ErrorCode.BadRequest, status.message);

    const workDir = join(this.reportsDir(), id);
    await mkdir(workDir, { recursive: true });
    const statsPath = join(workDir, "stats.json");
    const textPath = join(workDir, "simplified_chat.txt");
    const aiPath = join(workDir, "ai_content.json");
    const reportName = `report-${id.slice(0, 8)}.png`;
    const reportPath = join(this.reportsDir(), reportName);

    this.patch(id, { status: "analyzing" });
    this.log(id, `分析群聊「${job.chatroom}」· ${job.date}`);
    await this.runPython(
      "analyze_chat.py",
      [
        "--chatroom",
        job.chatroom,
        "--date",
        job.date,
        "--skip-refresh",
        "--output-stats",
        statsPath,
        "--output-text",
        textPath,
      ],
      this.skillDir(),
    );
    this.log(id, "统计完成，开始生成 AI 文案");

    this.patch(id, { status: "writing" });
    this.log(id, "正在调用模型生成文案（通常 30–90 秒，超时 3 分钟）…");
    const aiContent = await this.generateAiContent(statsPath, textPath);
    await writeFile(aiPath, JSON.stringify(aiContent, null, 2), "utf8");
    this.log(id, "AI 文案已写入，开始渲染长图");

    this.patch(id, { status: "rendering" });
    await this.runPython(
      "generate_report.py",
      ["--stats", statsPath, "--ai-content", aiPath, "--output", reportPath],
      this.skillDir(),
    );

    await access(reportPath);
    this.patch(id, {
      status: "succeeded",
      reportFile: reportName,
      logs: [...this.getJob(id).logs, `完成：${reportName}`],
    });
  }

  private slimStats(stats: Record<string, unknown>): Record<string, unknown> {
    const top = Array.isArray(stats.top_talkers) ? stats.top_talkers.slice(0, 8) : [];
    const ranking = Array.isArray(stats.all_members_ranking)
      ? stats.all_members_ranking.slice(0, 15)
      : [];
    const cloud = Array.isArray(stats.word_cloud) ? stats.word_cloud.slice(0, 30) : [];
    return {
      meta: stats.meta,
      top_talkers: top,
      all_members_ranking: ranking,
      night_owl: stats.night_owl,
      word_cloud: cloud,
    };
  }

  private async generateAiContent(statsPath: string, textPath: string): Promise<unknown> {
    const [statsRaw, chatRaw] = await Promise.all([
      readFile(statsPath, "utf8"),
      readFile(textPath, "utf8").catch(() => ""),
    ]);
    const stats = JSON.parse(statsRaw) as Record<string, unknown> & {
      top_talkers?: Array<{ name: string }>;
      raw_text_paths?: string[];
    };
    let chat = chatRaw;
    if (stats.raw_text_paths?.length) {
      const parts: string[] = [];
      for (const p of stats.raw_text_paths) {
        try {
          parts.push(await readFile(p, "utf8"));
        } catch {
          /* ignore missing chunk */
        }
      }
      if (parts.length) chat = parts.join("\n");
    }
    const topNames = (stats.top_talkers ?? []).slice(0, 5).map((t) => t.name);
    const slim = this.slimStats(stats);
    const chatTrimmed = chat.length > 10_000 ? `${chat.slice(0, 10_000)}\n…(已截断)` : chat;
    const models = await this.providers.resolve("orchestrator");
    if (models.length === 0) {
      throw new AppError(ErrorCode.BadRequest, "没有可用的模型 Provider，请先在设置里配置并绑定");
    }

    const systemPrompt = `你是微信群聊日报文案助手。风格：幽默、玩梗、有画面感，但事实必须来自输入数据。
只输出一个合法 JSON 对象（不要 Markdown 围栏），字段：
- topics: [{title, category, summary, keywords[], mention_count}] 3-5 个
- resources: [{type, title, sharer, time, category, description, key_points[], url}]
- important_messages: [{priority, sender, time, summary, content}]
- dialogues: [{topic, messages:[{name,time,content,avatar_color}], highlight}] 2-4 段
- qas: [{questioner, question_time, question, tags[], answerer, answer_time, answer, is_best}] 恰好 3 条
- topic_heat: [{name, count, percent, color}]
- talker_profiles: { "昵称": { persona, traits: string[] } } —— key 必须与 top_talkers.name 完全一致，至少覆盖前 3 名
- clickbait_title: string
- mood: { summary, timeline:[{hour,value}] }
- meme_awards: [{award, winner, detail}] 2-4 个`;

    let text: string;
    try {
      text = await completeText({
        models,
        systemPrompt,
        prompt: [
          `精简统计：\n${JSON.stringify(slim)}`,
          `精简聊天：\n${chatTrimmed}`,
          topNames.length ? `talker_profiles 的 key 必须完全等于：${topNames.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        maxTokens: 4_500,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      const msg = errorMessage(error);
      if (/aborted|timeout|TimeoutError/i.test(msg)) {
        throw new AppError(
          ErrorCode.ProviderUnavailable,
          "模型生成文案超时（3 分钟）。请检查 Provider，或换消息更少的日期再试。",
        );
      }
      throw error;
    }

    try {
      return extractJson(text);
    } catch (error) {
      throw new AppError(ErrorCode.Internal, `AI 未返回合法 JSON：${errorMessage(error)}`);
    }
  }
}
