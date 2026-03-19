import { useState } from "react";
import QuickCapture from "./components/QuickCapture";
import Document from "./components/Document";

type Tab = "capture" | "document";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("capture");

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex border-b border-gray-200 bg-white">
        <button
          className={`flex-1 py-3 text-sm font-medium ${
            activeTab === "capture"
              ? "text-blue-600 border-b-2 border-blue-600"
              : "text-gray-500"
          }`}
          onClick={() => setActiveTab("capture")}
        >
          Quick Capture
        </button>
        <button
          className={`flex-1 py-3 text-sm font-medium ${
            activeTab === "document"
              ? "text-blue-600 border-b-2 border-blue-600"
              : "text-gray-500"
          }`}
          onClick={() => setActiveTab("document")}
        >
          Document
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {activeTab === "capture" ? <QuickCapture /> : <Document />}
      </div>
    </div>
  );
}

export default App;
