/**
 * Open a file (optional line) in the configured external editor.
 */
export async function openFileInEditor(
  editorCommand: string,
  path: string,
  line?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const editor = editorCommand || "code";
  try {
    const args =
      editor === "code" || editor === "cursor" || editor.endsWith("code")
        ? ["-g", line ? `${path}:${line}` : path]
        : line
          ? [`+${line}`, path]
          : [path];
    const proc = Bun.spawn([editor, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });

    void proc;
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
