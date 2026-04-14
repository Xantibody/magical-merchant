import { createSignal, createResource, For, Show, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../components/Icon";

interface ProjectSummary {
  slug: string;
  name: string;
  description: string;
}

interface TaskSummary {
  filename: string;
  title: string;
  tags: string[];
}

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

  const [showProjectPicker, setShowProjectPicker] = createSignal(false);
  const [showNewProject, setShowNewProject] = createSignal(false);
  const [newProjectName, setNewProjectName] = createSignal("");
  const [newTaskTitle, setNewTaskTitle] = createSignal("");
  const [error, setError] = createSignal("");

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
    await invoke("complete_task", { projectSlug: slug, filename });
    refetchTasks();
  };

  return (
    <div class="view">
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

        {/* Task list */}
        <Show when={selectedProject()}>
          <div class="task-list">
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
                  <span class="task-title">{task.title}</span>
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
    </div>
  );
}
