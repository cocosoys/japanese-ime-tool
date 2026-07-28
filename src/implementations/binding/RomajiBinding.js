import { BindingStrategy } from '../../interfaces/BindingStrategy.js';

// 罗马音绑定：如 yuki / sakura。空时回退 name{index+1}
export class RomajiBinding extends BindingStrategy {
  get name() { return 'romaji'; }
  generate(entry, index) {
    const code = (entry.romaji || '').trim().toLowerCase().replace(/\s+/g, '');
    return code || `name${index + 1}`;
  }
}
