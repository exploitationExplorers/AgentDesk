import type { Task } from "@agentdesk/shared";
import { Status } from "./components";
import { displayTime } from "./hooks";

const running = (status: string) =>
  ["queued", "planning", "running"].includes(status) || status.startsWith("awaiting_");

export function TaskRows({
  tasks,
  projectName,
  onSelect,
}: {
  tasks: Task[];
  projectName?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="m-task-cards">
      {tasks.map((task) => {
        const active = running(task.status);
        return (
          <button
            key={task.id}
            type="button"
            className="m-task-card"
            onClick={() => onSelect(task.id)}
          >
            <h3>{task.title || "未命名任务"}</h3>
            <p>{projectName || task.agent || "远程任务"}</p>
            <div className="m-task-card-meta">
              <Status value={task.status} />
              <span>{active ? displayTime(task.updatedAt) : "结果已就绪"}</span>
            </div>
            {active && (
              <div className="m-task-progress" aria-hidden="true">
                <i />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
