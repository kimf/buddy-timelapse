# Job-ID-Based Timelapse Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resume timelapse capture for the same print job after a server restart instead of moving frames to `recovered/` and starting fresh. Clean up frames after successful video assembly.

**Architecture:** `TimelapseCapture` persists a `capture-state.json` file in the temp directory with `{ jobId, frameCount, startedAt }`. On startup, `PrintMonitor` reads this state file, optimistically resumes capture immediately (to minimize frame gap), then confirms the job ID against the PrusaLink API. If job matches, capture continues seamlessly. If mismatched, frames are recovered and the new job is tracked immediately. Frames and state file are cleaned up after successful video assembly.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Add capture state persistence to TimelapseCapture

**Files:**
- Modify: `src/timelapse/index.ts`

**Step 1: Add imports and CaptureState interface**

Add `existsSync`, `readFileSync`, `writeFileSync`, `unlinkSync`, `rmSync` to the `fs` import, and define the state interface after the `TimelapseError` class:

```typescript
import { ChildProcess, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { TimelapseConfig } from "../types/config";

// ... TimelapseError class unchanged ...

/**
 * Persisted state for an active timelapse capture session.
 * Written to `capture-state.json` in the temp directory so the monitor
 * can resume the same timelapse after a server restart or crash.
 */
export interface CaptureState {
  /** PrusaLink job ID that this capture session belongs to. */
  jobId: number;
  /** Number of frames captured so far (used to resume frame numbering). */
  frameCount: number;
  /** ISO timestamp of when capture originally started. */
  startedAt: string;
}
```

**Step 2: Add state file constants and helper methods to TimelapseCapture**

Add a constant for the state filename and four new methods — `writeCaptureState`, `readCaptureState`, `deleteCaptureState`, and `cleanupFrames`:

```typescript
/** Filename for the persisted capture state, stored in the temp directory. */
const CAPTURE_STATE_FILENAME = "capture-state.json";
```

Inside `TimelapseCapture`, add after the `getCapturedFrameCount` method:

```typescript
  /**
   * Persist the current capture state to disk so it survives server restarts.
   * Written on capture start and on capture stop (pause or finish).
   */
  writeCaptureState(jobId: number, frameCount: number, startedAt: string): void {
    const state: CaptureState = { jobId, frameCount, startedAt };
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`Failed to write capture state: ${(error as Error).message}`);
    }
  }

  /**
   * Read the persisted capture state from disk.
   * Returns null if no state file exists, or if the file is corrupt/unreadable.
   */
  readCaptureState(): CaptureState | null {
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      if (!existsSync(statePath)) return null;
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw) as CaptureState;
      // Basic validation: ensure required fields exist
      if (typeof state.jobId !== "number" || typeof state.frameCount !== "number") {
        console.warn("Capture state file has invalid format, ignoring");
        return null;
      }
      return state;
    } catch (error) {
      console.warn(`Failed to read capture state: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Delete the capture state file from disk.
   * Called after successful video assembly or when frames are moved to recovered.
   */
  deleteCaptureState(): void {
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch (error) {
      console.error(`Failed to delete capture state: ${(error as Error).message}`);
    }
  }

  /**
   * Remove all captured frames (img_*.jpg) from the temp directory.
   * Called after successful video assembly to keep the temp directory clean.
   */
  cleanupFrames(): void {
    try {
      const files = readdirSync(this.tempDir);
      const frames = files.filter(
        (f) => f.startsWith("img_") && f.endsWith(".jpg")
      );
      for (const file of frames) {
        unlinkSync(join(this.tempDir, file));
      }
      if (frames.length > 0) {
        console.log(`Cleaned up ${frames.length} frames from temp directory`);
      }
    } catch (error) {
      console.error(`Failed to clean up frames: ${(error as Error).message}`);
    }
  }
```

**Step 3: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add src/timelapse/index.ts
git commit -m "feat: add capture state persistence and frame cleanup to TimelapseCapture

Adds CaptureState interface and methods to write/read/delete a
capture-state.json file in the temp directory. Adds cleanupFrames()
to remove frames after successful video assembly."
```

---

### Task 2: Write capture state from PrintMonitor during transitions

**Files:**
- Modify: `src/monitor/index.ts`

**Step 1: Add a captureStartedAt field and update transitions to write state**

Add a new field to `PrintMonitor`:

```typescript
private captureStartedAt: string = "";
```

Update `transitionToCapturing()` — after successful capture start, write the state file:

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
      if (!this.captureStartedAt) {
        this.captureStartedAt = new Date().toISOString();
      }
      this.timelapseCapture.writeCaptureState(
        this.trackedJobId!,
        this.capturedFrameCount,
        this.captureStartedAt
      );
      console.log(`Timelapse capture started (frame offset: ${startNum})`);
      this.startWatchdog(this.trackedJobId!);
    } catch (error) {
      console.error(`Failed to start timelapse capture: ${(error as Error).message}`);
      this.monitorState = "IDLE";
      this.trackedJobId = null;
    }
  }
```

Update `transitionToPaused()` — update frame count in state file before stopping:

```typescript
  private async transitionToPaused(): Promise<void> {
    console.log(`Print paused — stopping capture, preserving frames`);
    this.capturedFrameCount = this.timelapseCapture.getCapturedFrameCount();
    this.timelapseCapture.writeCaptureState(
      this.trackedJobId!,
      this.capturedFrameCount,
      this.captureStartedAt
    );
    await this.stopTimelapseCapture();
    this.monitorState = "PAUSED";
  }
```

Update `transitionToFinishing()` — in the `finally` block, also reset `captureStartedAt`:

```typescript
    } finally {
      this.monitorState = "IDLE";
      this.trackedJobId = null;
      this.capturedFrameCount = 0;
      this.captureStartedAt = "";
      this.isHandlingCompletion = false;
    }
```

**Step 2: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat: write capture state to disk during monitor transitions

State file is written on capture start and pause so the session
can be resumed after a server restart."
```

---

### Task 3: Clean up frames and state file after successful video assembly

**Files:**
- Modify: `src/timelapse/index.ts` (assembleVideo function)
- Modify: `src/monitor/index.ts` (transitionToFinishing)

**Step 1: Add cleanup to transitionToFinishing after successful assembly**

In `transitionToFinishing()`, after `assembleVideo` succeeds, clean up frames and delete state file:

```typescript
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
      // Clean up frames and state file after successful assembly
      this.timelapseCapture.cleanupFrames();
      this.timelapseCapture.deleteCaptureState();
      await this.sendNotification(outputPath);
      console.log(`Timelapse completed: ${outputPath}`);
    } catch (error) {
      console.error(`Error during timelapse completion: ${(error as Error).message}`);
    } finally {
      this.monitorState = "IDLE";
      this.trackedJobId = null;
      this.capturedFrameCount = 0;
      this.captureStartedAt = "";
      this.isHandlingCompletion = false;
    }
  }
```

**Step 2: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat: clean up frames and state file after successful video assembly

Frames are deleted from the temp directory after the video is assembled,
keeping the directory clean and avoiding unnecessary recovery on next startup."
```

---

### Task 4: Implement startup resume logic in PrintMonitor

**Files:**
- Modify: `src/monitor/index.ts`

**Step 1: Add a resumeFromCrash method to PrintMonitor**

This method is called at the start of `startMonitoring()`, before the first poll. It reads the state file, optionally starts optimistic capture, and sets internal state so the first `checkStatus()` call can confirm or reject the resume.

Add a new private field to track pending resume:

```typescript
/** When non-null, the monitor is waiting to confirm a resumed session against the API. */
private pendingResume: CaptureState | null = null;
```

Add the import for `CaptureState` at the top of the file:

```typescript
import { assembleVideo, TimelapseCapture, CaptureState } from "../timelapse";
```

Add the `resumeFromCrash` method:

```typescript
  /**
   * Check for a persisted capture session from a previous server run.
   * If frames and a valid state file exist, start capturing immediately
   * (optimistic resume) to minimize the gap in the timelapse.
   * The first checkStatus() call will confirm or reject the resume
   * by comparing the stored job ID against the current printer job.
   */
  private async resumeFromCrash(): Promise<void> {
    const state = this.timelapseCapture.readCaptureState();
    if (!state) return;

    const frameCount = this.timelapseCapture.getCapturedFrameCount();
    if (frameCount === 0) {
      console.log("Found capture state file but no frames — deleting stale state");
      this.timelapseCapture.deleteCaptureState();
      return;
    }

    console.log(
      `Found capture state from previous session: job ${state.jobId}, ` +
      `${state.frameCount} frames recorded, ${frameCount} frames on disk`
    );

    // Use the actual frame count on disk (may differ from state if crash
    // happened between writing frames and updating state)
    this.capturedFrameCount = frameCount;
    this.trackedJobId = state.jobId;
    this.captureStartedAt = state.startedAt;
    this.pendingResume = state;

    // Optimistic resume: start capturing immediately to minimize gap
    try {
      const startNum = frameCount + 1;
      await this.timelapseCapture.startCapture(startNum);
      this.monitorState = "CAPTURING";
      console.log(
        `Optimistic capture resumed from frame ${startNum} ` +
        `(pending job ID confirmation)`
      );
    } catch (error) {
      console.error(
        `Failed to start optimistic capture: ${(error as Error).message}`
      );
      this.pendingResume = null;
      this.trackedJobId = null;
      this.capturedFrameCount = 0;
      this.captureStartedAt = "";
    }
  }
```

**Step 2: Call resumeFromCrash in startMonitoring**

Update `startMonitoring()` to call `resumeFromCrash()` before the first status check:

```typescript
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      throw new MonitorError("Monitoring already started");
    }

    console.log("Starting print monitoring...");
    this.isMonitoring = true;

    // Check for a persisted capture session from a previous run
    await this.resumeFromCrash();

    // Initial status check
    await this.checkStatus();

    // Start periodic monitoring
    this.monitoringInterval = setInterval(() => {
      this.checkStatus().catch((error) => {
        console.error(`Error during status check: ${error.message}`);
      });
    }, this.config.pollInterval * 1000);
  }
```

**Step 3: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat: add optimistic capture resume on startup from persisted state

On startup, if a capture-state.json exists with frames on disk,
immediately resume capturing to minimize gap. The next checkStatus()
call will confirm or reject the resume."
```

---

### Task 5: Handle resume confirmation and job mismatch in checkStatus

**Files:**
- Modify: `src/monitor/index.ts`

**Step 1: Add resume confirmation logic at the top of checkStatus**

At the beginning of `checkStatus()`, after fetching the status but before the state machine switch, add a block that handles `pendingResume`:

```typescript
  private async checkStatus(): Promise<void> {
    try {
      const status = await this.apiClient.getStatus();
      const currentState = status.printer.state;
      const currentJobId = status.job?.id || null;

      console.log(`Printer state: ${currentState}, Job ID: ${currentJobId}`);

      // --- Resume confirmation ---
      // If we have a pending resume from a previous crash, confirm
      // whether the current printer job matches the saved session.
      if (this.pendingResume) {
        const savedJobId = this.pendingResume.jobId;
        this.pendingResume = null; // Only check once

        if (currentJobId === savedJobId) {
          // Same job — confirmed resume. Continue capturing.
          console.log(
            `Resume confirmed: printer still on job ${savedJobId}`
          );
          this.startWatchdog(savedJobId);
          // State is already CAPTURING from resumeFromCrash, continue normally
        } else {
          // Different job or no job — stop optimistic capture, recover frames
          console.log(
            `Job mismatch: state file has job ${savedJobId}, ` +
            `printer has job ${currentJobId ?? "none"}`
          );
          if (this.timelapseCapture.isCurrentlyCapturing()) {
            await this.stopTimelapseCapture();
          }
          this.timelapseCapture.rescueOrphanedFrames();
          this.timelapseCapture.deleteCaptureState();
          this.monitorState = "IDLE";
          this.trackedJobId = null;
          this.capturedFrameCount = 0;
          this.captureStartedAt = "";

          // If a different job is printing, start tracking it immediately
          if (currentState === "PRINTING" && currentJobId !== null) {
            this.trackedJobId = currentJobId;
            const progress = status.job?.progress ?? 0;
            if (progress > 0) {
              await this.transitionToCapturing();
            } else {
              this.monitorState = "PREPARING";
              console.log(
                `New print preparing (Job ID: ${currentJobId}), ` +
                `waiting for progress > 0`
              );
            }
          }
          // Update currentPrintId and return — don't run the normal
          // state machine this tick since we already handled the transition
          this.currentPrintId = currentJobId;
          return;
        }
      }

      const progress = status.job?.progress ?? 0;

      switch (this.monitorState) {
        // ... rest of state machine unchanged ...
```

**Step 2: Make rescueOrphanedFrames public**

In `src/timelapse/index.ts`, change `rescueOrphanedFrames` from `private` to `public` so the monitor can call it during job mismatch:

```typescript
  /**
   * Move orphaned frames from a previous crashed capture run to a
   * timestamped recovery directory. This prevents old frames from being
   * mixed into a new capture session.
   *
   * Frames are moved to: {tempDir}/recovered/{ISO_timestamp}/
   * This method is non-fatal — if it fails, capture can still proceed.
   */
  rescueOrphanedFrames(): void {
```

Also remove the `this.rescueOrphanedFrames()` call from `startCapture()` — the monitor now handles recovery decisions explicitly, so we don't want `startCapture` blindly moving frames that might belong to a valid resumed session:

Remove this line from `startCapture()`:
```typescript
    // Move any orphaned frames from a previous crashed run to a recovery directory
    this.rescueOrphanedFrames();
```

**Step 3: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add src/timelapse/index.ts src/monitor/index.ts
git commit -m "feat: handle resume confirmation and job mismatch on first status check

On first poll after optimistic resume, confirm the printer is still on
the same job. If mismatched, recover frames and immediately start
tracking the new job. Made rescueOrphanedFrames public and removed
automatic rescue from startCapture — the monitor now decides."
```

---

### Task 6: Add JSDoc documentation to all modified code

**Files:**
- Modify: `src/timelapse/index.ts`
- Modify: `src/monitor/index.ts`

**Step 1: Document TimelapseCapture class and all methods**

Add comprehensive JSDoc to the `TimelapseCapture` class, every public method, and the `assembleVideo` function. Document the frame file naming convention, the temp directory lifecycle, and the relationship between state file and frames.

Key documentation points:
- Class-level: explain the capture lifecycle (start → frames accumulate → stop → assemble → cleanup)
- `startCapture`: explain `startNumber` for resume, frame naming pattern `img_%05d.jpg`
- `stopCapture`: explain graceful SIGTERM with 5s SIGKILL fallback
- `getCapturedFrameCount`: explain it counts `img_*.jpg` files on disk
- `rescueOrphanedFrames`: explain when/why frames are orphaned and the recovery directory structure
- `writeCaptureState` / `readCaptureState` / `deleteCaptureState`: explain the state file lifecycle
- `cleanupFrames`: explain this is called after successful assembly only
- `assembleVideo`: explain the ffmpeg pipeline and thumbnail generation

**Step 2: Document PrintMonitor class, state machine, and all methods**

Add comprehensive JSDoc to the `PrintMonitor` class and all its methods. Document the state machine transitions, the startup resume flow, and the watchdog mechanism.

Key documentation points:
- Class-level: explain the 5-state state machine with an ASCII state diagram
- `startMonitoring`: explain the startup sequence (resumeFromCrash → checkStatus → poll loop)
- `checkStatus`: explain the resume confirmation logic and the state machine switch
- `resumeFromCrash`: explain optimistic resume strategy and why we capture before confirming
- `transitionToCapturing` / `transitionToPaused` / `transitionToFinishing`: explain each transition and what state gets persisted
- `pendingResume` field: explain its role as a one-shot flag for resume confirmation
- Watchdog methods: explain timeout-based forced completion

**Step 3: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 4: Commit**

```bash
git add src/timelapse/index.ts src/monitor/index.ts
git commit -m "docs: add comprehensive JSDoc to timelapse capture and monitor

Documents the state machine, capture lifecycle, state file persistence,
startup resume flow, and watchdog mechanism."
```

---

### Task 7: Handle edge case — ensure IDLE state rescues orphaned frames

**Files:**
- Modify: `src/monitor/index.ts`

**Step 1: Add orphan rescue when no resume is needed**

Since we removed the automatic `rescueOrphanedFrames()` call from `startCapture()`, we need to make sure orphaned frames (from crashes where no state file was written) are still cleaned up.

In `resumeFromCrash()`, after the early return when no state file exists, add a rescue for any stray frames:

```typescript
  private async resumeFromCrash(): Promise<void> {
    const state = this.timelapseCapture.readCaptureState();
    if (!state) {
      // No state file — but there might still be orphaned frames from
      // a crash that happened before the state file was written.
      // Rescue them so they don't get mixed into the next capture.
      this.timelapseCapture.rescueOrphanedFrames();
      return;
    }

    // ... rest of method unchanged ...
```

**Step 2: Build to verify**

Run: `npm run build:server`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/monitor/index.ts
git commit -m "fix: rescue orphaned frames on startup when no state file exists

Ensures stray frames from crashes that happened before the state
file was written are still moved to the recovered directory."
```
