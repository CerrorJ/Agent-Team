export interface ActiveRun {
    controller: AbortController;
    ownerOpenId: string;
    cancelMode?: 'stop' | 'close';
}

export type AbortTaskOutcome =
    | 'stopped'
    | 'already_stopping'
    | 'not_found'
    | 'forbidden';

//activeRuns 当前运行的任务清单：sessionsId 找具体任务，ownerOpenId谁有操作权限
export const requestTaskAbort = (
    activeRuns: Map<string, ActiveRun>,
    sessionId: string,
    operatorOpenId: string,
): AbortTaskOutcome => {
    const active = activeRuns.get(sessionId);
    // 任务不存在
    if (!active) return 'not_found';
    // 操作者不匹配
    if (operatorOpenId !== active.ownerOpenId) return 'forbidden';
    // 已经取消
    if (active.controller.signal.aborted) return 'already_stopping';
    // cancelMode 分两种结束方式：卡片停止和命令/close
    active.cancelMode = 'stop';
    active.controller.abort();
    return 'stopped';
};
