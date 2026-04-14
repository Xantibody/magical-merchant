import {
  createSignal,
  createResource,
  For,
  Show,
  createEffect,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import ActionBar from "../components/ActionBar";
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

async function fetchProjects(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>("list_projects");
}

export default function Tasks() {
  const [selectedProject, setSelectedProject] = createSignal<string>("");
  const [projects, { refetch: refetchProjects }] =
    createResource(fetchProjects);
  const [tasks, { refetch: refetchTasks }] = createResource(
    selectedProject,
    (slug) => {
      if (!slug) return Promise.resolve([]);
      return invoke<TaskSummary[]>("list_active_tasks", {
        projectSlug: slug,
      });
    },
  );

  const [showNewProject, setShowNewProject] = createSignal(false);
  const [newProjectSlug, setNewProjectSlug] = createSignal("");
  const [newProjectName, setNewProjectName] = createSignal("");

  const [showNewTask, setShowNewTask] = createSignal(false);
  const [newTaskTitle, setNewTaskTitle] = createSignal("");

  // Auto-select first project
  createEffect(() => {
    const list = projects();
    if (list?.length && !selectedProject()) {
      setSelectedProject(list[0].slug);
    }
  });

  const handleCreateProject = async () => {
    const slug = newProjectSlug().trim();
    const name = newProjectName().trim();
    if (!slug || !name) return;

    await invoke("create_project", {
      slug,
      name,
      description: "",
    });
    setNewProjectSlug("");
    setNewProjectName("");
    setShowNewProject(false);
    refetchProjects();
    setSelectedProject(slug);
  };

  const handleCreateTask = async () => {
    const title = newTaskTitle().trim();
    const slug = selectedProject();
    if (!title || !slug) return;

    await invoke("create_task", {
      projectSlug: slug,
      title,
      tags: [],
      body: "",
    });
    setNewTaskTitle("");
    setShowNewTask(false);
    refetchTasks();
  };

  const handleCompleteTask = async (filename: string) => {
    const slug = selectedProject();
    if (!slug) return;

    await invoke("complete_task", {
      projectSlug: slug,
      filename,
    });
    refetchTasks();
  };

  return (
    <div class="view">
      <div class="tasks-layout">
        <div class="project-selector">
          <select
            value={selectedProject()}
            onChange={(e) => setSelectedProject(e.currentTarget.value)}
          >
            <option value="">Select project</option>
            <For each={projects()}>
              {(p) => <option value={p.slug}>{p.name}</option>}
            </For>
          </select>
          <button
            type="button"
            class="btn-small"
            onClick={() => setShowNewProject(!showNewProject())}
          >
            +
          </button>
        </div>

        <Show when={showNewProject()}>
          <div class="new-project-form">
            <input
              type="text"
              placeholder="Slug"
              value={newProjectSlug()}
              onInput={(e) => setNewProjectSlug(e.currentTarget.value)}
            />
            <input
              type="text"
              placeholder="Name"
              value={newProjectName()}
              onInput={(e) => setNewProjectName(e.currentTarget.value)}
            />
            <button type="button" class="btn-small" onClick={handleCreateProject}>
              Create
            </button>
          </div>
        </Show>

        <Show when={selectedProject()}>
          <div class="task-list">
            <For
              each={tasks()}
              fallback={<p class="empty-state">No active tasks</p>}
            >
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
          </div>

          <Show when={showNewTask()}>
            <div class="new-task-form">
              <input
                type="text"
                placeholder="Task title"
                value={newTaskTitle()}
                onInput={(e) => setNewTaskTitle(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateTask();
                }}
              />
              <button type="button" class="btn-small" onClick={handleCreateTask}>
                Add
              </button>
            </div>
          </Show>
        </Show>
      </div>

      <ActionBar>
        <Show when={selectedProject()}>
          <button
            type="button"
            onClick={() => setShowNewTask(!showNewTask())}
          >
            <Icon name="note-pencil" size={16} />
            New Task
          </button>
        </Show>
      </ActionBar>
    </div>
  );
}
