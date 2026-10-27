import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, useApp, useInput } from "ink";
import { apiRequest as defaultApiRequest, consumeSse as defaultConsumeSse } from "../client.mjs";
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

  const busy = session.status !== "idle";

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

  useInput((character, key) => {
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
    if (character === "o" && !busy) setExpanded((value) => !value);
  });

  return (
    <Box flexDirection="column">
      <Static items={session.turns}>
        {(turn, index) => <TurnView key={index} turn={turn} expanded={expanded} theme={theme} />}
      </Static>
      {session.live ? <LiveTurnView live={session.live} expanded={expanded} theme={theme} /> : null}
      <StatusBar
        conversationId={session.conversationId}
        pendingApprovals={pendingApprovals}
        busy={busy}
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
