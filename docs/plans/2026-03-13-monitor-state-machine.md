# Monitor State Machine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the binary PRINTING/not-PRINTING monitor with a state machine that waits for actual print progress before capturing, and handles pause/resume as one continuous timelapse.

**Architecture:** Add a `MonitorState` enum (IDLE, PREPARING, CAPTURING, PAUSED, FINISHING) to `PrintMonitor`. The state machine drives transitions based on printer state + job progress. `TimelapseCapture` gains a `startNumber` parameter so ffmpeg can resume frame numbering after pause.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Add startNumber parameter to TimelapseCapture

**Files:**
- Modify: `src/timelapse/index.ts`

**Step 1: Modify startCapture to accept startNumber**

Change signature from `async startCapture(): Promise<void>` to `async startCapture(startNumber: number = 1): Promise<void>`.

Replace the `ffmpegArgs` block with:
```typescript
    const ffmpegArgs = [
      "-rtsp_transport",
      "tcp",
      "-i",
      this.config.rtspUrl,
      "-vf",
      `fps=1/${interval}`,
    ];

    if (startNumber > 1) {
      ffmpegArgs.push("-start_number", startNumber.toString());
    }

    ffmpegArgs.push("-y", outputPattern);
```

**Step 2: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/timelapse/index.ts
git commit -m "feat: add startNumber parameter to TimelapseCapture for pause/resume"
```

---

### Task 2: Implement monitor state machine

**Files:**
- Modify: `src/monitor/index.ts`

**Step 1: Add MonitorState type and new fields**

Add after imports:
```typescript
export type MonitorState = "IDLE" | "PREPARING" | "CAPTURING" | "PAUSED" | "FINISHING";
```

Add new private fields to `PrintMonitor`:
```typescript
private monitorState: MonitorState = "IDLE";
private trackedJobId: number | null = null;
private capturedFrameCount: number = 0;
```

Add public getter:
```typescript
getMonitorState(): MonitorState {
  return this.monitorState;
}
```

**Step 2: Replace checkStatus state transition logic**

Remove the existing transition checks in `checkStatus()` (the `if previousState !== "PRINTING"` / `else if previousState === "PRINTING"` / `else if capturing` block) and the `lastPrinterState` field. Replace with:

```typescript
      const progress = status.job?.progress ?? 0;

      switch (this.monitorState) {
        case "IDLE":
          if (currentState === "PRINTING" && currentJobId !== null) {
            this.trackedJobId = currentJobId;
            if (progress > 0) {
              await this.transitionToCapturing();
            } else {
              this.monitorState = "PREPARING";
              console.log(`Print preparing (Job ID: ${currentJobId}), waiting for progress > 0`);
            }
          }
          break;

        case "PREPARING":
          if (currentState === "PRINTING" && progress > 0) {
            await this.transitionToCapturing();
          } else if (currentState !== "PRINTING" && currentState !== "PAUSED") {
            console.log(`Print aborted during preparation (state: ${currentState})`);
            this.monitorState = "IDLE";
            this.trackedJobId = null;
          }
          break;

        case "CAPTURING":
          if (currentState === "PAUSED") {
            await this.transitionToPaused();
          } else if (currentState !== "PRINTING") {
            await this.transitionToFinishing(currentJobId);
          } else {
            this.resetWatchdog();
          }
          break;

        case "PAUSED":
          if (currentState === "PRINTING") {
            await this.transitionToCapturing();
            console.log(`Print resumed (Job ID: ${currentJobId})`);
          } else if (currentState !== "PAUSED") {
            await this.transitionToFinishing(currentJobId);
          } else {
            this.resetWatchdog();
          }
          break;

        case "FINISHING":
          break;
      }
```

**Step 3: Add transition methods**

Replace `handlePrintStarted` and `handlePrintFinished` with:

```typescript
  private async transitionToCapturing(): Promise<void> {
    if (this.timelapseCapture.isCurrentlyCapturing()) {
      this.monitorState = "CAPTURING";
      return;
    }
    try {
      const startNum = this.capturedFrameCount + 1;
      await this.timelapseCapture.startCapture(startNum);
      this.monitorState = "CAPTURING";
      console.log(`Timelapse capture started (frame offset: ${startNum})`);
      this.startWatchdog(this.trackedJobId!);
    } catch (error) {
      console.error(`Failed to start timelapse capture: ${(error as Error).message}`);
      this.monitorState = "IDLE";
      this.trackedJobId = null;
    }
  }

  private async transitionToPaused(): Promise<void> {
    console.log(`Print paused — stopping capture, preserving frames`);
    this.capturedFrameCount = this.timelapseCapture.getCapturedFrameCount();
    await this.stopTimelapseCapture();
    this.monitorState = "PAUSED";
  }

  private async transitionToFinishing(jobId: number | null): Promise<void> {
    if (this.isHandlingCompletion) return;
    this.isHandlingCompletion = true;
    this.monitorState = "FINISHING";
    this.clearWatchdog();

    console.log(`Print finished (Job ID: ${jobId})`);

    try {
      if (this.timelapseCapture.isCurrentlyCapturing()) {
        await this.stopTimelapseCapture();
      }
      const outputPath = this.generateOutputPath(jobId);
      await assembleVideo(this.config.timelapse, outputPath);
      await this.sendNotification(outputPath);
      console.log(`Timelapse completed: ${outputPath}`);
    } catch (error) {
      console.error(`Error during timelapse completion: ${(error as Error).message}`);
    } finally {
      this.monitorState = "IDLE";
      this.trackedJobId = null;
      this.capturedFrameCount = 0;
      this.isHandlingCompletion = false;
    }
  }
```

**Step 4: Update watchdog to call transitionToFinishing**

In `checkWatchdog()`, replace the `this.handlePrintFinished(...)` call with `this.transitionToFinishing(this.currentPrintId)`.

**Step 5: Clean up removed fields**

Remove `lastPrinterState` field and its usage. Keep `currentPrintId` updated from the poll for backward compat with watchdog.

**Step 6: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 7: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat: replace binary state check with IDLE/PREPARING/CAPTURING/PAUSED/FINISHING state machine

Waits for job.progress > 0 before starting capture (skips heating/leveling).
Handles pause/resume as one continuous timelapse instead of creating multiple videos."
```

---

### Task 3: Expose monitor state in web UI status endpoint

**Files:**
- Modify: `src/web/server.ts` (check exact file location)

**Step 1: Add monitorState to the status API response**

Find the status endpoint and add `monitorState: monitor.getMonitorState()` to the JSON response.

**Step 2: Build and verify**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/web/
git commit -m "feat: expose monitor state in web UI status endpoint"
```
