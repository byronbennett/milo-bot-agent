import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const NotifyParams = Type.Object({
  message: Type.String({ description: 'The message to send to the user' }),
});

export function createNotifyTool(sendFn: (message: string) => void): AgentTool<typeof NotifyParams> {
  return {
    name: 'notify_user',
    label: 'Notify User',
    description: 'Send a message or progress update to the user. Use this to communicate important status, ask questions, or share results.',
    parameters: NotifyParams,
    execute: async (_toolCallId, params) => {
      sendFn(params.message);
      return {
        content: [{ type: 'text', text: `Notified user: ${params.message}` }],
        details: {},
      };
    },
  };
}
