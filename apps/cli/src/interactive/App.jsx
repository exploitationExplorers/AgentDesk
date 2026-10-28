import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, useApp, useInput } from "ink";
import { apiRequest as defaultApiRequest, consumeSse as defaultConsumeSse } from "../client.mjs";
import ConversationPicker from "./ConversationPicker.jsx";
import { createInitialSession, sessionReducer } from "./chat-reducer.mjs";
import InputBar from "./InputBar.jsx";
import LiveTurnView from "./LiveTurnView.jsx";
import StatusBar from "./StatusBar.jsx";
import TurnView from "./TurnView.jsx";

function findPendingApproval(live) {
  if (!live) return null;
  return live.steps.find((step) => step.kind === "approval" && !step.resolved) ?? null;
}

function initSession({ conversationId, initialMessages }) {
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
  apiRequest = defaultApiRequest,
  consumeSse = defaultConsumeSse,
}) {
  const { exit } = useApp();
  const [session, dispatch] = useReducer(
    sessionReducer,
    { conversationId, initialMessages },
    initSession,
  );
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const controllerRef = useRef(null);
  const approvalResolveRef = useRef(null);

  // CLI-18：显式传入 --conversation 时跳过选择器；否则启动时拉取会话列表，交给用户续接或新建。
  const explicitConversation = conversationId != null;
  const [uiMode, setUiMode] = useState("chat");
  const [conversations, setConversations] = useState([]);
  const [pickerIndex, setPickerIndex] = useState(0);

  // CLI-19：步骤焦点导航状态，只作用于当前进行中的这一轮。
  const [stepFocusActive, setStepFocusActive] = useState(false);
  const [focusedStepIndex, setFocusedStepIndex] = useState(0);
  const [focusOverrides, setFocusOverrides] = useState(() => new Set());

  const busy = session.status !== "idle";
  const toolSteps = session.live ? session.live.steps.filter((step) => step.kind === "tool") : [];
  const focusedStepId = toolSteps[focusedStepIndex]?.id ?? null;
  const liveActive = session.live !== null;

  const submit = useCallback(
    async (message) => {
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
            conversationId: session.conversationId ?? undefined,
          }),
          signal: controller.signal,
        });
        if (!response.body) throw new Error("服务未返回事件流。");
        await consumeSse(response.body, async (event) => {
          dispatch(event);
          if (event.type === "approval_required") {
            const approved = await new Promise((resolve) => {
              approvalResolveRef.current = resolve;
            });
            approvalResolveRef.current = null;
            dispatch({ type: "APPROVAL_ANSWERED", approvalId: event.approvalId, approved });
            await apiRequest(state, `/approvals/${encodeURIComponent(event.approvalId)}`, {
              method: "POST",
              body: JSON.stringify({ approved }),
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
        if (controllerRef.current === controller) controllerRef.current = null;
        dispatch({ type: "TURN_SETTLED" });
      }
    },
    [state, agent, session.conversationId, busy, apiRequest, consumeSse],
  );

  // 跨会话审批角标：与桌面端 ApprovalToasts 同一接口、同一 15 秒轮询频率。
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const approvals = await (await apiRequest(state, "/approvals?status=pending")).json();
        if (active) setPendingApprovals(approvals.length);
      } catch {
        // 轮询失败不打断当前会话，下一轮再试。
      }
    };
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [state, apiRequest]);

  // 启动时拉取会话列表；为空或拉取失败都不阻塞用户，直接保持新建对话。
  useEffect(() => {
    if (explicitConversation) return;
    let active = true;
    (async () => {
      try {
        const list = await (await apiRequest(state, "/conversations")).json();
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
    async (id) => {
      try {
        const response = await apiRequest(
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
        else void selectExistingConversation(conversations[pickerIndex - 1].id);
      } else if (key.escape) exit();
      return;
    }
    const pendingApproval = findPendingApproval(session.live);
    if (pendingApproval) {
      if (/^y$/i.test(character)) approvalResolveRef.current?.(true);
      else if (/^n$/i.test(character) || key.escape) approvalResolveRef.current?.(false);
      return;
    }
    if (key.ctrl && character === "c") {
      if (busy) {
        controllerRef.current?.abort();
        dispatch({ type: "ABORT_TURN" });
      } else exit();
      return;
    }
    if (character === "o" && !busy) {
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

  if (uiMode === "picker") {
    return <ConversationPicker conversations={conversations} selectedIndex={pickerIndex} />;
  }

  return (
    <Box flexDirection="column">
      <Static items={session.turns}>
        {(turn, index) => <TurnView key={index} turn={turn} expanded={expanded} theme={theme} />}
      </Static>
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
      <StatusBar
        conversationId={session.conversationId}
        pendingApprovals={pendingApprovals}
        busy={busy}
        stepFocusActive={stepFocusActive}
      />
      <InputBar
        value={input}
        onChange={setInput}
        onSubmit={(value) => {
          setInput("");
          void submit(value);
        }}
        disabled={busy}
      />
    </Box>
  );
}
