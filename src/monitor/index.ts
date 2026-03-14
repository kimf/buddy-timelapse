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
  /** When non-null, the monitor is waiting to confirm a resumed session against the API. */
  private pendingResume: CaptureState | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.apiClient = new PrusaLinkClient(config.prusaLink);
    this.timelapseCapture = new TimelapseCapture(config.timelapse);
  }

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

  private generateOutputPath(jobId: number | null): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const jobSuffix = jobId ? `_job${jobId}` : "";
    const filename = `timelapse_${timestamp}${jobSuffix}.mp4`;
    return resolve(this.config.timelapse.outputDirectory, filename);
  }

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

  private clearWatchdog(): void {
    this.watchdogExpiry = null;
    console.log("Watchdog cleared");
  }
}
