import { defineWorker, WorkerResults } from 'izi-queue';

/**
 * Email worker - simulates sending emails
 */
export const emailWorker = defineWorker('SendEmail', async (job) => {
  const { to, subject, body } = job.args;

  console.log(`[SendEmail] Sending email to ${to}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  Body: ${body}`);

  // Simulate email sending delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Simulate occasional failures for retry demonstration
  if (Math.random() < 0.2) {
    console.log(`[SendEmail] Failed to send email (simulated failure)`);
    throw new Error('Email service temporarily unavailable');
  }

  console.log(`[SendEmail] Email sent successfully to ${to}`);
  return WorkerResults.ok({ sentAt: new Date().toISOString() });
}, {
  queue: 'email',
  maxAttempts: 5
});

/**
 * Report worker - simulates generating reports
 */
export const reportWorker = defineWorker('GenerateReport', async (job) => {
  const { reportType, userId } = job.args;

  console.log(`[GenerateReport] Generating ${reportType} report for user ${userId}`);

  // Simulate report generation
  await new Promise(resolve => setTimeout(resolve, 2000));

  const reportId = `RPT-${Date.now()}`;
  console.log(`[GenerateReport] Report generated: ${reportId}`);

  return WorkerResults.ok({ reportId, generatedAt: new Date().toISOString() });
}, {
  queue: 'reports',
  maxAttempts: 3
});

/**
 * Notification worker - simulates push notifications
 */
export const notificationWorker = defineWorker('SendNotification', async (job) => {
  const { userId, message, type } = job.args;

  console.log(`[SendNotification] Sending ${type} notification to user ${userId}`);
  console.log(`  Message: ${message}`);

  // Simulate notification sending
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log(`[SendNotification] Notification sent successfully`);
  return WorkerResults.ok();
}, {
  queue: 'notifications',
  maxAttempts: 3
});

/**
 * Cleanup worker - demonstrates snooze functionality
 */
export const cleanupWorker = defineWorker('CleanupTask', async (job) => {
  const { target } = job.args;

  console.log(`[CleanupTask] Running cleanup for ${target}`);

  // Simulate cleanup
  await new Promise(resolve => setTimeout(resolve, 300));

  // If this is a recurring cleanup, snooze for next run
  if (job.args.recurring) {
    console.log(`[CleanupTask] Snoozing for next run in 60 seconds`);
    return WorkerResults.snooze(60);
  }

  console.log(`[CleanupTask] Cleanup completed`);
  return WorkerResults.ok();
}, {
  queue: 'default',
  maxAttempts: 1
});
