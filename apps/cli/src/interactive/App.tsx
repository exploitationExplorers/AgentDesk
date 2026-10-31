import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgentStreamEvent, Conversation } from "@agentdesk/shared";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import {
  apiRequest as defaultApiRequest,
  consumeSse as defaultConsumeSse,
  type ApiState,
} from "../client.js";
import ConversationPicker from "./ConversationPicker.js";
import { createInitialSession, sessionReducer } from "./chat-reducer.js";
import InputBar from "./InputBar.js";
import LiveTurnView from "./LiveTurnView.js";
import StatusBar from "./StatusBar.js";
import { transcriptItems, visibleLiveTurn } from "./transcript.js";
import Welcome, { type WelcomeProps } from "./Welcome.js";
import StepRow from "./StepRow.js";
import ApprovalCard from "./ApprovalCard.js";
import { renderMarkdown } from "./markdown.js";
import type { HistoryMessage, Turn } from "./types.js";
import { useApprovalWaiter } from "./useApprovalWaiter.js";
import CommandPanel from "./CommandPanel.js";
import { commandSuggestions } from "./slash-commands.js";
import { useSlashCommands } from "./useSlashCommands.js";

export interface AppProps extends WelcomeProps {
  state: ApiState;
  conversationId?: string;
  initialMessages?: HistoryMessage[];
  workspace?: string;
  theme: NonNullable<WelcomeProps["theme"]>;
  apiRequest?: typeof defaultApiRequest;
  consumeSse?: (
    body: ReadableStream<Uint8Array>,
    onEvent: (event: AgentStreamEvent) => void | Promise<void>,
  ) => Promise<void>;
}

function findPendingApproval(live: Turn | null) {
  if (!live) return null;
  return live.steps.find((step) => step.kind === "approval" && !step.resolved) ?? null;
}

function terminalRows(stdout: NodeJS.WritableStream): number {
  return "rows" in stdout && typeof stdout.rows === "number" ? stdout.rows : 24;
}

function initSession({
  conversationId,
  initialMessages,
}: Pick<AppProps, "conversationId" | "initialMessages">) {
  const base = createInitialSession();
  if (!initialMessages) return { ...base, conversationId: conversationId ?? null };
  return sessionReducer(base, {
    type: "RESUME",
    conversationId: conversationId ?? null,
    messages: initialMessages,
  });
}

export default function App({
  state,
  agent: initialAgent,
  conversationId,
  initialMessages,
  theme: initialTheme,
  model,
  version = "0.1.0",
  cwd = process.cwd(),
  workspace,
  workbenchCommand,
  apiRequest = defaultApiRequest,
  consumeSse = defaultConsumeSse,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState(() => terminalRows(stdout));
  useEffect(() => {
    const resize = () => setRows(terminalRows(stdout));
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  const [session, dispatch] = useReducer(
    sessionReducer,
    { conversationId, initialMessages },
    initSession,
  );
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [transcriptVersion, setTranscriptVersion] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef("");
  const inputTouched = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const { pendingCount, waitForApproval, answerLocally } = useApprovalWaiter(state, apiRequest);
  useEffect(() => () => controllerRef.current?.abort(), []);

  // CLI-18：显式传入 --conversation 时跳过选择器；否则启动时拉取会话列表，交给用户续接或新建。
  const explicitConversation = conversationId != null;
  const [uiMode, setUiMode] = useState("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);

  // CLI-19：步骤焦点导航状态，只作用于当前进行中的这一轮。
  const [stepFocusActive, setStepFocusActive] = useState(false);
  const [focusedStepIndex, setFocusedStepIndex] = useState(0);
  const [focusOverrides, setFocusOverrides] = useState(() => new Set<string>());

  const resetConversation = (id?: string, messages?: HistoryMessage[]) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "RESET", conversationId: id, messages });
    setTranscriptVersion((value) => value + 1);
    setUiMode("chat");
    if ("isTTY" in stdout && stdout.isTTY) stdout.write("\x1b[2J\x1b[H");
  };
  const commands = useSlashCommands({
    state,
    apiRequest,
    initialAgent,
    initialModel: model,
    initialTheme,
    conversationId: session.conversationId,
    cwd,
    version,
    expanded,
    setExpanded,
    onNew: () => resetConversation(),
    onResume: resetConversation,
    onResult: (command, text) => dispatch({ type: "LOCAL_RESULT", command, text }),
    onExit: exit,
  });
  const { agent, theme } = commands;
  const suggestions =
    !commands.panel && !commands.loading && dismissedInput !== input
      ? commandSuggestions(input)
      : [];
  const filteredItems = commands.panel?.items?.filter((item) =>
    `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(input.toLowerCase()),
  );
  const menuCount = commands.panel
    ? (filteredItems?.length ?? commands.panel.lines?.length ?? 0)
    : suggestions.length;
  const activeMenuIndex = Math.min(menuIndex, Math.max(0, menuCount - 1));
  const changeInput = (value: string) => {
    inputTouched.current = true;
    setInput(value);
    setMenuIndex(0);
    setDismissedInput(null);
    setHistoryIndex(null);
  };
  const closePanel = () => {
    commands.cancel();
    setInput("");
    setMenuIndex(0);
  };
  useEffect(() => {
    setMenuIndex(0);
  }, [commands.panel]);

  const busy = session.status !== "idle";
  const live = session.live ? visibleLiveTurn(session.live) : null;
  const toolSteps = live ? live.steps.filter((step) => step.kind === "tool") : [];
  const focusedStepId = toolSteps[focusedStepIndex]?.id ?? null;
  const liveActive = session.live !== null;

  const submit = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || busy) return;
      dispatch({ type: "SUBMIT", message: trimmed });
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const response = await apiRequest(state, "/chat", {
          method: "POST",
          body: JSON.stringify({
            message: trimmed,
            agent,
            modelSelection: commands.selection,
            workspace,
            conversationId: session.conversationId ?? undefined,
          }),
          signal: controller.signal,
        });
        if (!response.body) throw new Error("服务未返回事件流。");
        await consumeSse(response.body, async (event) => {
          if (controller.signal.aborted || controllerRef.current !== controller) return;
          dispatch(event);
          if (event.type === "approval_required") {
            const decision = await waitForApproval(event.approvalId, controller.signal);
            if (!decision || controller.signal.aborted) return;
            if (decision.source === "local") {
              await apiRequest(state, `/approvals/${encodeURIComponent(event.approvalId)}`, {
                method: "POST",
                body: JSON.stringify({ approved: decision.approved }),
                signal: controller.signal,
              });
            }
            dispatch({
              type: "APPROVAL_ANSWERED",
              approvalId: event.approvalId,
              approved: decision.approved,
            });
          }
        });
      } catch (error) {
        if (!controller.signal.aborted)
          dispatch({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          dispatch({ type: "TURN_SETTLED" });
        }
      }
    },
    [
      state,
      agent,
      commands.selection,
      workspace,
      session.conversationId,
      busy,
      apiRequest,
      consumeSse,
      waitForApproval,
    ],
  );

  // 启动时拉取会话列表；为空或拉取失败都不阻塞用户，直接保持新建对话。
  useEffect(() => {
    if (explicitConversation) return;
    let active = true;
    (async () => {
      try {
        const list = await (await apiRequest<Conversation[]>(state, "/conversations")).json();
        if (!active || !list.length || inputTouched.current) return;
        setConversations(list);
        setUiMode("picker");
      } catch (error) {
        if (!active) return;
        process.stderr.write(
          `读取历史会话列表失败，已新建对话：${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [explicitConversation, state, apiRequest]);

  // 新一轮开始时重置上一轮遗留的步骤焦点状态，历史轮次本身不支持焦点导航。
  useEffect(() => {
    if (!liveActive) {
      setStepFocusActive(false);
      setFocusedStepIndex(0);
      setFocusOverrides(new Set());
    }
  }, [liveActive]);

  const selectNewConversation = useCallback(() => setUiMode("chat"), []);

  const selectExistingConversation = useCallback(
    async (id: string) => {
      try {
        const response = await apiRequest<HistoryMessage[]>(
          state,
          `/conversations/${encodeURIComponent(id)}/messages`,
        );
        const messages = await response.json();
        dispatch({ type: "RESUME", conversationId: id, messages });
      } catch (error) {
        process.stderr.write(
          `读取会话历史失败，已新建对话：${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        setUiMode("chat");
      }
    },
    [state, apiRequest],
  );

  // 选择器和聊天快捷键共用稳定的监听；InputBar 也保持订阅，只在回调内判断焦点，避免切换时丢键。
  useInput((character, key) => {
    if (commands.panel || commands.loading) {
      if (key.escape || (key.ctrl && character === "c")) closePanel();
      else if (!commands.loading && key.upArrow) setMenuIndex(Math.max(0, activeMenuIndex - 1));
      else if (!commands.loading && key.downArrow)
        setMenuIndex(Math.min(menuCount - 1, activeMenuIndex + 1));
      else if (!commands.loading && key.return && !commands.panel?.items) closePanel();
      return;
    }
    if (uiMode === "picker") {
      const itemCount = conversations.length + 1;
      if (key.upArrow || character === "k") setPickerIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow || character === "j")
        setPickerIndex((index) => Math.min(itemCount - 1, index + 1));
      else if (key.return) {
        if (pickerIndex === 0) selectNewConversation();
        else {
          const selected = conversations[pickerIndex - 1];
          if (selected) void selectExistingConversation(selected.id);
        }
      } else if (key.escape || (key.ctrl && character === "c")) exit();
      return;
    }
    const pendingApproval = findPendingApproval(session.live);
    if (key.ctrl && character === "c" && pendingApproval) {
      controllerRef.current?.abort();
      dispatch({ type: "ABORT_TURN" });
      return;
    }
    if (pendingApproval) {
      if (/^y$/i.test(character)) answerLocally(true);
      else if (/^n$/i.test(character) || key.escape) answerLocally(false);
      return;
    }
    if (key.ctrl && character === "c") {
      if (busy) {
        controllerRef.current?.abort();
        dispatch({ type: "ABORT_TURN" });
      } else if (input) changeInput("");
      else exit();
      return;
    }
    if (key.escape && !stepFocusActive) {
      if (busy) {
        controllerRef.current?.abort();
        dispatch({ type: "ABORT_TURN" });
      } else if (suggestions.length) setDismissedInput(input);
      return;
    }
    if (key.ctrl && character === "o") {
      setExpanded((value) => !value);
      setFocusOverrides(new Set());
      return;
    }
    if (key.tab) {
      if (suggestions.length && !busy) {
        const selected = suggestions[activeMenuIndex];
        if (selected) changeInput(`/${selected.name} `);
        return;
      }
      if (stepFocusActive) setStepFocusActive(false);
      else if (toolSteps.length > 0) {
        setStepFocusActive(true);
        setFocusedStepIndex(0);
      }
      return;
    }
    if (!busy && !stepFocusActive && (key.upArrow || key.downArrow)) {
      if (suggestions.length) {
        setMenuIndex(
          (activeMenuIndex + (key.upArrow ? -1 : 1) + suggestions.length) % suggestions.length,
        );
      } else if (inputHistory.length) {
        if (historyIndex === null) draftRef.current = input;
        const next = key.upArrow
          ? Math.max(0, (historyIndex ?? inputHistory.length) - 1)
          : Math.min(inputHistory.length, (historyIndex ?? inputHistory.length) + 1);
        setHistoryIndex(next === inputHistory.length ? null : next);
        setInput(next === inputHistory.length ? draftRef.current : (inputHistory[next] ?? ""));
        setDismissedInput(
          next === inputHistory.length ? draftRef.current : (inputHistory[next] ?? ""),
        );
      }
      return;
    }
    if (stepFocusActive) {
      if (key.escape) {
        setStepFocusActive(false);
        return;
      }
      if (key.upArrow || character === "k") {
        setFocusedStepIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow || character === "j") {
        setFocusedStepIndex((index) => Math.min(toolSteps.length - 1, index + 1));
        return;
      }
      if (key.return || character === " ") {
        const id = toolSteps[focusedStepIndex]?.id;
        if (id !== undefined)
          setFocusOverrides((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
      }
    }
  });

  const history = transcriptItems(session.turns, session.live);
  return (
    <Box flexDirection="column">
      <Static key={transcriptVersion} items={history}>
        {(item, index) => {
          if (item.kind === "welcome")
            return (
              <Welcome
                key="welcome"
                {...{ agent, version, cwd, theme, workbenchCommand }}
                model={commands.modelLabel}
              />
            );
          if (item.kind === "user")
            return (
              <Text key={index} color="blue">
                {"› "}
                {item.text}
              </Text>
            );
          if (item.kind === "step")
            return <StepRow key={index} step={item.step} expanded={expanded} theme={theme} />;
          if (item.kind === "approval") return <ApprovalCard key={index} {...item.step} />;
          if (item.kind === "answer")
            return <Text key={index}>{renderMarkdown(item.text, theme)}</Text>;
          return (
            <Text key={index} color="red">
              {item.text}
            </Text>
          );
        }}
      </Static>
      {uiMode === "picker" ? (
        <ConversationPicker conversations={conversations} selectedIndex={pickerIndex} />
      ) : (
        <Box
          flexDirection="column"
          minHeight={
            !session.live && session.turns.length === 0 ? Math.max(6, rows - 8) : undefined
          }
        >
          {!session.live && session.turns.length === 0 ? <Box flexGrow={1} /> : null}
          {live ? (
            <LiveTurnView
              live={live}
              expanded={expanded}
              theme={theme}
              stepFocusActive={stepFocusActive}
              focusedStepId={focusedStepId}
              focusOverrides={focusOverrides}
              maxRows={Math.max(6, rows - 7)}
            />
          ) : null}
          {commands.panel ? (
            <CommandPanel
              panel={{ ...commands.panel, items: filteredItems }}
              index={activeMenuIndex}
              limit={Math.max(3, rows - 12)}
              color={theme.color}
            />
          ) : null}
          {suggestions.length > 0 && !busy ? (
            <CommandPanel
              panel={{
                title: "指令",
                items: suggestions.map((item) => ({
                  id: item.name,
                  label: `/${item.name}`,
                  detail: item.description,
                })),
              }}
              index={activeMenuIndex}
              limit={Math.max(3, Math.min(7, rows - 12))}
              color={theme.color}
            />
          ) : null}
          {commands.loading ? <Text dimColor>正在执行指令… Esc 取消</Text> : null}
          <InputBar
            value={input}
            onChange={changeInput}
            onSubmit={(value) => {
              if (commands.loading || busy) return;
              if (commands.panel) {
                const item = filteredItems?.[activeMenuIndex];
                if (item) {
                  setInput("");
                  void commands.panel.onSelect?.(item.id);
                }
                return;
              }
              const selected = suggestions[activeMenuIndex];
              const message = selected ? `/${selected.name}` : value;
              if (!message.trim()) return;
              inputTouched.current = true;
              setInput("");
              setMenuIndex(0);
              setHistoryIndex(null);
              setInputHistory((items) =>
                items.at(-1) === message ? items : [...items.slice(-199), message],
              );
              if (message.trim().startsWith("/")) void commands.execute(message);
              else void submit(message);
            }}
            disabled={busy || commands.loading}
            focused={!stepFocusActive && (!commands.panel || Boolean(commands.panel.items))}
            placeholder={commands.panel?.items ? "输入关键词筛选…" : "输入消息，或 / 查看指令"}
            color={theme.color}
          />
          <StatusBar
            conversationId={session.conversationId}
            pendingApprovals={pendingCount}
            busy={busy}
            stepFocusActive={stepFocusActive}
            model={commands.modelLabel}
            agent={commands.agent}
          />
        </Box>
      )}
    </Box>
  );
}
