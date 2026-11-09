import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RefreshCw, Terminal } from "lucide-react";
import { Button } from "@agentdesk/ui";
import { http } from "../../lib/http";
import "@xterm/xterm/css/xterm.css";

type ReadResult = {
  generation: number;
  reset: boolean;
  data: string;
  cursor: number;
  exitCode: number | null;
  running: boolean;
};

export function CliTerminal() {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("正在连接终端…");
  const [exited, setExited] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!container.current) return;
    const terminal = new Xterm({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: { background: "#111816", foreground: "#e4ece8", cursor: "#8be0b0" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = -1;
    let cursor = 0;
    let inputQueue = Promise.resolve();
    const fail = (error: unknown) => {
      if (!disposed) setStatus(error instanceof Error ? error.message : "终端连接失败");
    };
    const resize = () => {
      if (disposed) return;
      fit.fit();
      if (generation >= 0)
        void http
          .post("/desktop-terminal/resize", {
            generation,
            cols: terminal.cols,
            rows: terminal.rows,
          })
          .catch(fail);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData((data) => {
      if (generation < 0) return;
      inputQueue = inputQueue
        .then(() => http.post("/desktop-terminal/input", { generation, data }))
        .then(() => undefined)
        .catch(fail);
    });
    const poll = async () => {
      try {
        const result = await http.post<ReadResult>("/desktop-terminal/read", {
          generation,
          cursor,
        });
        if (disposed) return;
        if (!result.running && result.exitCode === null) {
          const started = await http.post<{ generation: number }>("/desktop-terminal/start");
          if (disposed) return;
          generation = started.generation;
          cursor = 0;
          terminal.reset();
          resize();
          timer = setTimeout(poll, 120);
          return;
        }
        if (result.reset) terminal.reset();
        generation = result.generation;
        cursor = result.cursor;
        if (result.data) terminal.write(result.data);
        if (result.exitCode !== null) {
          setExited(true);
          setStatus(`终端已退出（${result.exitCode}）`);
          return;
        }
        setStatus("已连接");
        timer = setTimeout(poll, 120);
      } catch (error) {
        fail(error);
        if (!disposed) timer = setTimeout(poll, 1500);
      }
    };
    void (async () => {
      try {
        const result = await http.post<{ generation: number }>("/desktop-terminal/start");
        if (disposed) return;
        generation = result.generation;
        resize();
        terminal.focus();
        await poll();
      } catch (error) {
        fail(error);
      }
    })();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [attempt]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="CLI 终端">
      <div className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
        <Terminal className="h-4 w-4 text-emerald-500" />
        <h2 className="text-sm font-semibold">CLI 终端</h2>
        <span role="status" className="ml-auto text-xs text-muted">
          {status}
        </span>
        {exited && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void http
                .post("/desktop-terminal/restart")
                .then(() => {
                  setExited(false);
                  setAttempt((value) => value + 1);
                })
                .catch((error: Error) => setStatus(error.message));
            }}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            重新启动
          </Button>
        )}
        {!exited && status !== "已连接" && status !== "正在连接终端…" && (
          <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            重试
          </Button>
        )}
      </div>
      <div
        className="min-h-0 flex-1 bg-[#111816] p-4"
        onClick={() => container.current?.querySelector("textarea")?.focus()}
      >
        <div ref={container} className="h-full w-full" />
      </div>
    </section>
  );
}
