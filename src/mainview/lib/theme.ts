/** Resolve app theme setting to the effective light/dark mode. */
export function resolveThemeMode(
  theme: "light" | "dark" | "system" | undefined | null,
): "light" | "dark" {
  if (theme === "dark" || theme === "light") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Apply resolved theme to <html> for shadcn (.dark) + existing data-theme. */
export function applyDocumentTheme(
  theme: "light" | "dark" | "system" | undefined | null,
): void {
  const mode = resolveThemeMode(theme);
  const root = document.documentElement;
  root.dataset.theme = theme === "system" ? "system" : mode;
  root.classList.toggle("dark", mode === "dark");
}
