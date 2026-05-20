# Codex Image And Interrupt Parity

## Goal

Make Codex sessions match Claude dashboard UX for the composer:

- Text prompts can be sent from cards and quick-send popovers.
- Image attachments are accepted and delivered to Codex.
- The stop/interrupt button can cancel an in-flight Codex send.

The implementation may differ from Claude's wrapper internals, but the dashboard experience should not expose a capability gap.

## Approach

1. Extend the Codex exec runner to accept image attachments.
   - Decode dashboard base64 images into per-request temp files.
   - Pass those temp files to `codex exec` / `codex exec resume` with repeated `--image` args.
   - Clean temp files after the child exits or is cancelled.

2. Track active Codex exec processes by session UUID.
   - Store a per-session cancellation handle while `/send` is running.
   - Add Codex handling to `/wrap/interrupt` so the existing UI stop button can cancel Codex too.
   - Return a clear interrupted response instead of letting the request hang indefinitely.

3. Update dashboard UX.
   - Treat Codex as image-capable.
   - Show the existing image attach button for Codex.
   - Show the stop button while Codex is busy.
   - Keep Claude wrapper behavior unchanged.

4. Verify with tests and live checks.
   - Unit/integration tests for Codex image args, cleanup, and interrupt.
   - i18n parity, typecheck, web build, full tests if time permits.
