import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 手动绑定：编码来自 lockedBindings[index]，为空则留空（由用户在 UI 填）
export class ManualBinding extends BindingStrategy {
  constructor(locked = {}) { super(); this.locked = locked; }
  get name() { return 'manual'; }
  generate(entry, index) { return this.locked[index] ?? ''; }
}
