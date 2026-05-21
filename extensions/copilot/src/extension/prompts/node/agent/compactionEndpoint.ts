/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestMetadata } from '@vscode/copilot-api';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ProxyAgenticEndpoint } from '../../../../platform/endpoint/node/proxyAgenticEndpoint';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint, IEndpointBody, IEndpointFetchOptions } from '../../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { ChatLocation } from '../../../../platform/chat/common/chatLocation';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { ITokenizerProvider } from '../../../../platform/tokenizer/node/tokenizer';
import { IDomainService } from '../../../../platform/endpoint/common/domainService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { IChatWebSocketManager } from '../../../../platform/networking/node/chatWebSocketManager';
import { IChatModelInformation } from '../../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../../platform/endpoint/node/chatEndpoint';

/** Default model name forwarded to the agentic proxy when `ConversationCompactionUseAgenticProxy` is set without an explicit `ConversationCompactionModel`. Registered on the copilot-proxy as `trajectory-compaction-v1` (routes to Fireworks deployment `accounts/msft/deployments/ihfptseo`). */
export const DEFAULT_COMPACTION_AGENTIC_PROXY_MODEL = 'trajectory-compaction-v1';

interface DirectEndpointConfig {
	url: string;
	model: string;
	maxTokens?: number;
	apiKey: string;
	temperature?: number;
	repetitionPenalty?: number;
}

/**
 * Direct compaction endpoint that bypasses the copilot proxy and calls an
 * external OpenAI-compatible API (e.g. Fireworks) directly. Used for msbench
 * testing when the proxy change hasn't been deployed yet.
 */
class DirectCompactionEndpoint extends ChatEndpoint {
	private readonly _directUrl: string;
	private readonly _directApiKey: string;
	private readonly _directModel: string;
	private readonly _temperature: number;
	private readonly _repetitionPenalty: number;

	constructor(
		config: DirectEndpointConfig,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService,
	) {
		const modelInfo: IChatModelInformation = {
			id: config.model,
			name: config.model,
			vendor: 'direct',
			version: 'unknown',
			model_picker_enabled: false,
			is_chat_default: false,
			is_chat_fallback: false,
			capabilities: {
				type: 'chat',
				family: config.model,
				tokenizer: TokenizerType.O200K,
				supports: { streaming: false, parallel_tool_calls: true, tool_calls: true, vision: false },
				limits: {
					max_prompt_tokens: 250000,
					max_output_tokens: config.maxTokens ?? 8192,
				}
			}
		};
		super(
			modelInfo,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentationService,
			chatWebSocketService,
			logService
		);
		this._directUrl = config.url;
		this._directApiKey = config.apiKey;
		this._directModel = config.model;
		this._temperature = config.temperature ?? 0;
		this._repetitionPenalty = config.repetitionPenalty ?? 1.1;
	}

	override get urlOrRequestMetadata(): string | RequestMetadata {
		return this._directUrl;
	}

	override getExtraHeaders(_location?: ChatLocation): Record<string, string> {
		return {
			'Authorization': `Bearer ${this._directApiKey}`,
			'Content-Type': 'application/json',
		};
	}

	override getEndpointFetchOptions(): IEndpointFetchOptions {
		return { suppressIntegrationId: true };
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		if (body) {
			body.model = this._directModel;
			body.stream = false;
			body.temperature = this._temperature;
			(body as Record<string, unknown>)['repetition_penalty'] = this._repetitionPenalty;
			(body as Record<string, unknown>)['chat_template_kwargs'] = { enable_thinking: false };
			(body as Record<string, unknown>)['reasoning_effort'] = 'none';
		}
	}

	public override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const config: DirectEndpointConfig = {
			url: this._directUrl,
			model: this._directModel,
			maxTokens: this._directModel ? 8192 : 8192,
			apiKey: this._directApiKey,
		};
		return this._instantiationService.createInstance(DirectCompactionEndpoint, config);
	}
}

/**
 * Resolve the endpoint to use for trajectory (conversation-history) compaction
 * requests. Mirrors `SearchSubagentToolCallingLoop.getEndpoint()`:
 *
 *   - When `ConversationCompactionDirectEndpoint` is set (JSON string), a
 *     `DirectCompactionEndpoint` is created that calls the external API
 *     directly — bypassing the Copilot proxy. Used for msbench testing.
 *   - When `ConversationCompactionUseAgenticProxy` is enabled, the configured
 *     model (or `DEFAULT_COMPACTION_AGENTIC_PROXY_MODEL`) is wrapped in a
 *     `ProxyAgenticEndpoint` so the request is routed through the Copilot
 *     agentic proxy (which in turn fans out to providers like Fireworks).
 *   - When only `ConversationCompactionModel` is set, the endpoint provider is
 *     asked for that model directly. Any failure falls back to `mainEndpoint`
 *     so a misconfigured experiment never aborts the agent loop.
 *   - With neither configured, `mainEndpoint` is returned unchanged — i.e. the
 *     pre-existing behaviour of using the main agent model for compaction.
 *
 * The caller decides whether to apply provider-specific message/tool
 * adjustments (e.g. re-normalising tool schemas against the returned
 * endpoint's family).
 */
export async function resolveCompactionEndpoint(
	mainEndpoint: IChatEndpoint,
	instantiationService: IInstantiationService,
	configurationService: IConfigurationService,
	experimentationService: IExperimentationService,
	endpointProvider: IEndpointProvider,
	logService: ILogService,
): Promise<IChatEndpoint> {
	// Hardcoded Fireworks direct endpoint for testing custom compaction model
	const hardcodedConfig: DirectEndpointConfig = {
		url: 'https://api.fireworks.ai/inference/v1/chat/completions',
		model: 'accounts/msft/deployments/ihfptseo',
		apiKey: 'fw_TEkpdC6pCejMpoqHD5XECM',
		temperature: 0,
		repetitionPenalty: 1.1,
	};
	logService.info(`[compaction] Using hardcoded Fireworks endpoint: ${hardcodedConfig.url} model=${hardcodedConfig.model}`);
	return instantiationService.createInstance(DirectCompactionEndpoint, hardcodedConfig);

	// Check for direct endpoint first (msbench / pre-proxy-deployment testing)
	const directEndpointJson = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ConversationCompactionDirectEndpoint, experimentationService);
	if (directEndpointJson) {
		try {
			const config = JSON.parse(directEndpointJson) as DirectEndpointConfig;
			if (config.url && config.model && config.apiKey) {
				logService.info(`[compaction] Using direct endpoint: ${config.url} model=${config.model}`);
				return instantiationService.createInstance(DirectCompactionEndpoint, config);
			}
		} catch (error) {
			logService.warn(`[compaction] Failed to parse directEndpoint JSON, falling back: ${error}`);
		}
	}

	const modelName = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ConversationCompactionModel, experimentationService);
	const useAgenticProxy = configurationService.getExperimentBasedConfig(ConfigKey.Advanced.ConversationCompactionUseAgenticProxy, experimentationService);

	if (useAgenticProxy) {
		const agenticProxyModel = modelName || DEFAULT_COMPACTION_AGENTIC_PROXY_MODEL;
		return instantiationService.createInstance(ProxyAgenticEndpoint, agenticProxyModel, undefined);
	}

	if (modelName) {
		try {
			return await endpointProvider.getChatEndpoint(modelName as ChatEndpointFamily);
		} catch (error) {
			logService.warn(`[compaction] Failed to get model ${modelName}, falling back to main agent endpoint: ${error}`);
			return mainEndpoint;
		}
	}

	return mainEndpoint;
}
