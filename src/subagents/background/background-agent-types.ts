export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface BackgroundTask {
  id: string;
  personaId: string;
  threadId: string;
  channelId: string;
  prompt: string;
  workingDirectory: string | null;
  status: BackgroundTaskStatus;
  output: string | null;
  error: string | null;
  pid: number | null;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
  timeoutMinutes: number;
}

export interface BackgroundTaskResult {
  taskId: string;
  status: BackgroundTaskStatus;
  output: string | null;
  error: string | null;
  durationSeconds: number;
}

export type CreateBackgroundTaskInput = Omit<
  BackgroundTask,
  'createdAt' | 'startedAt' | 'completedAt'
>;
