/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BasePromptElementProps, PromptElement, Raw } from '@vscode/prompt-tsx';
import { CustomDataPartMimeTypes } from './endpointTypes';

interface IAnthropicCompactionDataOpaque {
	type: typeof CustomDataPartMimeTypes.AnthropicCompaction;
	summary: string;
}

export interface IAnthropicCompactionDataContainerProps extends BasePromptElementProps {
	summary: string;
}

/**
 * Helper element to embed Anthropic compact_20260112 compaction summaries into
 * assistant messages as an opaque content part, for round-tripping in Messages API requests.
 */
export class AnthropicCompactionDataContainer extends PromptElement<IAnthropicCompactionDataContainerProps> {
	render() {
		const { summary } = this.props;
		const container: IAnthropicCompactionDataOpaque = { type: CustomDataPartMimeTypes.AnthropicCompaction, summary };
		return <opaque value={container} />;
	}
}

/**
 * Attempts to parse a Raw opaque content part into an Anthropic compaction summary, if the type matches.
 */
export function rawPartAsAnthropicCompactionData(part: Raw.ChatCompletionContentPartOpaque): string | undefined {
	const value = part.value as unknown;
	if (!value || typeof value !== 'object') {
		return;
	}

	const data = value as IAnthropicCompactionDataOpaque;
	if (data.type === CustomDataPartMimeTypes.AnthropicCompaction && typeof data.summary === 'string') {
		return data.summary;
	}
	return;
}
