import type { ModelCapabilities, ModelProtocol, ModelProtocolAdapter } from './types.js';
import { ModelGatewayError } from './errors.js';
import { createChatCompletionsAdapter } from './chatCompletions.js';
import { createResponsesAdapter } from './responses.js';
import { createAnthropicMessagesAdapter } from './anthropicMessages.js';

/** Adapter subset, not a claim that every model/account supports these operations. */
export function getProtocolCapabilities(protocol: ModelProtocol): ModelCapabilities {
  if (!['chat-completions', 'responses', 'anthropic-messages'].includes(protocol)) {
    throw new ModelGatewayError('configuration', 'none');
  }
  return Object.freeze({ text: true, functionTools: true, streaming: true });
}
export function createProtocolAdapter(protocol: ModelProtocol): ModelProtocolAdapter {
  switch (protocol) {
    case 'chat-completions': return createChatCompletionsAdapter();
    case 'responses': return createResponsesAdapter();
    case 'anthropic-messages': return createAnthropicMessagesAdapter();
    default: throw new ModelGatewayError('configuration', 'none');
  }
}
