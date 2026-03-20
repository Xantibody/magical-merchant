import { useState } from "react";
import QuickCapture from "./components/QuickCapture";
import Document from "./components/Document";
import NotesList from "./components/NotesList";

type Tab = "capture" | "document" | "notes";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("capture");

  const tabs: { key: Tab; label: string }[] = [
    { key: "capture", label: "Capture" },
    { key: "document", label: "Document" },
    { key: "notes", label: "Notes" },
  ];

  return (
    <div className="flex flex-col h-screen bg-gray-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex border-b border-gray-200 bg-white">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`flex-1 py-3 text-sm font-medium ${
              activeTab === tab.key
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-500"
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {activeTab === "capture" && <QuickCapture />}
        {activeTab === "document" && <Document />}
        {activeTab === "notes" && <NotesList />}
      </div>
    </div>
  );
}

export default App;
