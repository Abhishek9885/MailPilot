"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ServiceErrorSchema,
  TaskListResponseSchema,
  TaskRecordSchema,
  TaskReadResponseSchema,
  TaskUpdateRequestSchema
} from "@mailpilot/shared";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { getCsrfToken } from "@/lib/csrf-token";
import { webEnvironment } from "@/lib/environment";
import { z } from "zod";
import { FollowUpManagementPanel } from "@/components/follow-up-management";

type TaskRecord = z.infer<typeof TaskRecordSchema>;
type TaskUpdate = z.infer<typeof TaskUpdateRequestSchema>;
type TaskFilter = "all" | "open" | "completed" | "dismissed" | "superseded";
type PageState = "loading" | "ready" | "error";

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "completed", label: "Completed" },
  { key: "dismissed", label: "Dismissed" },
  { key: "superseded", label: "Superseded" }
];

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return "Your session expired. Sign in again to manage tasks.";
  try {
    const parsed = ServiceErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : fallback;
  } catch {
    return fallback;
  }
}

function statusTone(status: TaskRecord["status"]): BadgeTone {
  if (status === "pending_review") return "amber";
  if (status === "active") return "blue";
  if (status === "completed") return "green";
  if (status === "dismissed") return "neutral";
  return "neutral";
}

function statusLabel(status: TaskRecord["status"]): string {
  if (status === "pending_review") return "Needs review";
  if (status === "superseded") return "Updated in a newer email";
  return status[0]?.toUpperCase() + status.slice(1);
}

function taskDueDate(task: TaskRecord): string {
  if (!task.dueAt) return "";
  return task.dueAt.slice(0, 10);
}

function dueDateDescription(task: TaskRecord): string {
  if (!task.dueAt) {
    return task.dueDateSource === "user"
      ? "Deadline cleared by you"
      : task.dueDateSource === "none"
        ? "No deadline found in the email"
        : "No due date";
  }
  switch (task.dueDateSource) {
    case "explicit": return "Explicitly stated in the email";
    case "inferred": return "Inferred from email context";
    case "user": return "Corrected by you";
    case "unknown": return "Deadline origin unknown";
    default: return "No deadline found in the email";
  }
}

function taskMatchesFilter(task: TaskRecord, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return task.status === "pending_review" || task.status === "active";
  return task.status === filter;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [pageState, setPageState] = useState<PageState>("loading");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editingId, setEditingId] = useState("");
  const [editedTitle, setEditedTitle] = useState("");
  const [editedDueDate, setEditedDueDate] = useState("");
  const [savingId, setSavingId] = useState("");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("/v1/tasks?status=all", webEnvironment.apiBaseUrl), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await apiErrorMessage(response, "Saved tasks could not be loaded."));
      const parsed = TaskListResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The task response was invalid.");
      setTasks(parsed.data.tasks);
      setLoadError("");
      setPageState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(caught instanceof Error ? caught.message : "Saved tasks could not be loaded.");
      setPageState("error");
    });
    return () => controller.abort();
  }, [loadAttempt]);

  const visibleTasks = useMemo(
    () => tasks.filter((task) => taskMatchesFilter(task, filter)),
    [filter, tasks]
  );

  const startEditing = (task: TaskRecord) => {
    setActionError("");
    setEditingId(task.id);
    setEditedTitle(task.title);
    setEditedDueDate(taskDueDate(task));
  };

  const updateTask = async (task: TaskRecord, update: TaskUpdate) => {
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      setActionError("Your session needs refreshing. Reload the page and try again.");
      return;
    }
    const validated = TaskUpdateRequestSchema.safeParse(update);
    if (!validated.success) {
      setActionError("Add a title or due date change before saving.");
      return;
    }
    setSavingId(task.id);
    setActionError("");
    try {
      const response = await fetch(new URL(`/v1/tasks/${encodeURIComponent(task.id)}`, webEnvironment.apiBaseUrl), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(validated.data)
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "The task could not be updated."));
      const parsed = TaskReadResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The updated task response was invalid.");
      setTasks((current) => current.map((item) => item.id === task.id ? parsed.data.task : item));
      setEditingId("");
      setAnnouncement(validated.data.status === "completed"
        ? "Task marked complete."
        : validated.data.status === "dismissed"
          ? "Task dismissed."
          : "Task saved. Your changes will be kept when this email is analyzed again.");
    } catch (caught: unknown) {
      setActionError(caught instanceof Error ? caught.message : "The task could not be updated.");
    } finally {
      setSavingId("");
    }
  };

  const saveEdit = (event: FormEvent<HTMLFormElement>, task: TaskRecord) => {
    event.preventDefault();
    const patch: TaskUpdate = {};
    if (editedTitle.trim() !== task.title) patch.title = editedTitle.trim();
    if (editedDueDate !== taskDueDate(task)) patch.dueDate = editedDueDate || null;
    void updateTask(task, patch);
  };

  return (
    <div className="page-content-stack">
      <FollowUpManagementPanel />
      <div aria-live="polite" className="visually-hidden">{announcement}</div>
      <Card className="task-board-card">
        <div className="task-board__header">
          <div>
            <p className="feature-eyebrow">From your mailbox</p>
            <h2>Tasks from conversations</h2>
            <p>AI action items are proposals. Review, correct, complete, or dismiss them here.</p>
          </div>
          <div className="task-board__toolbar">
            <Badge tone="neutral">{visibleTasks.length} shown</Badge>
            <Button disabled={pageState === "loading"} onClick={() => {
              setPageState("loading");
              setLoadAttempt((attempt) => attempt + 1);
            }} size="sm" variant="secondary">Refresh</Button>
          </div>
        </div>
        {pageState === "ready" && (
          <div aria-label="Filter tasks by status" className="task-filters" role="group">
            {FILTERS.map((option) => (
              <button
                aria-pressed={filter === option.key}
                className={filter === option.key ? "filter-chip filter-chip--active" : "filter-chip"}
                key={option.key}
                onClick={() => setFilter(option.key)}
                type="button"
              >{option.label}</button>
            ))}
          </div>
        )}
        {actionError && pageState === "ready" && <p className="task-page-error" role="alert">{actionError}</p>}
        {pageState === "loading" ? (
          <div className="task-list-loading"><LoadingRows label="Loading saved tasks" rows={4} /></div>
        ) : pageState === "error" ? (
          <ErrorState description={loadError} onRetry={() => {
            setPageState("loading");
            setLoadAttempt((attempt) => attempt + 1);
          }} title="Tasks unavailable" />
        ) : tasks.length === 0 ? (
          <div className="task-empty" role="status">
            <strong>No task proposals yet</strong>
            <span>Analyze a synced email with action items to add source-linked tasks here.</span>
            <Link className="button button--secondary button--md" href="/inbox">Open synced emails</Link>
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="task-empty" role="status">
            <strong>No tasks match this filter.</strong>
            <Button onClick={() => setFilter("all")} variant="secondary">Show all tasks</Button>
          </div>
        ) : (
          <ul className="managed-task-list">
            {visibleTasks.map((task) => {
              const canChange = task.status === "pending_review" || task.status === "active";
              const isEditing = editingId === task.id;
              return (
                <li className="managed-task" key={task.id}>
                  <div className="managed-task__heading">
                    <div>
                      <div className="task-list__title">
                        <h3>{task.title}</h3>
                        <Badge tone={statusTone(task.status)}>{statusLabel(task.status)}</Badge>
                      </div>
                      <p className="managed-task__owner">Assigned to: {task.assignee.replaceAll("_", " ")}</p>
                    </div>
                    {canChange && !isEditing && (
                      <div className="managed-task__actions">
                        <Button disabled={savingId === task.id} onClick={() => startEditing(task)} size="sm" variant="secondary">Edit</Button>
                        <Button disabled={savingId === task.id} onClick={() => { void updateTask(task, { status: "completed" }); }} size="sm">Complete</Button>
                        <Button disabled={savingId === task.id} onClick={() => { void updateTask(task, { status: "dismissed" }); }} size="sm" variant="ghost">Dismiss</Button>
                      </div>
                    )}
                  </div>

                  {isEditing && (
                    <form className="managed-task__editor" onSubmit={(event) => saveEdit(event, task)}>
                      <TextField
                        autoComplete="off"
                        id={`task-title-${task.id}`}
                        label="Task title"
                        maxLength={500}
                        onChange={(event) => setEditedTitle(event.currentTarget.value)}
                        required
                        value={editedTitle}
                      />
                      <TextField
                        id={`task-due-${task.id}`}
                        label="Due date"
                        onChange={(event) => setEditedDueDate(event.currentTarget.value)}
                        type="date"
                        value={editedDueDate}
                      />
                      <p>Clearing the date records that you removed the deadline. Saving an edit moves the task to active.</p>
                      <div className="managed-task__actions">
                        <Button disabled={savingId === task.id} onClick={() => setEditingId("")} size="sm" variant="ghost">Cancel</Button>
                        <Button disabled={savingId === task.id || (editedTitle.trim() === task.title && editedDueDate === taskDueDate(task))} size="sm" type="submit">
                          {savingId === task.id ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    </form>
                  )}

                  <div className="managed-task__deadline">
                    <strong>{task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : "No due date"}</strong>
                    <Badge tone={task.dueDateSource === "explicit" ? "green" : task.dueDateSource === "inferred" ? "amber" : task.dueDateSource === "user" ? "blue" : "neutral"}>
                      {dueDateDescription(task)}
                    </Badge>
                  </div>

                  {task.sourceEmail ? (
                    <section aria-label="Source email" className="managed-task__source">
                      <h4>Source email</h4>
                      <Link href={`/inbox?emailId=${encodeURIComponent(task.sourceEmail.id)}`}>
                        {task.sourceEmail.subject || "Open source email"}
                      </Link>
                      <p>{[task.sourceEmail.senderName, task.sourceEmail.senderEmail, `Thread ${task.sourceThreadId}`, `Message ${task.sourceEmailId}`].filter(Boolean).join(" · ")}</p>
                      {task.sourceEvidence && <blockquote>{task.sourceEvidence}</blockquote>}
                    </section>
                  ) : (
                    <p className="managed-task__source-missing">No source email is attached to this task.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
