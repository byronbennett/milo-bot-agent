/**
 * macOS notification utility.
 * Uses osascript to display native notifications.
 * No-op on non-darwin platforms. Silent failure (best-effort).
 */

import { execFile } from 'child_process';

export function sendNotification(title: string, message: string): void {
  if (process.platform !== 'darwin') return;

  const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;

  execFile('osascript', ['-e', script], (err) => {
    // Best-effort — silently ignore failures
    if (err) {
      process.stderr.write(`[notify] Failed to send notification: ${err.message}\n`);
    }
  });
}
