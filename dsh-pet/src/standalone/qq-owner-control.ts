import type { QqAccountObservation, QqOwnerBindingService } from '@deepseek-pet/soul';

/** 仅供独立模式受保护设置服务注入；观察器必须来自可信驱动，绝不能取自 HTTP 输入。 */
export interface QqOwnerControl {
  status(petId: string): { available: boolean; accountId?: string; configured: boolean; clearable: boolean };
  configure(petId: string, ownerId: string, expectedAccountId: string): void;
  clear(petId: string): void;
}

/** 服务器早于宿主启动；未接上或卸载后默认不可配置。 */
export function createQqOwnerControlSlot(): {
  readonly control: QqOwnerControl;
  set(control: QqOwnerControl | null): void;
} {
  let current: QqOwnerControl | null = null;
  return {
    set(control) {
      current = control;
    },
    control: {
      status: (petId) => current?.status(petId) ?? { available: false, configured: false, clearable: false },
      configure: (petId, ownerId, expectedAccountId) => {
        if (current === null) throw new Error('qq-owner-unavailable');
        current.configure(petId, ownerId, expectedAccountId);
      },
      clear: (petId) => {
        if (current === null) throw new Error('qq-owner-unavailable');
        current.clear(petId);
      },
    },
  };
}

/** 生产缺少可信观察器时不应构造此控制器。此函数不启动 QQ 渠道或发送消息。 */
export function createQqOwnerControl(
  binding: Pick<QqOwnerBindingService, 'state' | 'configure' | 'clear'>,
  observe: (petId: string) => QqAccountObservation,
  isKnownPet: (petId: string) => boolean,
): QqOwnerControl {
  const status = (
    petId: string,
  ): { available: boolean; accountId?: string; configured: boolean; clearable: boolean } => {
    if (!isKnownPet(petId)) throw new Error('unknown-pet');
    const observation = observe(petId);
    const saved = binding.state(petId).binding;
    if (observation.state !== 'authenticated' || !/^[1-9][0-9]{0,19}$/.test(observation.accountId ?? '')) {
      // 离线时无法确定当前账号，不能将其他账号的绑定显示为当前配置。
      return { available: false, configured: false, clearable: saved !== null };
    }
    return {
      available: true,
      accountId: observation.accountId,
      configured: saved?.accountId === observation.accountId,
      clearable: saved !== null,
    };
  };
  return {
    status,
    configure(petId, ownerId, expectedAccountId) {
      const current = status(petId);
      if (!current.available || current.accountId !== expectedAccountId) throw new Error('account-not-ready');
      binding.configure(petId, ownerId, expectedAccountId);
    },
    clear(petId) {
      if (!isKnownPet(petId)) throw new Error('unknown-pet');
      binding.clear(petId);
    },
  };
}
