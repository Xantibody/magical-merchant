import {
  createSignal,
  createResource,
  createEffect,
  on,
  onCleanup,
  For,
  Show,
  Switch,
  Match,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../components/Icon";
import ActionBar from "../components/ActionBar";
import MilkdownEditor from "../components/MilkdownEditor";
import MarkdownPreview from "../components/MarkdownPreview";
import ConfirmDialog from "../components/ConfirmDialog";

interface ProjectSummary {
  slug: string;
  name: string;
  description: string;
}

interface TaskSummary {
  filename: string;
  title: string;
  created: string;
  completed?: string;
  tags: string[];
  body: string;
}

type ViewMode = "list" | "edit" | "preview";

function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchProjects(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>("list_projects");
}

export default function Tasks() {
  const [selectedProject, setSelectedProject] = createSignal<string>("");
  const [projects, { refetch: refetchProjects }] = createResource(fetchProjects);
  const [tasks, { refetch: refetchTasks }] = createResource(selectedProject, (slug) => {
    if (!slug) return Promise.resolve([]);
    return invoke<TaskSummary[]>("list_active_tasks", { projectSlug: slug });
  });
  const [doneTasks, { refetch: refetchDoneTasks }] = createResource(selectedProject, (slug) => {
    if (!slug) return Promise.resolve([]);
    return invoke<TaskSummary[]>("list_done_tasks", { projectSlug: slug });
  });

  const [showProjectPicker, setShowProjectPicker] = createSignal(false);
  const [showNewProject, setShowNewProject] = createSignal(false);
  const [newProjectName, setNewProjectName] = createSignal("");
  const [newTaskTitle, setNewTaskTitle] = createSignal("");
  const [error, setError] = createSignal("");
  const [viewMode, setViewMode] = createSignal<ViewMode>("list");
  const [selectedTask, setSelectedTask] = createSignal<TaskSummary | null>(null);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [taskBody, setTaskBody] = createSignal("");
  const [taskTitle, setTaskTitle] = createSignal("");
  const [taskTagsInput, setTaskTagsInput] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let isHydrating = false;

  const parseTaskTags = (): string[] =>
    taskTagsInput()
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  const saveTask = async () => {
    const task = selectedTask();
    const slug = selectedProject();
    if (!task || !slug) return;

    setSaveStatus("saving");
    try {
      await invoke("update_task", {
        projectSlug: slug,
        filename: task.filename,
        title: taskTitle(),
        tags: parseTaskTags(),
        body: taskBody(),
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("idle");
    }
  };

  const scheduleSaveTask = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTask, 1000);
  };

  createEffect(
    on(taskBody, () => {
      if (selectedTask() && !isHydrating) scheduleSaveTask();
    }),
  );
  createEffect(
    on(taskTitle, () => {
      if (selectedTask() && !isHydrating) scheduleSaveTask();
    }),
  );
  createEffect(
    on(taskTagsInput, () => {
      if (selectedTask() && !isHydrating) scheduleSaveTask();
    }),
  );

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  createEffect(() => {
    const list = projects();
    if (list?.length && !selectedProject()) {
      setSelectedProject(list[0].slug);
    }
  });

  const currentProject = () => {
    const slug = selectedProject();
    return projects()?.find((p) => p.slug === slug);
  };

  const isActiveTask = (task: TaskSummary) => !task.completed;

  const handleSelectProject = (slug: string) => {
    setSelectedProject(slug);
    setShowProjectPicker(false);
  };

  const handleCreateProject = async () => {
    const name = newProjectName().trim();
    if (!name) return;
    const slug = toSlug(name);
    if (!slug) {
      setError("Invalid name");
      return;
    }
    try {
      await invoke("create_project", { slug, name, description: "" });
      setNewProjectName("");
      setError("");
      setShowNewProject(false);
      refetchProjects();
      setSelectedProject(slug);
      setShowProjectPicker(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreateTask = async () => {
    const title = newTaskTitle().trim();
    const slug = selectedProject();
    if (!title || !slug) return;
    try {
      await invoke("create_task", { projectSlug: slug, title, tags: [], body: "" });
      setNewTaskTitle("");
      refetchTasks();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCompleteTask = async (filename: string) => {
    const slug = selectedProject();
    if (!slug) return;
    try {
      await invoke("complete_task", { projectSlug: slug, filename });
      refetchTasks();
      refetchDoneTasks();
    } catch (e) {
      setError(String(e));
    }
  };

  const openTask = (task: TaskSummary) => {
    setSelectedTask(task);
    if (isActiveTask(task)) {
      isHydrating = true;
      setTaskBody(task.body);
      setTaskTitle(task.title);
      setTaskTagsInput(task.tags.join(", "));
      isHydrating = false;
      setSaveStatus("idle");
      setViewMode("edit");
    } else {
      setViewMode("preview");
    }
  };

  const navigateToList = () => {
    setSelectedTask(null);
    setViewMode("list");
    refetchTasks();
  };

  const goBack = async () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (viewMode() === "edit" && selectedTask()) {
      await saveTask();
    }
    navigateToList();
  };

  const confirmDelete = () => {
    setConfirmOpen(true);
  };

  const handleDelete = async () => {
    const task = selectedTask();
    const slug = selectedProject();
    if (!task || !slug) return;
    setConfirmOpen(false);
    if (saveTimer) clearTimeout(saveTimer);
    try {
      await invoke("delete_task", { projectSlug: slug, filename: task.filename });
      refetchTasks();
      refetchDoneTasks();
      navigateToList();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCompleteFromPreview = async () => {
    const task = selectedTask();
    const slug = selectedProject();
    if (!task || !slug) return;
    if (saveTimer) clearTimeout(saveTimer);
    try {
      if (viewMode() === "edit") {
        await saveTask();
      }
      await invoke("complete_task", { projectSlug: slug, filename: task.filename });
      refetchTasks();
      refetchDoneTasks();
      navigateToList();
    } catch (e) {
      setError(String(e));
    }
  };

  const formatTime = (time?: string) => {
    if (!time) return "";
    const d = new Date(time);
    return d.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div class="view" classList={{ "view--flush": viewMode() === "edit" }}>
      <Switch>
        <Match when={viewMode() === "list"}>
          <div class="tasks-layout">
            {/* Project heading */}
            <button
              type="button"
              class="project-heading"
              onClick={() => setShowProjectPicker(!showProjectPicker())}
            >
              <Icon name={showProjectPicker() ? "caret-down" : "caret-right"} size={18} />
              <h2 class="project-name">{currentProject()?.name ?? "Select project"}</h2>
            </button>

            {/* Project picker dropdown */}
            <Show when={showProjectPicker()}>
              <div class="project-picker">
                <For each={projects()}>
                  {(p) => (
                    <button
                      type="button"
                      class="project-picker-item"
                      classList={{ active: p.slug === selectedProject() }}
                      onClick={() => handleSelectProject(p.slug)}
                    >
                      {p.name}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="project-picker-item project-picker-new"
                  onClick={() => {
                    setShowNewProject(true);
                    setShowProjectPicker(false);
                  }}
                >
                  + New project
                </button>
              </div>
            </Show>

            <Show when={error()}>
              <p class="error-text">{error()}</p>
            </Show>

            {/* Task list */}
            <Show when={selectedProject()}>
              <div class="task-list">
                {/* Active tasks */}
                <For each={tasks()}>
                  {(task) => (
                    <div class="task-item">
                      <button
                        type="button"
                        class="task-toggle"
                        onClick={() => handleCompleteTask(task.filename)}
                        aria-label="Complete task"
                      >
                        <Icon name="check-square" size={18} />
                      </button>
                      <button type="button" class="task-title-btn" onClick={() => openTask(task)}>
                        {task.title}
                      </button>
                    </div>
                  )}
                </For>

                {/* New task row */}
                <div class="task-item task-item-new">
                  <span class="task-add-icon">
                    <Icon name="note-pencil" size={18} />
                  </span>
                  <input
                    type="text"
                    class="task-add-input"
                    placeholder="New task..."
                    value={newTaskTitle()}
                    onInput={(e) => setNewTaskTitle(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateTask();
                    }}
                  />
                </div>

                {/* Done tasks */}
                <Show when={doneTasks()?.length}>
                  <div class="done-tasks-section">
                    <For each={doneTasks()}>
                      {(task) => (
                        <div class="task-item task-item-done">
                          <span class="task-done-icon">
                            <Icon name="check-square" size={18} />
                          </span>
                          <button
                            type="button"
                            class="task-title-btn task-title-done"
                            onClick={() => openTask(task)}
                          >
                            {task.title}
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Project creation dialog */}
          <Show when={showNewProject()}>
            <div class="dialog-overlay" onClick={() => setShowNewProject(false)}>
              <div class="dialog" onClick={(e) => e.stopPropagation()}>
                <h3 class="dialog-title">New Project</h3>
                <input
                  type="text"
                  class="dialog-input"
                  placeholder="Project name"
                  value={newProjectName()}
                  onInput={(e) => setNewProjectName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateProject();
                    if (e.key === "Escape") setShowNewProject(false);
                  }}
                  autofocus
                />
                <Show when={error()}>
                  <p class="error-text">{error()}</p>
                </Show>
                <div class="dialog-actions">
                  <button type="button" class="btn-small" onClick={() => setShowNewProject(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    onClick={handleCreateProject}
                    disabled={!newProjectName().trim()}
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </Match>

        <Match when={viewMode() === "edit"}>
          <div class="task-edit-header">
            <input
              type="text"
              class="task-title-input"
              value={taskTitle()}
              onInput={(e) => setTaskTitle(e.currentTarget.value)}
              placeholder="Task title"
            />
            <div class="task-preview-meta">
              <Show when={selectedTask()?.created}>
                <span>{formatTime(selectedTask()?.created)}</span>
              </Show>
            </div>
          </div>
          <div class="notes-editor">
            <MilkdownEditor
              placeholder="Write task details..."
              defaultValue={taskBody()}
              onChange={setTaskBody}
            />
          </div>

          <Show when={saveStatus() !== "idle"}>
            <span class="status-indicator">
              {saveStatus() === "saving" && "Saving..."}
              {saveStatus() === "saved" && "Saved"}
            </span>
          </Show>

          <ActionBar>
            <input
              type="text"
              class="tags-input"
              placeholder="Tags (comma separated)"
              value={taskTagsInput()}
              onInput={(e) => setTaskTagsInput(e.currentTarget.value)}
            />
            <button type="button" onClick={goBack} aria-label="戻る">
              <Icon name="arrow-left" size={16} />
            </button>
            <button type="button" onClick={handleCompleteFromPreview} aria-label="タスクを完了">
              <Icon name="check-square" size={16} />
            </button>
            <button type="button" onClick={confirmDelete} aria-label="タスクを削除">
              <Icon name="trash" size={16} />
            </button>
          </ActionBar>

          <ConfirmDialog
            open={confirmOpen()}
            title="タスクを削除しますか？"
            message="この操作は元に戻せません。"
            onConfirm={handleDelete}
            onCancel={() => setConfirmOpen(false)}
          />
        </Match>

        <Match when={viewMode() === "preview"}>
          <div class="tasks-layout">
            <div class="task-preview-header">
              <h3 class="task-preview-title">{selectedTask()?.title}</h3>
              <div class="task-preview-meta">
                <Show when={selectedTask()?.created}>
                  <span>{formatTime(selectedTask()?.created)}</span>
                </Show>
                <Show when={selectedTask()?.tags?.length}>
                  <span>{selectedTask()?.tags.join(", ")}</span>
                </Show>
              </div>
            </div>
            <div class="task-preview-body">
              <Show when={selectedTask()?.body} fallback={<p class="empty-state">本文なし</p>}>
                <MarkdownPreview source={selectedTask()!.body} />
              </Show>
            </div>
          </div>

          <ActionBar>
            <button type="button" onClick={goBack} aria-label="戻る">
              <Icon name="arrow-left" size={16} />
            </button>
            <button type="button" onClick={confirmDelete} aria-label="タスクを削除">
              <Icon name="trash" size={16} />
            </button>
          </ActionBar>

          <ConfirmDialog
            open={confirmOpen()}
            title="タスクを削除しますか？"
            message="この操作は元に戻せません。"
            onConfirm={handleDelete}
            onCancel={() => setConfirmOpen(false)}
          />
        </Match>
      </Switch>
    </div>
  );
}
