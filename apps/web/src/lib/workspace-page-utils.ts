import type { MailItem } from "./mock-mail";

export type TaskFilter = "all" | "open" | "Overdue" | "Due today" | "Due tomorrow" | "Complete";

export function filterTasks(tasks: MailItem[], filter: TaskFilter): MailItem[] {
  if (filter === "all") return tasks;
  if (filter === "open") return tasks.filter((task) => task.status !== "Complete");
  return tasks.filter((task) => task.status === filter);
}
