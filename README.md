# Prusa Timelapse

[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

A TypeScript CLI service that automatically monitors PrusaLink API for print jobs and creates timelapse videos using RTSP camera feeds.

## Features

- **Automatic Monitoring**: Polls PrusaLink API to detect print start/finish events
- **RTSP Capture**: Captures frames from RTSP camera streams using ffmpeg
- **Video Assembly**: Assembles captured frames into MP4 videos
- **Configurable Notifications**: Execute custom commands when timelapses complete
- **State Management**: Handles multiple prints and prevents conflicts
- **Graceful Shutdown**: Proper cleanup of processes and temporary files

## Prerequisites

- Node.js 16+ **OR** Docker
- ffmpeg (installed and available in PATH when running natively, included in Docker)
- Access to PrusaLink API
- RTSP camera stream from your 3D printer

## Installation

### Native Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Copy the example configuration:
   ```bash
   cp config/config.example.json config/config.json
   ```

### Docker Installation

1. Clone or download this repository
2. Copy the example configuration:
   ```bash
   cp config/config.example.json config/config.json
   ```
3. Edit `config/config.json` with your settings
4. Build and run with Docker Compose:
   ```bash
   docker compose up -d
   ```

## Configuration

Edit `config/config.json` with your settings:

```json
{
  "prusaLink": {
    "host": "192.168.1.100",
    "port": 80,
    "apiKey": "your-api-key-here"
  },
  "timelapse": {
    "rtspUrl": "rtsp://192.168.1.100:554/live",
    "captureInterval": 30,
    "outputFramerate": 30,
    "outputDirectory": "./timelapses",
    "tempDirectory": "./temp"
  },
  "notification": {
    "command": "echo 'Timelapse completed: {outputPath}'"
  },
  "pollInterval": 10
}
```

### Configuration Options

#### PrusaLink Settings

- `host`: IP address or hostname of your Prusa printer
- `port`: PrusaLink web interface port (usually 80)
- `apiKey`: PrusaLink API key (obtain from printer web interface)

#### Timelapse Settings

- `rtspUrl`: RTSP URL for camera stream
- `captureInterval`: Seconds between captured frames (e.g., 30 = 1 frame every 30 seconds)
- `outputFramerate`: FPS for the final video (e.g., 30)
- `outputDirectory`: Directory to save completed timelapse videos (created automatically if needed)
- `tempDirectory`: Directory for temporary frame storage (created automatically if needed)

#### Notification Settings

- `command`: Shell command to execute when timelapse completes
  - Use `{outputPath}` placeholder for the video file path
  - Use `{outputDir}` placeholder for the output directory
  - Examples:
    - `"echo 'Timelapse ready: {outputPath}'"`
    - `"curl -X POST -H 'Content-Type: application/json' -d '{{\"text\":\"Timelapse completed: {outputPath}\"}}' https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"`

#### Monitoring Settings

- `pollInterval`: Seconds between API status checks (recommended: 5-15)
- `watchdogTimeout`: Maximum seconds without seeing PRINTING state before auto-stopping capture (0 = disabled, default: 3600 = 1 hour)

## Usage

### Native Usage

#### Start the Service

```bash
# Using npm script
npm start config/config.json

# Or directly with node
node dist/index.js config/config.json

# Or after installing globally
npm link
prusa-timelapse config/config.json
```

#### Stop the Service

Press `Ctrl+C` to gracefully stop the service. The service will:

- Stop any active timelapse capture
- Complete video assembly if frames were captured
- Clean up temporary files
- Send notifications

### Docker Usage

#### Start the Service

```bash
# Start in background
docker compose up -d

# View logs
docker compose logs -f

# Stop the service
docker compose down
```

#### Docker Commands

```bash
# Rebuild after changes
docker compose build

# Restart service
docker compose restart

# View service status
docker compose ps
```

## How It Works

1. **Monitoring**: The service polls the PrusaLink `/api/v1/status` endpoint
2. **Detection**: When printer state changes from non-PRINTING to PRINTING, capture starts
3. **Capture**: ffmpeg captures frames from RTSP stream at specified intervals
4. **Assembly**: When printing finishes, ffmpeg assembles frames into MP4 video
5. **Notification**: Configured command executes with video path information

## File Structure

```
├── src/
│   ├── index.ts              # CLI entry point
│   ├── api/
│   │   └── client.ts         # PrusaLink API client
│   ├── config/
│   │   └── index.ts          # Configuration loading/validation
│   ├── monitor/
│   │   └── index.ts          # Print monitoring service
│   ├── timelapse/
│   │   └── index.ts          # Timelapse capture/assembly
│   └── types/
│       ├── api.ts            # API response types
│       └── config.ts         # Configuration types
├── config/
│   └── config.example.json   # Example configuration
├── dist/                     # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### ffmpeg Not Found

Ensure ffmpeg is installed and in your PATH:

```bash
ffmpeg -version
```

### Authentication Issues

- Verify PrusaLink credentials in config/config.json
- Check that PrusaLink web interface is accessible
- Some printers may use digest authentication instead of basic

### Camera Connection Issues

- Test RTSP URL with: `ffplay rtsp://your-camera-url`
- Verify camera is properly configured in PrusaLink
- Check network connectivity to camera

### Permission Issues

- Ensure write permissions for output and temp directories
- Create directories manually if needed:
  ```bash
  mkdir -p timelapses temp
  ```

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Testing

```bash
npm test
```

## License

ISC

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Disclaimer

This software is provided as-is. Always test in a safe environment and ensure proper backups of your Prusa printer configuration.
