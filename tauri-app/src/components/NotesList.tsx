import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, ChevronLeft, Tag } from "lucide-react";
import { renderMarkdown, renderMarkdownSync } from "../lib/markdown";

interface NoteSummary {
  path: string;
  filename: string;
  time: string | null;
  tags: string[];
  preview: string;
}

function extractBody(raw: string): string {
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) return raw.slice(end + 5);
  }
  return raw;
}

function NotesList() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<NoteSummary[]>("list_notes");
      setNotes(result);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  const handleSelect = async (note: NoteSummary) => {
    setSelectedNote(note);
    setRenderedHtml(null);
    try {
      const raw = await invoke<string>("read_note", {
        filePath: note.path,
      });
      const body = extractBody(raw);
      const html = await renderMarkdown(body);
      setRenderedHtml(html);
    } catch {
      // ignore
    }
  };

  const handleBack = () => {
    setRenderedHtml(null);
    setSelectedNote(null);
    fetchNotes();
  };

  if (selectedNote) {
    return (
      <div className="flex flex-col gap-3 h-full">
        <button
          className="flex items-center gap-1 text-sm text-blue-600"
          onClick={handleBack}
        >
          <ChevronLeft size={16} />
          Back
        </button>
        <div className="text-xs text-gray-500">{selectedNote.time}</div>
        {selectedNote.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {selectedNote.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs"
              >
                <Tag size={10} />
                {tag}
              </span>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-auto bg-white border border-gray-200 rounded-lg p-3">
          {renderedHtml ? (
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            <p className="text-sm text-gray-400">Loading...</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">Saved Notes</h2>
        <button
          className="p-1 text-gray-500"
          onClick={fetchNotes}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {notes.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">No notes yet</p>
      ) : (
        <div className="flex-1 overflow-auto space-y-2">
          {notes.map((note) => (
            <button
              key={note.path}
              className="w-full text-left p-3 bg-white border border-gray-200 rounded-lg"
              onClick={() => handleSelect(note)}
            >
              <div className="text-xs text-gray-500 mb-1">
                {note.time ?? note.filename}
              </div>
              {note.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap mb-1">
                  {note.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-xs"
                    >
                      <Tag size={10} />
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div
                className="text-sm text-gray-700 line-clamp-2 prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownSync(note.preview),
                }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default NotesList;
