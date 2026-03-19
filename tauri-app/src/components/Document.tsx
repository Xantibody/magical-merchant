import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Save } from "lucide-react";

function Document() {
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const handleSave = async () => {
    const trimmedBody = body.trim();
    if (!trimmedBody) return;

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    setSaving(true);
    setMessage("");
    try {
      await invoke("save_document", { body: trimmedBody, tags });
      setBody("");
      setTagsInput("");
      setMessage("Saved!");
      setTimeout(() => setMessage(""), 2000);
    } catch (e) {
      setMessage(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
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
          extensions={[markdown()]}
          onChange={(value) => setBody(value)}
          placeholder="Write your note in Markdown..."
          className="h-full"
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-green-600">{message}</span>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          onClick={handleSave}
          disabled={saving || !body.trim()}
        >
          <Save size={16} />
          Save
        </button>
      </div>
    </div>
  );
}

export default Document;
