import cron from 'node-cron';

export interface HeartbeatSchedulerOptions {
  intervalMinutes: number;
  onHeartbeat: () => Promise<void>;
}

/**
 * Cron-based heartbeat scheduler
 */
export class HeartbeatScheduler {
  private intervalMinutes: number;
  private onHeartbeat: () => Promise<void>;
  private task: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;

  constructor(options: HeartbeatSchedulerOptions) {
    this.intervalMinutes = options.intervalMinutes;
    this.onHeartbeat = options.onHeartbeat;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Scheduler is already running');
      return;
    }

    // Create cron expression for interval
    // For intervals less than 1 minute, we'll use a different approach
    const cronExpression = `*/${this.intervalMinutes} * * * *`;

    this.task = cron.schedule(cronExpression, async () => {
      try {
        await this.onHeartbeat();
      } catch (error) {
        console.error('Heartbeat error:', error);
      }
    });

    this.task.start();
    this.isRunning = true;

    // Run immediately on start
    this.onHeartbeat().catch(console.error);

    console.log(`Scheduler started with ${this.intervalMinutes} minute interval`);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.isRunning || !this.task) {
      return;
    }

    this.task.stop();
    this.task = null;
    this.isRunning = false;

    console.log('Scheduler stopped');
  }

  /**
   * Update the interval (requires restart)
   */
  setInterval(minutes: number): void {
    const wasRunning = this.isRunning;

    if (wasRunning) {
      this.stop();
    }

    this.intervalMinutes = minutes;

    if (wasRunning) {
      this.start();
    }
  }

  /**
   * Check if scheduler is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get current interval in minutes
   */
  get interval(): number {
    return this.intervalMinutes;
  }
}
