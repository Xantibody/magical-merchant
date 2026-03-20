import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Check } from "lucide-react";

const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontSize: "1.6em", fontWeight: "bold" },
    { tag: tags.heading2, fontSize: "1.4em", fontWeight: "bold" },
    { tag: tags.heading3, fontSize: "1.2em", fontWeight: "bold" },
    { tag: tags.heading4, fontSize: "1.1em", fontWeight: "bold" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    {
      tag: tags.monospace,
      fontFamily: "monospace",
      backgroundColor: "rgba(0,0,0,0.06)",
      borderRadius: "3px",
      padding: "0 3px",
    },
    { tag: tags.link, color: "#2563eb", textDecoration: "underline" },
    { tag: tags.url, color: "#6b7280" },
    { tag: tags.quote, color: "#6b7280", fontStyle: "italic" },
  ]),
);

function Document() {
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parseTags = useCallback(
    () =>
      tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    [tagsInput],
  );

  const autoSave = useCallback(
    async (currentBody: string) => {
      if (!currentBody.trim()) return;
      const currentTags = parseTags();
      setStatus("saving");
      try {
        if (draftPath) {
          await invoke("update_draft", {
            filePath: draftPath,
            body: currentBody,
            tags: currentTags,
          });
        } else {
          const path = await invoke<string>("create_draft", {
            body: currentBody,
            tags: currentTags,
          });
          setDraftPath(path);
        }
        setStatus("saved");
      } catch {
        setStatus("idle");
      }
    },
    [draftPath, parseTags],
  );

  useEffect(() => {
    if (!body.trim()) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => autoSave(body), 1000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [body, autoSave]);

  useEffect(() => {
    if (!tagsInput || !draftPath) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => autoSave(body), 1000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [tagsInput, draftPath, body, autoSave]);

  const handleDone = () => {
    setBody("");
    setTagsInput("");
    setDraftPath(null);
    setStatus("idle");
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      <input
        className="w-full p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        type="text"
        placeholder="Tags (comma separated)"
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
      />
      <div className="flex-1 min-h-0 border border-gray-300 rounded-lg overflow-hidden">
        <CodeMirror
          value={body}
          height="100%"
          extensions={[markdown(), markdownHighlight]}
          onChange={(value) => setBody(value)}
          placeholder="Write your note in Markdown..."
          className="h-full"
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">
          {status === "saving" && "Saving..."}
          {status === "saved" && "Saved"}
        </span>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          onClick={handleDone}
          disabled={!draftPath}
        >
          <Check size={16} />
          Done
        </button>
      </div>
    </div>
  );
}

export default Document;
