import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send } from "lucide-react";

function QuickCapture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [entries, setEntries] = useState<string[]>([]);

  const fetchEntries = useCallback(async () => {
    try {
      const result = await invoke<string[]>("read_timeline");
      setEntries(result);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      await invoke("save_quick_capture", { text: trimmed });
      setText("");
      await fetchEntries();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex gap-2">
        <textarea
          className="flex-1 p-3 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          rows={2}
          placeholder="What's on your mind?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="self-end px-3 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          onClick={handleSave}
          disabled={saving || !text.trim()}
        >
          <Send size={18} />
        </button>
      </div>

      {entries.length > 0 && (
        <div className="flex-1 overflow-auto space-y-1">
          <h2 className="text-xs font-medium text-gray-500 mb-1">Today</h2>
          {entries
            .slice()
            .reverse()
            .map((entry, i) => (
              <div key={i} className="p-2 bg-white border border-gray-200 rounded-lg text-sm">
                {entry}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export default QuickCapture;
