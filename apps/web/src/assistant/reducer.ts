import type {
  AssistantEvent,
  ChatMessage,
  TaskSnapshot,
  ToolCall,
} from '@pi-vue3/protocol';

export interface EventTarget {
  sessionId: string;
  taskId: string;
}

export interface EventReduction {
  snapshot: TaskSnapshot;
  accepted: boolean;
  needsResync: boolean;
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function reduceAssistantEvent(
  snapshot: TaskSnapshot,
  event: AssistantEvent,
  target: EventTarget = snapshot,
): EventReduction {
  if (event.sessionId !== target.sessionId || event.taskId !== target.taskId
    || event.sessionId !== snapshot.sessionId || event.taskId !== snapshot.taskId) {
    return { snapshot, accepted: false, needsResync: false };
  }
  if (event.seq <= snapshot.seq) return { snapshot, accepted: false, needsResync: false };
  if (event.seq !== snapshot.seq + 1) return { snapshot, accepted: false, needsResync: true };

  let messages = snapshot.messages;
  let tools = snapshot.tools;
  let status = snapshot.status;
  let error = snapshot.error;

  switch (event.type) {
    case 'task.status':
      status = event.payload.status;
      error = event.payload.error;
      break;
    case 'message.upserted':
      messages = upsert<ChatMessage>(messages, event.payload.message);
      break;
    case 'message.delta': {
      const message = messages.find((item) => item.id === event.payload.messageId);
      if (!message) return { snapshot, accepted: false, needsResync: true };
      messages = messages.map((item) => item.id === message.id
        ? { ...item, text: item.text + event.payload.delta }
        : item);
      break;
    }
    case 'tool.upserted':
      tools = upsert<ToolCall>(tools, event.payload.tool);
      break;
  }

  const next: TaskSnapshot = {
    ...snapshot,
    seq: event.seq,
    status,
    messages,
    tools,
  };
  if (error !== undefined) next.error = error;
  else delete next.error;
  return { snapshot: next, accepted: true, needsResync: false };
}

/** Replace local task state with the server's authoritative point-in-time view. */
export function applyTaskSnapshot(current: TaskSnapshot | null, authoritative: TaskSnapshot): TaskSnapshot {
  if (current && (current.sessionId !== authoritative.sessionId || current.taskId !== authoritative.taskId)) return current;
  return {
    ...authoritative,
    messages: [...authoritative.messages],
    tools: [...authoritative.tools],
  };
}
