import type { ApprovalMode, Preferences } from '../shared/types.js';
import type { Store } from './store.js';

export class Settings {
  constructor(private store: Store, private defaultMode: ApprovalMode) {}
  get(): Preferences {
    return this.store.getState<Preferences>('preferences:ui:v1', { debugMode: false, defaultApprovalMode: this.defaultMode });
  }
  update(patch: Partial<Preferences>): Preferences {
    const next = { ...this.get(), ...patch };
    this.store.setState('preferences:ui:v1', next);
    return next;
  }
}
