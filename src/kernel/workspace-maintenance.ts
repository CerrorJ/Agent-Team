import type { KernelRequest } from './protocol.js'
import type { WorkspaceStore } from './workspace-store.js'
import {
  createWorkspaceBackup,
  restoreWorkspaceBackup,
} from './workspace-backup.js'
import { inspectBackup } from './backup-validation.js'
import type { WorkspaceService } from './workspace-service.js'

type MaintenanceRequest = Extract<
  KernelRequest,
  {
    method:
      'workspace.backup' | 'workspace.backup.inspect' | 'workspace.restore'
  }
>

export const isMaintenanceRequest = (
  request: KernelRequest,
): request is MaintenanceRequest =>
  request.method === 'workspace.backup' ||
  request.method === 'workspace.backup.inspect' ||
  request.method === 'workspace.restore'

/** 只提供工作台备份用例；路径由可信宿主系统选择器传入，不给渲染层任意读写文件接口。 */
export class WorkspaceMaintenance {
  requiresRestart = false
  constructor(
    private readonly options: {
      store: WorkspaceStore
      service: WorkspaceService
      dataDirectory: string
      sourceCommit: string
    },
  ) {}

  dispatch(request: MaintenanceRequest): unknown {
    if (this.requiresRestart) throw new Error('BACKUP_RESTART_REQUIRED')
    const { store, service, dataDirectory, sourceCommit } = this.options
    switch (request.method) {
      case 'workspace.backup':
        return createWorkspaceBackup({
          store,
          dataDirectory,
          sourceCommit,
          targetDirectory: request.targetDirectory,
          backupId: request.backupId,
        })
      case 'workspace.backup.inspect': {
        const { manifest, snapshot } = inspectBackup(request.backupDirectory)
        return {
          manifest,
          projects: snapshot.projects.length,
          tasks: snapshot.tasks.length,
          skills: snapshot.skills.length,
        }
      }
      case 'workspace.restore': {
        const outcome = restoreWorkspaceBackup({
          store,
          dataDirectory,
          backupDirectory: request.backupDirectory,
          targetDirectory: request.targetDirectory,
        })

        // 飞书也经过同一service，准备恢复后不能绕过桌面门控继续提交业务。
        service.freezeForRestore()
        this.requiresRestart = true
        return outcome
      }
    }
  }
}
