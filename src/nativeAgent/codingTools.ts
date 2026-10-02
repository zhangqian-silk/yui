import type { Tool } from './index.js';
import { createTextTools, type TextToolsOptions } from './textTools.js';
import { createSearchTools, type SearchToolOptions } from './searchTools.js';
import { createCommandTool, type CommandToolOptions } from './commandTool.js';

export type CodingToolsOptions = {
  root: string;
  text?: Omit<TextToolsOptions, 'root'>;
  search?: Omit<SearchToolOptions, 'root'>;
  /** Omission installs no command capability. Supply an explicit environment to opt in. */
  command?: Omit<CommandToolOptions, 'root'>;
};

/** Explicit assembly only; each returned Tool can instead be selected or replaced independently. */
export function createCodingTools(options: CodingToolsOptions): Tool[] {
  return [
    ...createTextTools({ ...options.text, root: options.root }),
    ...createSearchTools({ ...options.search, root: options.root }),
    ...(options.command ? [createCommandTool({ ...options.command, root: options.root })] : []),
  ];
}
