import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

const BrowserParams = Type.Object({
  url: Type.String({ description: 'URL to navigate to' }),
  action: Type.Optional(Type.String({ description: 'Action to perform' })),
});

export function createBrowserTool(): AgentTool<typeof BrowserParams> {
  return {
    name: 'browser_automation',
    label: 'Browser',
    description: 'Automate web browser interactions (not yet implemented).',
    parameters: BrowserParams,
    execute: async () => {
      throw new Error('Browser automation is not yet implemented.');
    },
  };
}
