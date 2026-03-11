interface VideoItem {
  name: string;
  size: number;
  mtime: string;
}

interface RecoveredItem {
  name: string;
  frameCount: number;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildCard(imgSrc: string, title: string, meta: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.src = imgSrc;
  img.alt = title;
  img.loading = "lazy";

  const info = document.createElement("div");
  info.className = "card-info";

  const nameEl = document.createElement("div");
  nameEl.className = "card-name";
  nameEl.textContent = title;

  const metaEl = document.createElement("div");
  metaEl.className = "card-meta";
  metaEl.textContent = meta;

  info.append(nameEl, metaEl);
  card.append(img, info);
  return card;
}

function renderEmpty(grid: HTMLElement, text: string): void {
  grid.innerHTML = `<p class="empty">${text}</p>`;
}

async function fetchVideos(): Promise<void> {
  try {
    const res = await fetch("/api/videos");
    if (!res.ok) return;
    const videos = (await res.json()) as VideoItem[];

    const grid = document.getElementById("videos");
    const countEl = document.getElementById("video-count");
    if (!grid) return;

    if (countEl) countEl.textContent = videos.length > 0 ? `(${videos.length})` : "";

    if (videos.length === 0) {
      renderEmpty(grid, "No timelapses yet");
      return;
    }

    grid.innerHTML = "";
    for (const item of videos) {
      const thumb = `/api/videos/${encodeURIComponent(item.name)}/thumb.jpg`;
      const label = item.name.replace(/\.mp4$/i, "");
      const meta = `${fmtDate(item.mtime)} · ${fmtSize(item.size)}`;
      grid.appendChild(buildCard(thumb, label, meta));
    }
  } catch {
    // Leave previous state on network error
  }
}

async function fetchRecovered(): Promise<void> {
  try {
    const res = await fetch("/api/recovered");
    if (!res.ok) return;
    const items = (await res.json()) as RecoveredItem[];

    const grid = document.getElementById("recovered");
    const countEl = document.getElementById("recovered-count");
    if (!grid) return;

    if (countEl) countEl.textContent = items.length > 0 ? `(${items.length})` : "";

    if (items.length === 0) {
      renderEmpty(grid, "None");
      return;
    }

    grid.innerHTML = "";
    for (const item of items) {
      const thumb = `/api/recovered/${encodeURIComponent(item.name)}/thumb.jpg`;
      const frameWord = item.frameCount === 1 ? "frame" : "frames";
      grid.appendChild(buildCard(thumb, item.name, `${item.frameCount} ${frameWord}`));
    }
  } catch {
    // Leave previous state on network error
  }
}

export function initVideos(): void {
  void fetchVideos();
  void fetchRecovered();
  setInterval(() => {
    void fetchVideos();
    void fetchRecovered();
  }, 30_000);
}
