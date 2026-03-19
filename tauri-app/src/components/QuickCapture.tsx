import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send } from "lucide-react";

function QuickCapture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setSaving(true);
    setMessage("");
    try {
      await invoke("save_quick_capture", { text: trimmed });
      setText("");
      setMessage("Saved!");
      setTimeout(() => setMessage(""), 2000);
    } catch (e) {
      setMessage(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <textarea
        className="w-full p-3 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
        rows={3}
        placeholder="What's on your mind?"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center justify-between">
        <span className="text-sm text-green-600">{message}</span>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          onClick={handleSave}
          disabled={saving || !text.trim()}
        >
          <Send size={16} />
          Save
        </button>
      </div>
    </div>
  );
}

export default QuickCapture;
