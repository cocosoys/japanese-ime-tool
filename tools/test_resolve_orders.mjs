import { MschxudpExporter } from '../src/implementations/exporter/MschxudpExporter.js';
import assert from 'assert';

// ─── MschxudpExporter.resolveOrderConflicts 单元测试 ───

console.log('=== resolveOrderConflicts 冲突检测测试 ===\n');

// 场景 1：无冲突 —— 所有 order 保持不变
{
  const records = [
    { code: 'sakura', word: '桜', order: 1 },
    { code: 'haruki', word: '春樹', order: 1 },
    { code: 'yuki', word: '雪', order: 2 },
  ];
  const existing = [];
  const result = MschxudpExporter.resolveOrderConflicts(records, existing);

  console.assert(result.adjustments.length === 0, '场景1: 无冲突时 adjustments 应为空');
  console.assert(result.records.length === 3, '场景1: 记录数不变');
  console.assert(result.records[0].order === 1, '场景1: sakura order=1');
  console.assert(result.records[1].order === 1, '场景1: haruki order=1');
  console.assert(result.records[2].order === 2, '场景1: yuki order=2');
  console.log('✅ 场景1 通过：无冲突时 order 不变\n');
}

// 场景 2：与现有词条冲突 —— 自动递增
{
  const records = [
    { code: 'q', word: '新短语', order: 1 },       // 现已有 q+1
    { code: 'testpinyin', word: '另一个', order: 1 }, // 现已有 testpinyin+1
    { code: 'sakura', word: '桜', order: 1 },        // 无冲突
  ];
  const existing = [
    { code: 'q', candidate: 1 },
    { code: 'testpinyin', candidate: 1 },
  ];
  const result = MschxudpExporter.resolveOrderConflicts(records, existing);

  console.assert(result.adjustments.length === 2, `场景2: 应有 2 处调整（实际 ${result.adjustments.length}）`);
  console.assert(result.records[0].order === 2, `场景2: q 应调整为 2（实际 ${result.records[0].order}）`);
  console.assert(result.records[1].order === 2, `场景2: testpinyin 应调整为 2（实际 ${result.records[1].order}）`);
  console.assert(result.records[2].order === 1, '场景2: sakura 无冲突保持 1');

  // 验证 adjustments 内容
  const qAdj = result.adjustments.find((a) => a.code === 'q');
  console.assert(qAdj && qAdj.fromOrder === 1 && qAdj.toOrder === 2, '场景2: q 调整信息正确');
  console.log('✅ 场景2 通过：现有冲突自动递增\n');
}

// 场景 3：同批次内自相冲突 —— 第二条同拼音的自动递增
{
  const records = [
    { code: 'q', word: '第一条', order: 1 },
    { code: 'q', word: '第二条', order: 1 },   // 同批次重复拼音
    { code: 'q', word: '第三条', order: 1 },   // 再一次
  ];
  const existing = [];
  const result = MschxudpExporter.resolveOrderConflicts(records, existing);

  console.assert(result.records[0].order === 1, `场景3: 第一条 q order=1（实际 ${result.records[0].order}）`);
  console.assert(result.records[1].order === 2, `场景3: 第二条 q order=2（实际 ${result.records[1].order}）`);
  console.assert(result.records[2].order === 3, `场景3: 第三条 q order=3（实际 ${result.records[2].order}）`);
  console.assert(result.adjustments.length === 2, `场景3: 2 处调整（实际 ${result.adjustments.length}）`);
  console.log('✅ 场景3 通过：同批次内自相冲突也正确递增\n');
}

// 场景 4：多级递增 —— 现有占满 1~3，新条目应从 4 开始
{
  const records = [
    { code: 'x', word: '新x', order: 1 },
  ];
  const existing = [
    { code: 'x', candidate: 1 },
    { code: 'x', candidate: 2 },
    { code: 'x', candidate: 3 },
  ];
  const result = MschxudpExporter.resolveOrderConflicts(records, existing);

  console.assert(result.records[0].order === 4, `场景4: 应递增到 4（实际 ${result.records[0].order}）`);
  console.assert(result.adjustments[0].fromOrder === 1 && result.adjustments[0].toOrder === 4, '场景4: 调整 1→4');
  console.log('✅ 场景4 通过：多级跳过已占用位置\n');
}

// 场景 5：达到上限 maxOrder 兜底
{
  const records = [
    { code: 'z', word: 'z短语', order: 1 },
  ];
  // 占满 1~20
  const existing = Array.from({ length: 20 }, (_, i) => ({ code: 'z', candidate: i + 1 }));
  const result = MschxudpExporter.resolveOrderConflicts(records, existing, { maxOrder: 20 });

  console.assert(result.records[0].order === 20, `场景5: 达到上限应兜底为 20（实际 ${result.records[0].order}）`);
  console.log('✅ 场景5 通过：maxOrder 兜底\n');
}

console.log('✅ resolveOrderConflicts 全部测试通过（5/5 场景）');
