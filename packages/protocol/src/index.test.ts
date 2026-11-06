import { describe, expect, it } from 'vitest';
import { isTerminalTaskStatus, type TaskStatus } from './index.js';

const terminalStatuses = ['completed', 'failed', 'cancelled', 'interrupted'] satisfies readonly TaskStatus[];
const activeStatuses = ['queued', 'running'] satisfies readonly TaskStatus[];

describe('isTerminalTaskStatus', () => {
  it.each(terminalStatuses)('%s is terminal', (status) => {
    expect(isTerminalTaskStatus(status)).toBe(true);
  });

  it.each(activeStatuses)('%s is not terminal', (status) => {
    expect(isTerminalTaskStatus(status)).toBe(false);
  });
});
