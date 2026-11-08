import { createMemo, For, Index, Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { Note } from "../lib/commands";
import { locale, t } from "../lib/i18n";
import { classifyLines } from "../lib/template-examples";
import { previewBlocks } from "../lib/template-preview";
import type { PreviewBlock } from "../lib/template-preview";
import { resolveBody, resolveLine, splitVariables, usesPrev } from "../lib/template-vars";

interface TemplatePreviewProps {
  /** The template as it is being written, the title line apart from the body. */
  title: string;
  body: string;
  tags: string[];
  /** The saved template's name, as notes made from it carry it. A new template has none. */
  templateName: string | undefined;
  /** The notes on disk, to find the one `{{prev}}` would link to. */
  notes: readonly Note[];
}

/**
 * One line of the preview's text. `{{prev}}` becomes the previous note's title, underlined as
 * the link it will be; any other variable still standing is marked as in the body layer.
 */
function PreviewText(props: { text: string; prev: string | undefined }): JSX.Element {
  return (
    <For each={splitVariables(props.text)}>
      {(run) => (
        <Show when={run.variable} fallback={run.text}>
          <Show
            when={/^\{\{\s*prev\s*\}\}$/u.test(run.text) && props.prev}
            fallback={<span class="templates-var">{run.text}</span>}
          >
            <span class="templates-preview-prev">{props.prev}</span>
          </Show>
        </Show>
      )}
    </For>
  );
}

function PreviewLine(props: { block: PreviewBlock; prev: string | undefined }): JSX.Element {
  const text = (): JSX.Element => <PreviewText text={props.block.text} prev={props.prev} />;
  return (
    <Switch fallback={<p class="templates-preview-paragraph">{text()}</p>}>
      <Match when={props.block.kind === "heading" && props.block}>
        {(heading) => (heading().level === 1 ? <h1>{text()}</h1> : <h2>{text()}</h2>)}
      </Match>
      <Match when={props.block.kind === "task" && props.block}>
        <p class="templates-preview-task">{text()}</p>
      </Match>
      <Match when={props.block.kind === "bullet"}>
        <p class="templates-preview-bullet">{text()}</p>
      </Match>
    </Switch>
  );
}

/** "9/25 (Thu)": the day the preview is made for, in the header of the preview. */
function previewDate(): string {
  const now = new Date();
  return t().templates.previewOn(
    `${now.getMonth() + 1}/${now.getDate()}`,
    resolveLine("{{weekday}}", now, locale()),
  );
}

/**
 * "This is what it makes today". Whether a variable is written right shows up here.
 *
 * What pressing "create" makes today, beside what is being written. A variable left
 * unresolved is marked as in the body layer: a misspelling shows here.
 */
export default function TemplatePreview(props: TemplatePreviewProps): JSX.Element {
  /**
   * The note `{{prev}}` would link to: the latest made from this template. Its first line
   * stands for its title, as in the note list. A new template has none.
   */
  const prevNote = createMemo<{ title: string } | undefined>(() => {
    const name = props.templateName;
    // The filename is the creation time, so the last by name is the latest
    const latest = props.notes
      .filter((note) => name !== undefined && note.template === name)
      .toSorted((a, b) => a.filename.localeCompare(b.filename))
      .at(-1);
    return latest && { title: latest.preview || latest.filename.replace(/\.md$/u, "") };
  });

  const preview = createMemo<{ title: string; tags: string[]; blocks: PreviewBlock[] }>(() => {
    const now = new Date();
    return {
      title: resolveLine(props.title, now, locale()),
      tags: props.tags
        .map((tag) => resolveLine(tag, now, locale()))
        .filter((tag) => tag.trim() !== ""),
      // With no previous note, core drops the {{prev}} lines on creation; so does this
      blocks: previewBlocks(
        resolveBody(props.body, now, locale(), { dropPrev: prevNote() === undefined }),
      ),
    };
  });

  /** What the preview leaves out or links, said under it. */
  const previewNotes = createMemo<string[]>(() => {
    const said: string[] = [];
    const examples = classifyLines(props.body).filter((kind) => kind === "example").length;
    if (examples > 0) {
      said.push(t().templates.egDropped(examples));
    }
    if (usesPrev(props.body)) {
      const prev = prevNote();
      said.push(prev ? t().templates.prevLink(prev.title) : t().templates.prevDropped);
    }
    return said;
  });

  return (
    <aside class="templates-preview" aria-label={t().templates.todayPreview}>
      <div class="templates-preview-head">
        <span class="templates-label">{t().templates.todayPreview}</span>
        <span class="templates-preview-date">{previewDate()}</span>
      </div>
      <div class="templates-preview-body">
        <p class="templates-preview-title">{preview().title || t().templates.previewUntitled}</p>
        <Show when={preview().tags.length > 0}>
          <p class="templates-preview-tags">
            <For each={preview().tags}>{(tag) => <span class="tag-badge">#{tag}</span>}</For>
          </p>
        </Show>
        <Index each={preview().blocks}>
          {(block) => <PreviewLine block={block()} prev={prevNote()?.title} />}
        </Index>
        <Show when={previewNotes().length > 0}>
          <div class="templates-preview-notes">
            <For each={previewNotes()}>{(note) => <p>{note}</p>}</For>
          </div>
        </Show>
      </div>
    </aside>
  );
}
