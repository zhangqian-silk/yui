import type { Message } from '../index.js';
import type { InteractionRenderer } from './contracts.js';

/** Do not let model/tool output control the user's terminal (including OSC/CSI). */
export function terminalText(value: string, limit = 2000): string {
  const clipped = value.slice(0, limit);
  const safe = clipped.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return safe + (clipped.length < value.length ? ` [truncated ${value.length - clipped.length} chars]` : '');
}

export function createTextRenderer(): InteractionRenderer {
  const message = (item: Message): string => {
    if (item.role === 'tool') {
      const result = item.outcome.ok ? item.outcome.content
        : `${item.outcome.error.code} (effect=${item.outcome.error.effect}): ${item.outcome.error.message}`;
      return `[tool result ${terminalText(item.name, 100)} ${terminalText(item.toolCallId, 100)}] ${terminalText(result)}\n`;
    }
    const calls = item.role === 'assistant' ? item.toolCalls.map(call =>
      `[tool call ${terminalText(call.name, 100)} ${terminalText(call.id, 100)}] ${terminalText(JSON.stringify(call.arguments))}\n`).join('') : '';
    return `[message ${item.role}] ${terminalText(item.content)}\n${calls}`;
  };
  return {
    message,
    record(record) {
      if (record.kind === 'text_delta') {
        return `[provisional ${terminalText(record.turnId, 100)}] ${terminalText(record.text)}\n`;
      }
      const event = record.event;
      switch (event.data.type) {
        case 'message_appended': return message(event.data.message);
        case 'turn_started': return `[turn ${terminalText(event.turnId, 100)} started]\n`;
        case 'step_started': return `[step ${event.data.step} started]\n`;
        case 'tool_started': return `[tool running ${terminalText(event.data.name, 100)} ${terminalText(event.data.toolCallId, 100)}]\n`;
        case 'step_ended': return `[step ${event.data.step} ended]\n`;
        case 'turn_ended': return `[ended: ${event.data.reason}]${event.data.errorCode ? ` ${terminalText(event.data.errorCode, 100)}` : ''}\n`;
      }
    },
  };
}
