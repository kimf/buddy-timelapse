# Job-ID-Based Timelapse Resume on Server Restart

**Goal:** When the server restarts (crash or intentional) mid-print, resume the timelapse for the same job instead of moving frames to `recovered/` and starting fresh. This produces one continuous video per print job regardless of server interruptions.

## Current Behavior

1. Server starts, `TimelapseCapture.startCapture()` calls `rescueOrphanedFrames()`
2. Any existing `img_*.jpg` files in the temp directory are moved to `recovered/{timestamp}/`
3. Capture starts fresh from frame 1
4. The old frames are abandoned in the recovered directory

**Problem:** Every server restart during a print creates a new, incomplete timelapse and loses continuity.

## Design

### State File: `capture-state.json`

`TimelapseCapture` writes a JSON state file to the temp directory to persist session info across crashes:

```json
{
  "jobId": 80,
  "frameCount": 247,
  "startedAt": "2026-03-13T14:30:45.000Z"
}
```

**Written when:**
- Capture starts (new or resumed)
- Capture stops (pause or server-initiated stop)

**Deleted when:**
- Video assembly completes successfully
- Frames are moved to `recovered/` (job mismatch or no active print)

### Startup Resume Flow

On monitor startup, before entering the normal poll loop:

1. Check if `capture-state.json` exists in the temp directory
2. **State file exists with frames:**
   - Immediately start capturing from `frameCount + 1` (optimistic resume — minimizes gap)
   - On first successful API poll, compare current printer job ID against state file:
     - **Same job ID** → confirmed resume, continue CAPTURING normally
     - **Different job ID** → stop optimistic capture, move all frames to `recovered/`, delete state file, immediately start tracking the new job (transition to PREPARING/CAPTURING — skip IDLE)
     - **No print running** → stop optimistic capture, move all frames to `recovered/`, delete state file, transition to IDLE
3. **State file exists but no frames in temp dir** → delete stale state file, start IDLE
4. **State file corrupt/unreadable** → log warning, delete it, rescue any frames to `recovered/`, start IDLE
5. **No state file** → existing behavior (`rescueOrphanedFrames()` if frames exist, then IDLE)

### Cleanup After Successful Video Assembly

After `assembleVideo()` succeeds and the video + thumbnail are written:

1. Delete all `img_*.jpg` frames from the temp directory
2. Delete `capture-state.json`

This keeps the temp directory clean and avoids unnecessary recovery logic on next startup.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| State file exists, no frames | Delete stale state file, start IDLE |
| State file corrupt/unreadable | Log warning, delete file, rescue frames, start IDLE |
| Printer API unreachable on startup | Keep optimistic capture running, retry on next poll |
| Crash during FINISHING (assembly) | State file already deleted before assembly; `rescueOrphanedFrames()` handles leftover frames as today |
| Same job ID but printer is PAUSED | Resume capture; state machine will transition to PAUSED on next poll |

### Documentation

All existing and new code should be heavily documented with JSDoc comments explaining the state machine, file lifecycle, and recovery logic.

## Components Changed

- **`TimelapseCapture`** (`src/timelapse/index.ts`): Write/read/delete `capture-state.json`, cleanup frames after assembly, expose method to read state file
- **`PrintMonitor`** (`src/monitor/index.ts`): Startup resume logic before poll loop, optimistic capture on resume, handle job mismatch
- **`assembleVideo()`** (`src/timelapse/index.ts`): Clean up frames and state file after successful assembly
