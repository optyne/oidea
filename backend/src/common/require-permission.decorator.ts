import { SetMetadata } from '@nestjs/common';

export const PERMISSION_METADATA_KEY = 'require_permission';

/**
 * 宣告此 endpoint 需要的工作空間權限 key。對應 {@link ROLE_PERMISSIONS}。
 *
 * 搭配 `PermissionsGuard`。Guard 會依下列順序找 workspaceId：
 * 1. `request.params.workspaceId`
 * 2. `request.query.workspaceId`
 * 3. `request.body.workspaceId`
 *
 * 找不到則回 400。
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_METADATA_KEY, permission);
