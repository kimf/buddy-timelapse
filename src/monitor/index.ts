import { spawn } from "child_process";
import { resolve } from "path";
import { ApiError, PrusaLinkClient } from "../api/client";
import { assembleVideo, TimelapseCapture, CaptureState } from "../timelapse";
import { PrinterState } from "../types/api";
import { AppConfig } from "../types/config";

export type MonitorState = "IDLE" | "PREPARING" | "CAPTURING" | "PAUSED" | "FINISHING";

export class MonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorError";
  }
}

/**
 * Polls the PrusaLink API on a configurable interval and drives the
 * timelapse capture lifecycle in response to printer state changes.
 *
 * ## State machine
 *
 * ```
 *  IDLE ──► PREPARING ──► CAPTURING ──► FINISHING ──► IDLE
 *                              │
 *                         PAUSED ◄──► CAPTURING
 * ```
 *
 * - **IDLE** — no active print job; monitor is running but not capturing.
 * - **PREPARING** — a print job has started but progress is 0%; waiting
 *   for actual material to be deposited before starting frames.
 * - **CAPTURING** — ffmpeg is actively writing frames from the RTSP stream.
 * - **PAUSED** — the printer was paused; ffmpeg is stopped but frames are
 *   preserved on disk for when printing resumes.
 * - **FINISHING** — the print ended (completed, cancelled, or watchdog fired);
 *   assembling the video, then returning to IDLE.
 *
 * Transitions:
 * - IDLE → PREPARING: printer enters PRINTING state with progress == 0
 * - IDLE/PREPARING → CAPTURING: printer enters PRINTING state with progress > 0
 * - CAPTURING → PAUSED: printer enters PAUSED state
 * - PAUSED → CAPTURING: printer returns to PRINTING state
 * - CAPTURING/PAUSED → FINISHING: printer leaves PRINTING/PAUSED (finished, cancelled, error)
 * - FINISHING → IDLE: assembly complete (or failed)
 *
 * ## Startup resume flow
 *
 * On startup, `resumeFromCrash()` checks for a leftover `capture-state.json`
 * and existing frame files. If both are present, an *optimistic resume* is
 * started immediately: ffmpeg begins capturing from `frameCount + 1` before
 * the first API call. The next `checkStatus()` call confirms or rejects this
 * by comparing the stored job ID with the current printer job ID. If they
 * match, the resume continues; if not, the orphaned frames are moved to a
 * recovery directory and the monitor resets to IDLE.
 *
 * ## Watchdog
 *
 * A watchdog timer is started whenever capture begins. It is reset on every
 * poll cycle that sees the printer in PRINTING state. If the printer goes
 * quiet for longer than `watchdogTimeout` seconds (e.g. due to a networking
 * issue or the printer freezing without sending a finished/cancelled state),
 * the watchdog fires and forces `transitionToFinishing()`, preventing the
 * capture process from running indefinitely. Set `watchdogTimeout` to `0`
 * or a negative value to disable the watchdog.
 */
export class PrintMonitor {
  private config: AppConfig;
  private apiClient: PrusaLinkClient;
  private timelapseCapture: TimelapseCapture;
  private currentPrintId: number | null = null;
  private isMonitoring = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private monitorState: MonitorState = "IDLE";
  private trackedJobId: number | null = null;
  private capturedFrameCount: number = 0;
  private watchdogExpiry: number | null = null; // timestamp when watchdog expires
  private isHandlingCompletion = false;
  private captureStartedAt: string = "";

  /**
   * Holds the capture state read from disk during startup when an optimistic
   * resume has been started but not yet confirmed against the live printer API.
   *
   * This acts as a one-shot flag: it is set by `resumeFromCrash()` and
   * cleared by the very first `checkStatus()` call, regardless of whether
   * the resume is confirmed or rejected. While non-null, `checkStatus()`
   * performs the resume-confirmation logic before running the normal state
   * machine.
   */
  private pendingResume: CaptureState | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.apiClient = new PrusaLinkClient(config.prusaLink);
    this.timelapseCapture = new TimelapseCapture(config.timelapse);
  }

  /**
   * Start the monitoring loop.
   *
   * Startup sequence:
   * 1. `resumeFromCrash()` — check for a persisted capture session and
   *    start an optimistic resume if one is found.
   * 2. Initial `checkStatus()` call — confirms or rejects the resume, and
   *    picks up any job that was already printing when the server started.
   * 3. Periodic polling — `checkStatus()` is called every
   *    `config.pollInterval` seconds for the lifetime of the monitor.
   *
   * @throws {MonitorError} If monitoring has already been started.
   */
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

  /**
   * Check for a persisted capture session from a previous server run.
   * If frames and a valid state file exist, start capturing immediately
   * (optimistic resume) to minimize the gap in the timelapse.
   * The first checkStatus() call will confirm or reject the resume
   * by comparing the stored job ID against the current printer job.
   */
  private async resumeFromCrash(): Promise<void> {
    const state = this.timelapseCapture.readCaptureState();
    if (!state) {
      // No state file — but there might still be orphaned frames from
      // a crash that happened before the state file was written.
      // Rescue them so they don't get mixed into the next capture.
      this.timelapseCapture.rescueOrphanedFrames();
      return;
    }

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

  /**
   * Stop the monitoring loop and any active capture.
   *
   * Clears the polling interval and, if ffmpeg is currently running,
   * stops the capture process via `stopCapture()` (SIGTERM with SIGKILL
   * fallback). After this call the monitor instance is no longer usable
   * and should be discarded.
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    console.log("Stopping print monitoring...");
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Stop any ongoing capture
    if (this.timelapseCapture.isCurrentlyCapturing()) {
      await this.stopTimelapseCapture();
    }
  }

  /**
   * Single poll cycle: fetch printer status and drive the state machine.
   *
   * The method has two phases:
   *
   * **Phase 1 — Resume confirmation** (only on the first call after startup
   * when `pendingResume` is non-null): compare the stored job ID with the
   * current printer job ID. On a match the optimistic capture continues and
   * the watchdog is started. On a mismatch the capture is stopped, orphaned
   * frames are rescued, and the monitor resets to IDLE. Either way,
   * `pendingResume` is cleared so this block never runs again.
   *
   * **Phase 2 — Normal state machine**: based on `monitorState` and the
   * current printer state, call the appropriate transition method
   * (`transitionToCapturing`, `transitionToPaused`, `transitionToFinishing`).
   * After state processing the watchdog is checked to catch stalled printers.
   *
   * Errors from the API are logged but do not stop the monitor. The watchdog
   * is still checked on API-error cycles so a stalled printer is eventually
   * detected even if the API is temporarily unreachable.
   */
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

      this.currentPrintId = currentJobId;

      // Check watchdog after processing status
      this.checkWatchdog();
    } catch (error) {
      if (error instanceof ApiError) {
        console.error(`API Error: ${error.message}`);
      } else {
        console.error(`Unexpected error: ${(error as Error).message}`);
      }
      // Continue monitoring despite errors

      // Still check watchdog even on API errors
      this.checkWatchdog();
    }
  }

  /**
   * Transition from IDLE, PREPARING, or PAUSED into the CAPTURING state.
   *
   * If ffmpeg is already running (e.g. the optimistic resume path left it
   * running), this method simply updates `monitorState` to CAPTURING and
   * returns. Otherwise it:
   * 1. Starts `ffmpeg` via `TimelapseCapture.startCapture()` with a frame
   *    offset of `capturedFrameCount + 1` to continue numbering seamlessly.
   * 2. Records `captureStartedAt` (once, on the very first capture start).
   * 3. Writes the capture state file so the session survives a crash.
   * 4. Starts the watchdog timer.
   *
   * On ffmpeg startup failure the state reverts to IDLE.
   */
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

  /**
   * Transition from CAPTURING into the PAUSED state.
   *
   * Before stopping ffmpeg, the current on-disk frame count is snapshotted
   * into `capturedFrameCount` and the capture state file is updated. This
   * ensures that when capture restarts on resume, the `startNumber` offset
   * is accurate even if additional frames were written after the last state
   * file update.
   */
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

  /**
   * Transition from CAPTURING or PAUSED into the FINISHING state, then
   * back to IDLE once the video has been assembled (or assembly fails).
   *
   * Full completion flow:
   * 1. Guard against concurrent calls with `isHandlingCompletion`.
   * 2. Clear the watchdog so it does not fire again during assembly.
   * 3. Stop the capture process if it is still running.
   * 4. Generate the output file path via `generateOutputPath()`.
   * 5. Assemble all frames into an MP4 with `assembleVideo()`.
   * 6. Clean up frame files and delete the state file from disk.
   * 7. Send a completion notification via the configured command.
   * 8. Reset all tracking fields and return to IDLE regardless of errors.
   *
   * @param jobId - The PrusaLink job ID that just finished (may be `null`
   *   if the printer reported no active job when finishing was detected).
   */
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

  private async stopTimelapseCapture(): Promise<void> {
    try {
      await this.timelapseCapture.stopCapture();
      console.log("Timelapse capture stopped");
    } catch (error) {
      console.error(
        `Error stopping timelapse capture: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Generate the output file path for the assembled timelapse video.
   *
   * The filename is derived from the current UTC timestamp (colons and dots
   * replaced with hyphens for filesystem compatibility) and the job ID,
   * e.g. `timelapse_2024-01-15T10-30-00_job42.mp4`. The file is placed in
   * the configured `outputDirectory`.
   *
   * @param jobId - The PrusaLink job ID, used as a suffix for easier
   *   identification. When `null` (job ID unavailable), the suffix is omitted.
   * @returns Absolute path to the output `.mp4` file.
   */
  private generateOutputPath(jobId: number | null): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const jobSuffix = jobId ? `_job${jobId}` : "";
    const filename = `timelapse_${timestamp}${jobSuffix}.mp4`;
    return resolve(this.config.timelapse.outputDirectory, filename);
  }

  /**
   * Execute the configured notification command after a timelapse completes.
   *
   * The command string from `config.notification.command` supports two
   * placeholders that are substituted before execution:
   * - `{outputPath}` — absolute path to the assembled `.mp4` file.
   * - `{outputDir}` — the configured output directory.
   *
   * The command is run via the system shell (`{ shell: true }`), so shell
   * features (pipes, redirects, environment variables) are supported.
   * Notification failure is non-fatal: errors are logged but not re-thrown
   * so that a broken notification hook does not prevent cleanup from
   * completing.
   *
   * @param outputPath - Absolute path to the assembled timelapse video.
   */
  private async sendNotification(outputPath: string): Promise<void> {
    try {
      // Execute the configured notification command
      const command = this.config.notification.command
        .replace("{outputPath}", outputPath)
        .replace("{outputDir}", this.config.timelapse.outputDirectory);

      console.log(`Executing notification command: ${command}`);

      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: "inherit" });

        child.on("error", (error) => {
          reject(
            new MonitorError(`Notification command failed: ${error.message}`)
          );
        });

        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new MonitorError(`Notification command exited with code ${code}`)
            );
          }
        });
      });

      console.log("Notification sent successfully");
    } catch (error) {
      console.error(`Failed to send notification: ${(error as Error).message}`);
      // Don't throw - notification failure shouldn't stop the process
    }
  }

  getMonitorState(): MonitorState {
    return this.monitorState;
  }

  isCurrentlyMonitoring(): boolean {
    return this.isMonitoring;
  }

  getCurrentPrintId(): number | null {
    return this.currentPrintId;
  }

  isCapturing(): boolean {
    return this.timelapseCapture.isCurrentlyCapturing();
  }

  /**
   * Start (or restart) the watchdog timer for the given job.
   *
   * The watchdog guards against a printer that stops responding without ever
   * transitioning to a terminal state (finished/cancelled/error). If the
   * printer is not seen in PRINTING state within `watchdogTimeout` seconds
   * of the last reset, `checkWatchdog()` fires `transitionToFinishing()`.
   *
   * The watchdog is disabled when `config.watchdogTimeout` is `<= 0`.
   *
   * @param jobId - The job ID being tracked (used only for the log message).
   */
  private startWatchdog(jobId: number): void {
    // Only start watchdog if enabled (> 0)
    if (this.config.watchdogTimeout <= 0) {
      return;
    }

    this.watchdogExpiry = Date.now() + this.config.watchdogTimeout * 1000;
    console.log(
      `Watchdog started: ${this.config.watchdogTimeout}s timeout for job ${jobId}`
    );
  }

  private resetWatchdog(): void {
    if (
      this.config.watchdogTimeout <= 0 ||
      !this.timelapseCapture.isCurrentlyCapturing()
    ) {
      return;
    }

    this.watchdogExpiry = Date.now() + this.config.watchdogTimeout * 1000;
    console.log(`Watchdog reset: ${this.config.watchdogTimeout}s remaining`);
  }

  private checkWatchdog(): void {
    if (
      this.config.watchdogTimeout <= 0 ||
      !this.timelapseCapture.isCurrentlyCapturing() ||
      this.watchdogExpiry === null
    ) {
      return;
    }

    const now = Date.now();
    if (now >= this.watchdogExpiry) {
      console.warn(
        `Watchdog triggered: No PRINTING state seen for ${this.config.watchdogTimeout}s`
      );
      console.warn("Forcing timelapse completion due to watchdog");

      // Use current print ID if available, otherwise null
      this.transitionToFinishing(this.currentPrintId).catch((error) => {
        console.error(
          `Error during watchdog-triggered completion: ${error.message}`
        );
      });
    }
  }

  /**
   * Clear the watchdog timer, preventing it from firing.
   *
   * Called at the start of `transitionToFinishing()` so the watchdog cannot
   * trigger a second completion while assembly is already in progress.
   */
  private clearWatchdog(): void {
    this.watchdogExpiry = null;
    console.log("Watchdog cleared");
  }
}
