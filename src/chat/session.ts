import * as clack from 'npm:@clack/prompts@^0.10';
import chalk from 'npm:chalk@^5';
import type { LLMProvider, Message } from '../providers/types.ts';

export interface ChatSessionOptions {
  provider: LLMProvider;
  model: string;
  system?: string;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}

export async function runChatSession(options: ChatSessionOptions): Promise<void> {
  const { provider, model, system, onUsage } = options;
  const history: Message[] = [];
  let totalTokens = 0;

  clack.log.info(`${chalk.bold('Chat started')} with ${chalk.cyan(provider.name)} / ${chalk.cyan(model)}`);
  clack.log.info(`Type ${chalk.yellow('/exit')} to quit, ${chalk.yellow('/clear')} to reset history`);
  console.log();

  while (true) {
    const input = await clack.text({
      message: chalk.bold('You'),
      placeholder: 'Type your message...',
      validate: (v) => v.trim().length === 0 ? 'Message cannot be empty' : undefined,
    });

    if (clack.isCancel(input)) break;

    const userInput = (input as string).trim();

    if (userInput === '/exit') break;

    if (userInput === '/clear') {
      history.length = 0;
      clack.log.info('Conversation history cleared');
      continue;
    }

    history.push({ role: 'user', content: userInput });

    process.stdout.write(chalk.bold.blue('\n  Assistant: '));

    let responseText = '';

    try {
      for await (const chunk of provider.streamText({
        model,
        messages: history,
        system,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          process.stdout.write(chunk.text);
          responseText += chunk.text;
        }
        if (chunk.type === 'usage' && chunk.usage) {
          totalTokens += chunk.usage.totalTokens;
          onUsage?.(chunk.usage);
        }
      }
    } catch (err) {
      console.log();
      clack.log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      history.pop();
      continue;
    }

    console.log('\n');

    if (responseText) {
      history.push({ role: 'assistant', content: responseText });
    }
  }

  console.log();
  clack.log.info(
    `Session ended. ${chalk.dim(`${totalTokens.toLocaleString()} tokens used`)}`
  );
}
