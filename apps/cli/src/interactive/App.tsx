import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgentStreamEvent, Conversation } from "@agentdesk/shared";
import { Box, Static, useApp, useInput, useStdout } from "ink";
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
import TurnView from "./TurnView.js";
import Welcome, { type WelcomeProps } from "./Welcome.js";
import type { HistoryMessage, Turn } from "./types.js";
import { useApprovalWaiter } from "./useApprovalWaiter.js";

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
  agent,
  conversationId,
  initialMessages,
  theme,
  model,
  version,
  cwd,
  workspace,
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

  const busy = session.status !== "idle";
  const toolSteps = session.live ? session.live.steps.filter((step) => step.kind === "tool") : [];
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
        if (!active || !list.length) return;
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

  // 单一 useInput：选择器与聊天界面共用同一个 raw-mode 监听，避免在多个 useInput 之间切换 isActive
  // 导致 raw mode 交接出现竞态（选择器曾因此完全收不到按键）。
  useInput((character, key) => {
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
      } else if (key.escape) exit();
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
      } else exit();
      return;
    }
    if (key.ctrl && character === "o") {
      setExpanded((value) => !value);
      setFocusOverrides(new Set());
      return;
    }
    if (key.tab) {
      if (stepFocusActive) setStepFocusActive(false);
      else if (toolSteps.length > 0) {
        setStepFocusActive(true);
        setFocusedStepIndex(0);
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

  return (
    <Box flexDirection="column">
      <Static items={[null, ...session.turns]}>
        {(turn, index) =>
          turn ? (
            <TurnView key={index} turn={turn} expanded={expanded} theme={theme} />
          ) : (
            <Welcome key="welcome" {...{ agent, model, version, cwd, theme }} />
          )
        }
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
          {session.live ? (
            <LiveTurnView
              live={session.live}
              expanded={expanded}
              theme={theme}
              stepFocusActive={stepFocusActive}
              focusedStepId={focusedStepId}
              focusOverrides={focusOverrides}
            />
          ) : null}
          <InputBar
            value={input}
            onChange={setInput}
            onSubmit={(value) => {
              setInput("");
              void submit(value);
            }}
            disabled={busy}
            focused={!stepFocusActive}
          />
          <StatusBar
            conversationId={session.conversationId}
            pendingApprovals={pendingCount}
            busy={busy}
            stepFocusActive={stepFocusActive}
          />
        </Box>
      )}
    </Box>
  );
}
