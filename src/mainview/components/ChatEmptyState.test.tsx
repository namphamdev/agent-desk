import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatEmptyState } from "./ChatEmptyState";

describe("ChatEmptyState", () => {
  it("shows logo, matrix title, and project actions when no session", () => {
    const html = renderToStaticMarkup(
      <ChatEmptyState
        sessionLoading={false}
        hasActiveSession={false}
        recentProjects={[
          {
            project: "agent-desk",
            cwd: "F:\\Dev\\agent-desk",
            updatedAt: 1,
          },
        ]}
        onNewSession={() => {}}
        onOpenProject={() => {}}
      />,
    );
    expect(html).toContain("logo.png");
    expect(html).toContain("Agent Desk");
    expect(html).toContain("agent-desk");
    expect(html).toContain("Add project");
    expect(html).not.toContain("Working in");
    expect(html).not.toContain("bin");
  });

  it("shows ready hint when a session is active but timeline is empty", () => {
    const html = renderToStaticMarkup(
      <ChatEmptyState
        sessionLoading={false}
        hasActiveSession={true}
        recentProjects={[]}
        onNewSession={() => {}}
        onOpenProject={() => {}}
      />,
    );
    expect(html).toContain("Type a prompt below");
    expect(html).not.toContain("Open project");
  });
});
