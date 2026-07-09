import { useMemo, useState } from "react";
import { reduceAll } from "../session/reducer";
import { demoUpdates } from "../fixtures/demo";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Timeline } from "./components/Timeline";
import { PromptInput } from "./components/PromptInput";

export default function App() {
  // M1: render from a recorded fixture. M2 will receive live updates via RPC.
  const session = useMemo(() => reduceAll(demoUpdates), []);
  const [showSidebar] = useState(true);

  return (
    <div className="flex h-screen overflow-hidden">
      {showSidebar && <Sidebar />}
      <main className="main-bg relative flex flex-1 flex-col">
        <Header
          title="Music Variant Generation Progress UI"
          project="frontend"
          branch="develop"
        />
        <div className="flex flex-1 flex-col items-center overflow-y-auto p-6 md:p-8">
          <div className="w-full max-w-4xl space-y-8 pb-40">
            <div className="flex items-center space-x-1 text-xs text-gray-500">
              <span>Worked for 2m 39s</span>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <Timeline entries={session.timeline} />
          </div>
        </div>
        <PromptInput />
      </main>
    </div>
  );
}
