interface StatusPrinter {
  state: string;
  temp_nozzle?: number;
  target_nozzle?: number;
  temp_bed?: number;
  target_bed?: number;
  axis_z?: number;
  speed?: number;
}

interface StatusJob {
  progress?: number;
  time_remaining?: number;
}

interface StatusResponse {
  printer: StatusPrinter;
  job?: StatusJob;
}

function fmtTemp(cur?: number, tgt?: number): string {
  const c = cur != null ? cur.toFixed(1) : "—";
  const t = tgt != null ? String(Math.round(tgt)) : "—";
  return `${c} / ${t} °C`;
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function applyStatus(data: StatusResponse): void {
  const { printer, job } = data;
  const state = printer.state ?? "UNKNOWN";

  // Header pill
  const pill = el("status-pill");
  if (pill) {
    pill.textContent = state;
    pill.className = state;
  }

  // Printer Status row
  const svState = el("sv-state");
  if (svState) {
    svState.textContent = state;
    svState.className = `stat-value ${state}`;
  }

  // Nozzle temperature
  const svNozzle = el("sv-nozzle");
  if (svNozzle) svNozzle.textContent = fmtTemp(printer.temp_nozzle, printer.target_nozzle);

  // Heatbed temperature
  const svBed = el("sv-bed");
  if (svBed) svBed.textContent = fmtTemp(printer.temp_bed, printer.target_bed);

  // Printing speed
  const svSpeed = el("sv-speed");
  if (svSpeed) svSpeed.textContent = printer.speed != null ? `${printer.speed}%` : "—";

  // Z-height
  const svZ = el("sv-z");
  if (svZ) svZ.textContent = printer.axis_z != null ? `${printer.axis_z.toFixed(1)} mm` : "—";

  // Progress bar — show only when printing/paused and progress is available
  const printing = state === "PRINTING" || state === "PAUSED";
  const progressKnown = printing && job?.progress != null;

  el("progress-wrap")?.classList.toggle("visible", progressKnown);

  if (progressKnown && job?.progress != null) {
    const pct = Math.round(job.progress);
    const fill = el("progress-fill") as HTMLElement | null;
    const pctEl = el("progress-pct");
    if (fill) fill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
  }
}

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = (await res.json()) as StatusResponse;
    applyStatus(data);
  } catch {
    // Network error — leave previous values in place
  }
}

export function initStatus(): void {
  void fetchStatus();
  setInterval(() => void fetchStatus(), 5_000);
}
