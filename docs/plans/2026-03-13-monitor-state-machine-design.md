# Monitor State Machine Redesign

## Problem

Two issues with the current print monitoring:

1. **Capture starts during heating/bed leveling** — PrusaLink reports `PRINTING` immediately, but the printer spends minutes heating and leveling before extruding. This wastes frames on a static scene.

2. **Pause creates multiple timelapses** — A `PRINTING → PAUSED` transition triggers `handlePrintFinished()`, assembling a partial video. When the print resumes, a new timelapse starts. One print produces multiple videos and "recovered" orphaned frames.

## Design

### Monitor States

Replace the simple PRINTING/not-PRINTING binary check with an internal state machine:

```
IDLE → PREPARING → CAPTURING → PAUSED → CAPTURING → FINISHING → IDLE
```

**IDLE**: No active print tracked. Transition to PREPARING when `printer.state == PRINTING` and a job ID is present.

**PREPARING**: Printer says PRINTING but `job.progress == 0`. Poll status but don't start ffmpeg. Transition to CAPTURING once `job.progress > 0`. If printer leaves PRINTING state (e.g. error, stopped), go back to IDLE.

**CAPTURING**: ffmpeg is running, frames accumulating in temp dir. Transitions:
- → PAUSED when `printer.state == PAUSED`
- → FINISHING when printer state is FINISHED, STOPPED, IDLE, or ERROR (print ended)

**PAUSED**: ffmpeg stopped, frames preserved in temp dir, same job ID tracked. Transitions:
- → CAPTURING when `printer.state == PRINTING` (resume — restart ffmpeg with continued frame numbering)
- → FINISHING when printer state is FINISHED, STOPPED, or IDLE (print ended while paused)

**FINISHING**: Assemble all accumulated frames into one video, generate thumbnail, send notification, clean up temp dir. Transition to IDLE.

### Key Implementation Details

- **Frame numbering across pauses**: Track a `nextFrameNumber` counter. When restarting ffmpeg after pause, use `-start_number` so filenames continue sequentially (e.g. if 50 frames captured before pause, resume at img_00051.jpg).
- **Job ID continuity**: Track the current job ID. Only treat a new PRINTING state as a new print if the job ID differs from the tracked one.
- **Orphaned frame recovery**: Only rescue frames on fresh startup or when a *different* job ID starts — not on pause/resume of the same job.
- **Watchdog**: Reset on both PRINTING and PAUSED states (the print is still alive in both cases). Only trigger on prolonged absence of either state.

### Files Changed

- `src/monitor/index.ts` — Replace state transition logic with state machine
- `src/timelapse/index.ts` — Add `startCapture(startNumber)` parameter for continued numbering
- `src/types/api.ts` — No changes needed (already has `progress` field on `StatusJob`)
