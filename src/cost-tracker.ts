import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-opus': { input: 15, output: 75 },
  'claude-sonnet': { input: 3, output: 15 },
  'claude-haiku': { input: 0.25, output: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4': { input: 30, output: 60 },
  'deepseek': { input: 0.14, output: 0.28 },
  'default': { input: 1, output: 3 },
};

export interface UsageEntry {
  timestamp: number;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  agentId?: string;
}

export interface UsageSummary {
  totalTokens: number;
  totalCost: number;
  entries: number;
}

export class CostTracker {
  private dailyLimit: number;
  private monthlyLimit: number;
  private entries: UsageEntry[] = [];
  private persistPath?: string;
  private onChange?: () => void;

  constructor(dailyLimit: number, monthlyLimit: number) {
    this.dailyLimit = dailyLimit;
    this.monthlyLimit = monthlyLimit;
  }

  setPersistence(workspacePath: string): void {
    if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
    this.persistPath = join(workspacePath, 'usage.json');
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  async load(): Promise<void> {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      this.entries = JSON.parse(raw) as UsageEntry[];
      // Security: prune entries older than 90 days to prevent unbounded growth
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      this.entries = this.entries.filter(e => e.timestamp >= cutoff);
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    if (!this.persistPath) return;
    writeFileSync(this.persistPath, JSON.stringify(this.entries, null, 2));
  }

  track(
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    model: string,
    provider: string,
    agentId?: string,
  ): UsageEntry {
    const cost = this.estimateCost(model, usage.promptTokens, usage.completionTokens);
    const entry: UsageEntry = {
      timestamp: Date.now(),
      model,
      provider,
      ...usage,
      totalCost: cost,
      agentId,
    };
    this.entries.push(entry);
    // Security: cap entries to prevent unbounded memory growth
    if (this.entries.length > 100_000) {
      this.entries = this.entries.slice(-50_000);
    }
    this.onChange?.();
    return entry;
  }

  getSummary(): UsageSummary {
    return {
      totalTokens: this.entries.reduce((s, e) => s + e.totalTokens, 0),
      totalCost: this.entries.reduce((s, e) => s + e.totalCost, 0),
      entries: this.entries.length,
    };
  }

  getDailySpend(): number {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return this.entries
      .filter(e => e.timestamp >= dayStart.getTime())
      .reduce((s, e) => s + e.totalCost, 0);
  }

  getMonthlySpend(): number {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return this.entries
      .filter(e => e.timestamp >= monthStart.getTime())
      .reduce((s, e) => s + e.totalCost, 0);
  }

  getDailySpendByAgent(agentId: string): number {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return this.entries
      .filter(e => e.agentId === agentId && e.timestamp >= dayStart.getTime())
      .reduce((s, e) => s + e.totalCost, 0);
  }

  getMonthlySpendByAgent(agentId: string): number {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return this.entries
      .filter(e => e.agentId === agentId && e.timestamp >= monthStart.getTime())
      .reduce((s, e) => s + e.totalCost, 0);
  }

  isWithinDailyLimit(): boolean {
    return this.getDailySpend() < this.dailyLimit;
  }

  isWithinMonthlyLimit(): boolean {
    return this.getMonthlySpend() < this.monthlyLimit;
  }

  getLimits(): { daily: number; monthly: number } {
    return { daily: this.dailyLimit, monthly: this.monthlyLimit };
  }

  private estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const key = Object.keys(COST_PER_MILLION).find(k => model.toLowerCase().includes(k)) ?? 'default';
    const rates = COST_PER_MILLION[key];
    return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
  }
}
