export interface PrusaLinkConfig {
  host: string;
  port: number;
  apiKey: string;
}

export interface TimelapseConfig {
  rtspUrl: string;
  captureInterval: number; // seconds between frames
  outputFramerate: number; // fps for output video
  outputDirectory: string;
  tempDirectory: string;
}

export interface NotificationConfig {
  command: string; // command to execute on completion
}

export interface AppConfig {
  prusaLink: PrusaLinkConfig;
  timelapse: TimelapseConfig;
  notification: NotificationConfig;
  pollInterval: number; // seconds between API polls
  watchdogTimeout: number; // seconds without seeing PRINTING state before auto-stopping capture (0 = disabled)
  webPort?: number; // port for the web UI (default: 3000, 0 = disabled)
}
