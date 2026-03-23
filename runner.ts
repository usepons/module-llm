/**
 * LLM Module — kernel process.
 *
 * Provides providerRegistry, authProfileManager, model-router,
 * and cost-tracker services via RPC.
 */

import { ModuleRunner } from 'jsr:@pons/sdk@^0.3';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.3';
import { ProviderRegistry } from './src/registry.ts';
import { AuthProfileManager } from './src/auth.ts';
import { ModelRouter } from './src/router.ts';
import type { ModelRouterConfig } from './src/router.ts';
import { CostTracker } from './src/cost-tracker.ts';
import type { LLMProvider, ProviderConfig, Message } from './src/providers/types.ts';

/** Local config shape — only what this module reads. */
interface LLMModuleConfig {
  models?: {
    providers?: Record<string, ProviderConfig & { url?: string }>;
    authProfiles?: Record<string, Array<{ id: string; credential: string; type?: 'api_key' | 'oauth' }>>;
    routing?: ModelRouterConfig;
    planning?: { provider: string; model: string };
  };
  limits?: {
    global?: { dailyCostLimit?: number; monthlyCostLimit?: number };
  };
}

const DEFAULT_DAILY_COST_LIMIT = 50;
const DEFAULT_MONTHLY_COST_LIMIT = 500;
const USAGE_EVENT_DEBOUNCE_MS = 1000;
const STANDARD_DEFAULTS: Record<string, { defaultBaseUrl?: string }> = {
  deepseek: { defaultBaseUrl: 'https://api.deepseek.com/v1' },
};

/** Provider IDs that use non-standard config and are handled separately. */
const CUSTOM_INIT_PROVIDERS = new Set(['ollama', 'azure-openai']);

class LLMRunner extends ModuleRunner {
  readonly manifest: ModuleManifest = {
    id: 'llm',
    name: 'LLM Services',
    version: '0.3.1',
    description: 'Provider registry, model routing, auth profiles, and cost tracking',
    provides: ['llm', 'providerRegistry', 'authProfileManager', 'model-router', 'cost-tracker'],
    subscribes: ['llm:generate', 'llm:stream:request'],
    priority: 5,
  };

  private providerRegistry!: ProviderRegistry;
  private authProfileManager!: AuthProfileManager;
  private modelRouter?: ModelRouter;
  private costTracker?: CostTracker;
  private usageEventTimer?: ReturnType<typeof setTimeout>;

  protected override async onInit(): Promise<void> {
    const config = this.config as LLMModuleConfig;
    const logger = this.createLoggerAdapter();

    // ── Provider Registry
    const providerRegistry = new ProviderRegistry(logger);
    const configProviders = config.models?.providers;
    const registeredItems: Array<{ msg: string }> = [];

    if (configProviders) {
      for (const [id, entry] of Object.entries(configProviders)) {
        const baseUrl = entry.baseUrl || entry.url;

        if (id === 'ollama' && baseUrl) {
          providerRegistry.register('ollama', { apiKey: entry.apiKey || 'ollama', baseUrl });
          registeredItems.push({ msg: `ollama (config)` });
          continue;
        }

        if (id === 'azure-openai') {
          const azureEntry = entry as ProviderConfig & { url?: string; endpoint?: string; apiVersion?: string; deployment?: string };
          const endpoint = azureEntry.endpoint || baseUrl;
          if ((azureEntry.apiKey || azureEntry.token) && endpoint) {
            providerRegistry.register('azure-openai', {
              apiKey: azureEntry.apiKey || azureEntry.token,
              endpoint,
              apiVersion: azureEntry.apiVersion,
              deployment: azureEntry.deployment,
            } as ProviderConfig);
            registeredItems.push({ msg: `azure-openai (config)` });
          }
          continue;
        }

        if (entry.apiKey || entry.token) {
          const defaults = STANDARD_DEFAULTS[id];
          const resolvedBaseUrl = baseUrl || defaults?.defaultBaseUrl;
          providerRegistry.register(id, {
            apiKey: entry.apiKey || entry.token,
            ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
          });
          registeredItems.push({ msg: `${id} (config)` });
        }
      }
    }

    this.providerRegistry = providerRegistry;

    // ── Dynamic net permission requests for provider URLs not in manifest
    await this.requestNetPermissionsForProviders(configProviders);

    // ── Auth Profile Manager
    const authProfileManager = new AuthProfileManager(logger);
    const authProfilesConfig = config.models?.authProfiles;

    if (authProfilesConfig) {
      for (const [providerId, profiles] of Object.entries(authProfilesConfig)) {
        for (const profile of profiles) {
          if (!profile.credential || profile.credential.startsWith('${')) continue;
          authProfileManager.addProfile({
            id: profile.id,
            providerId,
            type: (profile.type as 'api_key' | 'oauth') || 'api_key',
            credential: profile.credential,
            failCount: 0,
          });
        }
      }
    }

    this.authProfileManager = authProfileManager;
    this.logGroup('info', 'LLM providers registered', { count: registeredItems.length }, registeredItems);

    // ── Model Router
    if (config.models?.routing) {
      const routingConfig = config.models.routing;
      this.modelRouter = new ModelRouter(routingConfig, logger);

      const classifierProviderId = routingConfig.classifierProvider || 'anthropic';
      const classifierProvider = this.providerRegistry.get(classifierProviderId);

      if (classifierProvider) {
        this.modelRouter.setClassifier(classifierProvider);
        this.log('info', `Model router initialised with classifier: ${classifierProviderId}`, {
          model: routingConfig.classifierModel,
        });
      } else {
        this.log('warn', `Classifier provider ${classifierProviderId} not available — heuristics only`);
      }
    } else {
      this.log('info', 'Model routing not configured — inactive');
    }

    // ── Cost Tracker
    this.costTracker = new CostTracker(
      config.limits?.global?.dailyCostLimit || DEFAULT_DAILY_COST_LIMIT,
      config.limits?.global?.monthlyCostLimit || DEFAULT_MONTHLY_COST_LIMIT,
    );
    this.costTracker.setPersistence(this.workspacePath);

    this.costTracker.setOnChange(() => {
      if (this.usageEventTimer) return;
      this.usageEventTimer = setTimeout(() => {
        this.usageEventTimer = undefined;
        if (!this.costTracker) return;
        const limits = this.costTracker.getLimits();
        this.publish('usage:updated', {
          dailySpend: this.costTracker.getDailySpend(),
          monthlySpend: this.costTracker.getMonthlySpend(),
          dailyLimit: limits.daily,
          monthlyLimit: limits.monthly,
          totalTokens: this.costTracker.getSummary().totalTokens,
          entries: this.costTracker.getSummary().entries,
        });
      }, USAGE_EVENT_DEBOUNCE_MS);
    });

    await this.costTracker.load();
    this.log('info', 'Cost tracker initialized');
  }

  protected override async onDepsReady(): Promise<void> {
    try {
      await this.request('http-router', 'registerRoutes', {
        service: 'providerRegistry',
        prefix: '/api/models',
        middleware: ['auth'],
        routes: [
          { method: 'GET', path: '/', handler: 'listModels' },
          { method: 'GET', path: '/:provider', handler: 'listModelsByProvider' },
        ],
      });

      await this.request('http-router', 'registerRoutes', {
        service: 'providerRegistry',
        prefix: '/api/providers',
        middleware: ['auth'],
        routes: [
          { method: 'GET', path: '/health', handler: 'getProviderHealth' },
        ],
      });

      await this.request('http-router', 'registerRoutes', {
        service: 'cost-tracker',
        prefix: '/api/usage',
        middleware: ['auth'],
        routes: [
          { method: 'GET', path: '/', handler: 'getSummary' },
          { method: 'GET', path: '/:agentId', handler: 'getByAgent' },
        ],
      });

      this.log('info', 'HTTP routes registered');
    } catch {
      this.log('warn', 'http-router not available — HTTP routes not registered');
    }
  }

  protected override async onRequest(method: string, params: unknown): Promise<unknown> {
    // Gateway sends HTTP-originated calls as "http:<handler>" — strip prefix
    const resolvedMethod = method.startsWith('http:') ? method.slice(5) : method;

    // For HTTP-originated calls, extract params from the request context
    let resolvedParams = params;
    if (method.startsWith('http:') && params && typeof params === 'object') {
      const ctx = params as { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
      // Merge URL params into a flat object for the handler
      resolvedParams = { ...ctx.params, ...ctx.query, ...(ctx.body && typeof ctx.body === 'object' ? ctx.body as Record<string, unknown> : {}) };
    }

    switch (resolvedMethod) {
      case 'listProviders':
        return this.providerRegistry.listProviders();

      case 'listModels':
      case 'listModelsByProvider': {
        const p = resolvedParams as { provider?: string } | undefined;
        if (p?.provider) {
          const providerModels = await this.providerRegistry.listModels(p.provider);
          return { models: providerModels.map((m) => m.id) };
        }
        const providers = this.providerRegistry.listProviders();
        const allModels = await this.providerRegistry.listAllModels();
        const grouped: Record<string, string[]> = {};
        for (const m of allModels) {
          if (!grouped[m.provider]) grouped[m.provider] = [];
          grouped[m.provider].push(m.id);
        }
        return { providers, models: grouped };
      }

      case 'getProviderHealth': {
        const allProviders = this.providerRegistry.listProviders();
        const profiles = allProviders.flatMap((providerId) => {
          const providerProfiles = this.authProfileManager.getProfiles(providerId);
          return providerProfiles.map((p) => {
            const now = Date.now();
            let status: 'healthy' | 'cooldown' | 'failed' = 'healthy';
            if (p.cooldownUntil && p.cooldownUntil > now) status = 'cooldown';
            else if (p.failCount >= 3) status = 'failed';
            return { id: p.id, providerId: p.providerId, status, cooldownUntil: p.cooldownUntil, failCount: p.failCount, lastUsed: p.lastUsed };
          });
        });
        return { profiles, providers: allProviders };
      }

      case 'generateTitle': {
        const { userMessage, provider: providerId, model } = params as { userMessage: string; provider?: string; model?: string };
        const pId = providerId || this.providerRegistry.listProviders()[0];
        const titleProvider: LLMProvider | undefined = pId ? this.providerRegistry.get(pId) : undefined;
        if (!titleProvider) throw new Error('No provider available for title generation');

        const result = await titleProvider.generateText({
          model: model || '',
          system: 'Generate a short, concise title (max 8 words) that captures the intent of the user message. Return ONLY the title text, nothing else.',
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 30,
          temperature: 0.3,
        });
        return result.content.replace(/^["']|["']$/g, '').replace(/\.$/, '').trim();
      }

      case 'getProvider': {
        const { providerId } = params as { providerId: string };
        return !!this.providerRegistry.get(providerId);
      }

      case 'getAuthProfiles': {
        const { providerId } = params as { providerId: string };
        return this.authProfileManager.getProfiles(providerId);
      }

      case 'route': {
        if (!this.modelRouter) throw new Error('Model router not configured');
        const p = params as { userMessage: string; systemPrompt: string | unknown[]; toolDefinitions: unknown[]; requestedToolName?: string };
        return this.modelRouter.route(p.userMessage, p.systemPrompt, p.toolDefinitions, p.requestedToolName);
      }

      case 'classifyHeuristic': {
        if (!this.modelRouter) throw new Error('Model router not configured');
        const p = params as { userMessage: string; toolDefinitions: unknown[] };
        return this.modelRouter.classifyHeuristic(p.userMessage, p.toolDefinitions);
      }

      case 'getRule': {
        if (!this.modelRouter) throw new Error('Model router not configured');
        const p = params as { tier: string };
        return this.modelRouter.getRule(p.tier as 'simple' | 'medium' | 'complex') ?? null;
      }

      case 'getToolOverride': {
        if (!this.modelRouter) throw new Error('Model router not configured');
        const p = params as { toolName: string };
        return this.modelRouter.getToolOverride(p.toolName) ?? null;
      }

      case 'getSummary': {
        if (!this.costTracker) throw new Error('Cost tracker not initialized');
        const summary = this.costTracker.getSummary();
        const limits = this.costTracker.getLimits();
        return {
          summary,
          daily: { spend: this.costTracker.getDailySpend(), limit: limits.daily, withinLimit: this.costTracker.isWithinDailyLimit() },
          monthly: { spend: this.costTracker.getMonthlySpend(), limit: limits.monthly, withinLimit: this.costTracker.isWithinMonthlyLimit() },
        };
      }

      case 'getByAgent': {
        if (!this.costTracker) throw new Error('Cost tracker not initialized');
        const { agentId } = resolvedParams as { agentId: string };
        return { agentId, daily: this.costTracker.getDailySpendByAgent(agentId), monthly: this.costTracker.getMonthlySpendByAgent(agentId) };
      }

      case 'trackUsage': {
        if (!this.costTracker) throw new Error('Cost tracker not initialized');
        const { model, provider, promptTokens, completionTokens, totalTokens, agentId } = params as {
          model: string; provider: string; promptTokens: number; completionTokens: number; totalTokens?: number; agentId?: string;
        };
        const entry = this.costTracker.track(
          { promptTokens, completionTokens, totalTokens: totalTokens ?? (promptTokens + completionTokens) },
          model, provider, agentId,
        );
        return { ok: true, totalCost: entry.totalCost };
      }

      case 'generateText': {
        const p = params as { provider: string; model: string; messages: Message[]; system?: string; maxTokens?: number; temperature?: number; tools?: unknown[]; agentId?: string };
        const provider = this.providerRegistry.get(p.provider);
        if (!provider) throw new Error(`Provider "${p.provider}" not found`);

        // Security: enforce cost limits before making LLM request
        if (this.costTracker && !this.costTracker.isWithinDailyLimit()) {
          throw new Error('Daily cost limit exceeded');
        }
        if (this.costTracker && !this.costTracker.isWithinMonthlyLimit()) {
          throw new Error('Monthly cost limit exceeded');
        }

        const result = await provider.generateText({
          model: p.model,
          messages: p.messages,
          system: p.system,
          maxTokens: p.maxTokens,
          temperature: p.temperature,
          tools: p.tools as Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
        });

        // Auto-track usage if cost tracker is active
        if (this.costTracker && result.usage) {
          this.costTracker.track(result.usage, p.model, p.provider, p.agentId);
        }

        return result;
      }

      case 'streamText': {
        // IPC cannot stream — collect all chunks and return aggregated result
        const p = params as { provider: string; model: string; messages: Message[]; system?: string; maxTokens?: number; temperature?: number; tools?: unknown[]; agentId?: string };
        const provider = this.providerRegistry.get(p.provider);
        if (!provider) throw new Error(`Provider "${p.provider}" not found`);

        // Security: enforce cost limits before making LLM request
        if (this.costTracker && !this.costTracker.isWithinDailyLimit()) {
          throw new Error('Daily cost limit exceeded');
        }
        if (this.costTracker && !this.costTracker.isWithinMonthlyLimit()) {
          throw new Error('Monthly cost limit exceeded');
        }

        let text = '';
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        for await (const chunk of provider.streamText({
          model: p.model,
          messages: p.messages,
          system: p.system,
          maxTokens: p.maxTokens,
          temperature: p.temperature,
          tools: p.tools as Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
        })) {
          if (chunk.type === 'text' && chunk.text) text += chunk.text;
          if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
        }

        if (this.costTracker && usage.totalTokens > 0) {
          this.costTracker.track(usage, p.model, p.provider, p.agentId);
        }

        return { content: text, usage, model: p.model };
      }

      case 'embed': {
        const p = params as { text: string | string[]; provider?: string; model?: string };
        const texts = Array.isArray(p.text) ? p.text : [p.text];
        const providerName = p.provider ?? this.providerRegistry.listProviders()[0];
        if (!providerName) throw new Error('No provider available for embeddings');
        const provider = this.providerRegistry.get(providerName);
        if (!provider) throw new Error(`Provider "${providerName}" not found`);
        // Embeddings are not yet implemented in provider — return stub error response
        throw new Error(`Embeddings not yet implemented for provider "${providerName}"`);
      }

      case 'health':
        return {
          status: 'ok',
          providers: this.providerRegistry.listProviders(),
          modelRouter: this.modelRouter ? { active: true } : { active: false },
          costTracker: this.costTracker ? { dailySpend: this.costTracker.getDailySpend(), monthlySpend: this.costTracker.getMonthlySpend() } : undefined,
        };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  protected override async onMessage(topic: string, payload: unknown): Promise<void> {
    // Handle bus messages from other modules
    if (topic === 'llm:generate') {
      const p = payload as { provider: string; model: string; messages: Message[]; system?: string; maxTokens?: number; temperature?: number; replyTopic?: string; agentId?: string };
      try {
        const result = await this.onRequest('generateText', p);
        if (p.replyTopic) {
          this.publish(p.replyTopic, { ok: true, result });
        }
      } catch (err) {
        if (p.replyTopic) {
          this.publish(p.replyTopic, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (topic === 'llm:stream:request') {
      const p = payload as {
        requestId: string;
        provider: string;
        model: string;
        messages: Message[];
        system?: string;
        maxTokens?: number;
        temperature?: number;
        tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        agentId?: string;
      };
      this.log('debug', 'Stream request received', {
        requestId: p.requestId,
        provider: p.provider,
        model: p.model,
        messagesCount: p.messages?.length ?? 0,
        toolsCount: p.tools?.length ?? 0,
        agentId: p.agentId,
        hasSystem: !!p.system,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
      });
      this.handleStreamRequest(p).catch(err => {
        this.publish('llm:stream:chunk', {
          requestId: p.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async handleStreamRequest(params: {
    requestId: string;
    provider: string;
    model: string;
    messages: Message[];
    system?: string;
    maxTokens?: number;
    temperature?: number;
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    agentId?: string;
  }): Promise<void> {
    const provider = this.providerRegistry.get(params.provider);
    if (!provider) {
      this.log('warn', `Provider "${params.provider}" not found`, {
        requestId: params.requestId,
        available: this.providerRegistry.listProviders(),
      });
      this.publish('llm:stream:chunk', {
        requestId: params.requestId,
        type: 'error',
        error: `Provider "${params.provider}" not found. Available: ${this.providerRegistry.listProviders().join(', ')}`,
      });
      return;
    }

    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for await (const chunk of provider.streamText({
        model: params.model,
        messages: params.messages,
        system: params.system,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        tools: params.tools,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          this.publish('llm:stream:chunk', {
            requestId: params.requestId,
            type: 'delta',
            content: chunk.text,
          });
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          this.publish('llm:stream:chunk', {
            requestId: params.requestId,
            type: 'tool_call',
            toolCall: chunk.toolCall,
          });
        } else if (chunk.type === 'usage' && chunk.usage) {
          usage = chunk.usage;
        }
      }
    } catch (err) {
      this.publish('llm:stream:chunk', {
        requestId: params.requestId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (this.costTracker && usage.totalTokens > 0) {
      this.costTracker.track(usage, params.model, params.provider, params.agentId);
    }

    this.publish('llm:stream:chunk', {
      requestId: params.requestId,
      type: 'done',
      usage,
    });
  }

  /**
   * Check provider URLs against current net permissions.
   * If any configured provider points to a host not in the manifest's
   * net permissions, request dynamic permission from the kernel.
   * The kernel will queue the request and restart this module after approval.
   */
  private async requestNetPermissionsForProviders(
    configProviders?: Record<string, ProviderConfig & { url?: string }>,
  ): Promise<void> {
    if (!configProviders) return;

    const declaredHosts = new Set(this.manifest.permissions?.net ?? []);
    const missingHosts: string[] = [];

    for (const entry of Object.values(configProviders)) {
      const rawUrl = entry.baseUrl || entry.url;
      if (!rawUrl) continue;
      try {
        const hostname = new URL(rawUrl).hostname;
        // Check if any declared pattern matches this hostname
        const covered = [...declaredHosts].some(pattern => {
          if (pattern === hostname) return true;
          // Simple wildcard: *.example.com matches sub.example.com
          if (pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1))) return true;
          return false;
        });
        if (!covered) missingHosts.push(hostname);
      } catch {
        // invalid URL — skip
      }
    }

    if (missingHosts.length === 0) return;

    const unique = [...new Set(missingHosts)];
    this.log('info', `Requesting net permissions for provider hosts: ${unique.join(', ')}`);

    const result = await this.requestPermissions(
      { net: unique },
      `LLM providers require network access to: ${unique.join(', ')}`,
    );

    if (result.pending) {
      this.log('warn', `Net permissions pending approval for: ${unique.join(', ')} — approve via CLI or UI`);
    }
  }

  protected override async onShutdown(): Promise<void> {
    if (this.usageEventTimer) clearTimeout(this.usageEventTimer);
    if (this.costTracker) await this.costTracker.save();
    this.log('info', 'LLM services stopped');
  }
}

new LLMRunner().start();
