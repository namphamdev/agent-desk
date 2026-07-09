import { useState } from "react";

const models = ["GLM-5.2", "GPT-5", "Claude Sonnet 4.5"];
const efforts = ["High", "Medium", "Low"];

/**
 * Bottom input bar. In M1 it's a no-op (prompts aren't sent anywhere); in M2
 * it'll send prompts over Electrobun RPC to the ACP agent.
 */
export function PromptInput() {
  const [value, setValue] = useState("");
  const [model, setModel] = useState(models[0]);
  const [effort, setEffort] = useState(efforts[0]);

  return (
    <div className="pointer-events-none absolute bottom-6 left-64 right-0 flex justify-center px-6">
      <div className="input-bg pointer-events-auto flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-lg">
        <div className="px-4 py-3">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full border-none bg-transparent text-[15px] text-gray-200 placeholder-gray-500 focus:ring-0"
            placeholder="Ask for follow-up changes"
          />
        </div>
        <div className="flex items-center justify-between border-t border-[#2e2e2e] px-3 py-2">
          <div className="flex items-center space-x-3">
            <button className="rounded-md p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <div className="h-4 w-px bg-[#333]" />
            <Selector value={model} options={models} onChange={setModel} accent="text-[#d97706]" />
          </div>
          <div className="flex items-center space-x-3">
            <Selector value={effort} options={efforts} onChange={setEffort} />
            <Selector value={model} options={models} onChange={setModel} prefix="⚡" />
            <button className="ml-1 rounded-md bg-gray-600 p-1.5 text-gray-200 hover:bg-gray-500">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Selector({
  value,
  options,
  onChange,
  accent,
  prefix,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  accent?: string;
  prefix?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center space-x-1.5 rounded px-2 py-1 text-sm font-medium hover:bg-[#3a270a] ${accent ?? "text-gray-400 hover:text-gray-200"}`}
      >
        {prefix && <span>{prefix}</span>}
        <span>{value}</span>
        <svg className="h-3 w-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 w-40 rounded-lg border border-[#3a3a3a] bg-[#1e1e1e] py-1 shadow-xl">
          {options.map((o) => (
            <button
              key={o}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-[#2a2a2a] ${
                o === value ? "text-gray-200" : "text-gray-400"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
