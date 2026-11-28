// 状态容器：内存态 + 可选 JSON 文件持久化（与合作方服务同一写法）。
// 单进程内所有写操作在 transact 同步临界区中完成，保证认捐等核算不会交错。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSeed } from './seed.mjs';

export function createStore({ stateFile = null, fixtures } = {}) {
  let state;
  if (stateFile) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = buildSeed(fixtures);
    }
  } else {
    state = buildSeed(fixtures);
  }

  const save = () => {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile + '.tmp', JSON.stringify(state));
    renameSync(stateFile + '.tmp', stateFile);
  };

  return {
    state,
    now: () => new Date().toISOString(),
    id(prefix) {
      state.seq += 1;
      return `${prefix}-${state.seq}`;
    },
    audit(actor, action, entityType, entityId, detail = {}) {
      state.audit.push({
        at: new Date().toISOString(),
        actor: actor?.id ?? 'system',
        role: actor?.role ?? 'system',
        action,
        entityType,
        entityId,
        detail
      });
    },
    // 同步临界区：业务校验与写入在同一事件循环节拍内完成，并发请求不会交错。
    transact(fn) {
      const result = fn();
      save();
      return result;
    }
  };
}
