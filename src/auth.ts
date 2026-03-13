import type { Logger } from 'jsr:@pons/sdk@^0.2';

export interface AuthProfile {
  id: string;
  providerId: string;
  type: 'api_key' | 'oauth';
  credential: string;
  failCount: number;
  cooldownUntil?: number;
  lastUsed?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_FAIL_COUNT = 3;

export class AuthProfileManager {
  private profiles = new Map<string, AuthProfile[]>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  addProfile(profile: AuthProfile): void {
    const existing = this.profiles.get(profile.providerId) ?? [];
    existing.push(profile);
    this.profiles.set(profile.providerId, existing);
  }

  getProfiles(providerId: string): AuthProfile[] {
    return this.profiles.get(providerId) ?? [];
  }

  getActiveProfile(providerId: string): AuthProfile | undefined {
    const profiles = this.profiles.get(providerId);
    if (!profiles?.length) return undefined;

    const now = Date.now();
    return profiles.find(p => {
      if (p.failCount >= MAX_FAIL_COUNT) return false;
      if (p.cooldownUntil && p.cooldownUntil > now) return false;
      return true;
    });
  }

  recordFailure(providerId: string, profileId: string): void {
    const profiles = this.profiles.get(providerId);
    const profile = profiles?.find(p => p.id === profileId);
    if (!profile) return;

    profile.failCount++;
    if (profile.failCount >= MAX_FAIL_COUNT) {
      profile.cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS;
      this.logger.warn({ profileId, providerId }, 'Auth profile entering cooldown');
    }
  }

  recordSuccess(providerId: string, profileId: string): void {
    const profiles = this.profiles.get(providerId);
    const profile = profiles?.find(p => p.id === profileId);
    if (!profile) return;

    profile.failCount = 0;
    profile.cooldownUntil = undefined;
    profile.lastUsed = Date.now();
  }
}
