const NOW = "azagro-now";
const PREV = "azagro-prev";

export function rememberPath(path: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = sessionStorage.getItem(NOW);
    if (cur && cur !== path) sessionStorage.setItem(PREV, cur);
    sessionStorage.setItem(NOW, path);
  } catch {
    /* ignore */
  }
}

export function lastPath(): string | null {
  try {
    return sessionStorage.getItem(NOW);
  } catch {
    return null;
  }
}

export function prevPath(): string | null {
  try {
    return sessionStorage.getItem(PREV);
  } catch {
    return null;
  }
}
