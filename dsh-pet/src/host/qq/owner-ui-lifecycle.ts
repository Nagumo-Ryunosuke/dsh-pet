/** 等本机服务就绪后启动桌面助手；卸载期间完成的服务必须立即关闭。 */
export async function startOwnerUiBeforeHelper<T extends { close(): void }>(options: {
  startUi(): Promise<T>;
  disposed(): boolean;
  ready(ui: T): void;
  startHelper(): void;
  failed(): void;
}): Promise<void> {
  const reportFailure = (): void => {
    try {
      options.failed();
    } catch {
      /* 日志故障不能产生未处理的拒绝。 */
    }
  };
  const close = (ui: T): void => {
    try {
      ui.close();
    } catch {
      reportFailure();
    }
  };
  let ui: T;
  try {
    ui = await options.startUi();
  } catch {
    if (!options.disposed()) {
      reportFailure();
      try {
        options.startHelper();
      } catch {
        reportFailure();
      }
    }
    return;
  }
  if (options.disposed()) {
    close(ui);
    return;
  }
  try {
    options.ready(ui);
  } catch {
    close(ui);
    reportFailure();
    return;
  }
  try {
    options.startHelper();
  } catch {
    close(ui);
    reportFailure();
  }
}
