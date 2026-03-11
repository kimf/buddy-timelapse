import Hls from "hls.js";

const SNAPSHOT_INTERVAL = 5_000;

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let hls: Hls | null = null;
let isLive = false;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function updateTimestamp(): void {
  el<HTMLSpanElement>("camera-ts").textContent = new Date().toLocaleTimeString();
}

function pollSnapshot(): void {
  const img = el<HTMLImageElement>("camera-img");
  const next = new Image();
  next.onload = () => {
    img.src = next.src;
    updateTimestamp();
  };
  next.src = `/api/camera.jpg?t=${Date.now()}`;
}

function startSnapshotPolling(): void {
  if (snapshotTimer !== null) return;
  pollSnapshot();
  snapshotTimer = setInterval(pollSnapshot, SNAPSHOT_INTERVAL);
}

function stopSnapshotPolling(): void {
  if (snapshotTimer !== null) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

function showVideo(): void {
  el<HTMLImageElement>("camera-img").style.display = "none";
  el<HTMLVideoElement>("camera-video").classList.add("active");
}

function showSnapshot(): void {
  el<HTMLImageElement>("camera-img").style.display = "";
  const video = el<HTMLVideoElement>("camera-video");
  video.classList.remove("active");
  video.pause();
  video.removeAttribute("src");
}

async function startLive(): Promise<void> {
  const btn = el<HTMLButtonElement>("live-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";

  try {
    const res = await fetch("/api/camera/stream/start", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { url } = (await res.json()) as { url: string };

    stopSnapshotPolling();
    showVideo();

    const video = el<HTMLVideoElement>("camera-video");

    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play());
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = url;
      void video.play();
    } else {
      throw new Error("HLS not supported in this browser");
    }

    isLive = true;
    btn.textContent = "■ Stop Live";
    btn.classList.add("active");
  } catch (err) {
    console.error("Failed to start stream:", err);
    showSnapshot();
    startSnapshotPolling();
    btn.textContent = "▶ Go Live";
  } finally {
    btn.disabled = false;
  }
}

function stopLive(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }

  showSnapshot();
  fetch("/api/camera/stream/stop", { method: "POST" }).catch(() => {});

  isLive = false;
  const btn = el<HTMLButtonElement>("live-btn");
  btn.textContent = "▶ Go Live";
  btn.classList.remove("active");

  startSnapshotPolling();
}

export function initCamera(): void {
  startSnapshotPolling();

  el<HTMLButtonElement>("live-btn").addEventListener("click", () => {
    if (isLive) {
      stopLive();
    } else {
      void startLive();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (isLive) {
      navigator.sendBeacon("/api/camera/stream/stop");
    }
  });
}
