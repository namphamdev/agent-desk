interface HeaderProps {
  title: string;
  project: string;
  branch: string;
}

export function Header({ title, project, branch }: HeaderProps) {
  return (
    <header className="header-bg flex h-14 shrink-0 items-center justify-between border-b border-[#2e2e2e] px-6">
      <div className="flex items-center space-x-4">
        <h1 className="text-sm font-semibold">{title}</h1>
        <div className="flex items-center space-x-2 text-xs text-gray-400">
          <span className="flex items-center rounded bg-[#2a2a2a] px-2 py-1">
            <svg className="mr-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            {project}
          </span>
          <span className="flex items-center rounded bg-[#2a2a2a] px-2 py-1">
            <svg className="mr-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            {branch}
            <svg className="ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        </div>
      </div>
      <div className="flex items-center space-x-3 text-gray-400">
        <div className="flex rounded bg-[#2a2a2a] p-0.5">
          <button className="rounded bg-[#3a3a3a] p-1 text-gray-200">
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
              <path clipRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" fillRule="evenodd" />
            </svg>
          </button>
          <button className="rounded p-1 hover:bg-[#3a3a3a]">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
        <button className="hover:text-gray-200">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
